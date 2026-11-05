import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getDefaultDataDir,
  loadJsonFile,
  resolveWebDataDir,
  saveJsonFile,
} from '../utils/web-data.util.js';

/**
 * MandatoryUpdateService - 强制更新策略服务：维护最低可用版本及更新阻断状态
 *
 * 与可选更新（tauri updater）互补：轮询远端版本清单，按"最低可用版本"语义阻断旧版使用。
 *
 * 策略约束：
 *   - 周期轮询 manifestUrl（失败指数退避 + 抖动，上限 maxBackoffMs）
 *   - 阻断决策一旦成立，传输/解析失败不会清除；只有一次全新的"无需强制"成功响应才解除
 *   - 并发检查合并为一次在途请求；手动检查绕过间隔但不绕过合并
 *   - 未配置 manifestUrl 时服务静默禁用（fail-safe，不影响现有更新通道）
 *
 * 清单格式（HTTPS JSON，服务端可控）：
 *   {
 *     "minVersion": "2.1.0",        // 低于此版本阻断（必需，其余可选）
 *     "latestVersion": "2.2.0",     // 仅展示
 *     "mandatory": true,            // 显式全员阻断开关
 *     "title": "需要更新",           // 遮罩标题（≤256 字）
 *     "detail": "……",               // 遮罩详情（≤16384 字）
 *     "downloadUrl": "https://..."  // 获取更新入口（https 或 127.0.0.1）
 *   }
 */

/** 本地持久化配置（dataDir/mandatory-update.json） */
export interface MandatoryUpdateConfig {
  /** 总开关（false 时完全不轮询、永不阻断） */
  enabled: boolean;
  /** 远端版本清单 URL（https） */
  manifestUrl: string;
  /** 轮询间隔（毫秒） */
  intervalMs: number;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
}

/** 远端版本清单（服务端下发） */
interface UpdateManifest {
  minVersion?: string;
  latestVersion?: string;
  mandatory?: boolean;
  title?: string;
  detail?: string;
  downloadUrl?: string;
}

/** 对外状态（前端遮罩数据源） */
export interface MandatoryUpdateState {
  /** 服务是否启用（未配置时 false） */
  enabled: boolean;
  /** 当前是否阻断使用 */
  blocking: boolean;
  /** 是否有检查在途 */
  checking: boolean;
  currentVersion: string;
  minVersion: string | null;
  latestVersion: string | null;
  title: string | null;
  detail: string | null;
  downloadUrl: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
}

/** 默认配置 */
const DEFAULT_CONFIG: MandatoryUpdateConfig = {
  enabled: false,
  manifestUrl: '',
  intervalMs: 600_000,
  timeoutMs: 15_000,
};

const MAX_BACKOFF_MS = 3_600_000;
const JITTER = 0.2;
const TITLE_MAX = 256;
const DETAIL_MAX = 16_384;

@Injectable()
export class MandatoryUpdateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MandatoryUpdateService.name);
  private config: MandatoryUpdateConfig = { ...DEFAULT_CONFIG };
  private currentVersion = '0.0.0';
  private blocking = false;
  private checking = false;
  private minVersion: string | null = null;
  private latestVersion: string | null = null;
  private title: string | null = null;
  private detail: string | null = null;
  private downloadUrl: string | null = null;
  private lastCheckedAt: number | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private nextCheckAt = 0;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  onModuleInit(): void {
    this.currentVersion = this.readAppVersion();
    this.config = this.loadConfig();
    if (this.config.enabled && this.config.manifestUrl) {
      this.scheduleNext(5_000); // 启动 5s 后首查
      this.logger.log(`mandatory-update: enabled, manifestUrl=${this.config.manifestUrl}`);
    } else {
      this.logger.log('mandatory-update: disabled (未配置 enabled+manifestUrl)');
    }
  }

  onModuleDestroy(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** 当前状态快照 */
  getStatus(): MandatoryUpdateState {
    return {
      enabled: this.config.enabled && !!this.config.manifestUrl,
      blocking: this.blocking,
      checking: this.checking,
      currentVersion: this.currentVersion,
      minVersion: this.minVersion,
      latestVersion: this.latestVersion,
      title: this.title,
      detail: this.detail,
      downloadUrl: this.downloadUrl,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /** 读取本地配置（脱敏展示用） */
  getConfig(): MandatoryUpdateConfig & { currentVersion: string } {
    return { ...this.config, currentVersion: this.currentVersion };
  }

  /** 更新本地配置（保存后立即触发一次检查） */
  updateConfig(patch: Partial<MandatoryUpdateConfig>): MandatoryUpdateConfig & { currentVersion: string } {
    if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
    if (typeof patch.manifestUrl === 'string') this.config.manifestUrl = patch.manifestUrl.trim();
    if (typeof patch.intervalMs === 'number' && Number.isFinite(patch.intervalMs) && patch.intervalMs >= 60_000) {
      this.config.intervalMs = Math.floor(patch.intervalMs);
    }
    if (typeof patch.timeoutMs === 'number' && Number.isFinite(patch.timeoutMs) && patch.timeoutMs >= 1_000 && patch.timeoutMs <= 120_000) {
      this.config.timeoutMs = Math.floor(patch.timeoutMs);
    }
    this.persistConfig();
    if (this.timer) clearTimeout(this.timer);
    if (this.config.enabled && this.config.manifestUrl) {
      this.scheduleNext(0);
    }
    return this.getConfig();
  }

  /**
   * 手动与定时检查共享并发请求；manual 绕过退避间隔。
   * 结果通过 getStatus() 观察。
   */
  async checkNow(manual = true): Promise<MandatoryUpdateState> {
    if (!this.config.enabled || !this.config.manifestUrl) return this.getStatus();
    if (this.pending) {
      await this.pending;
      return this.getStatus();
    }
    if (!manual && Date.now() < this.nextCheckAt) return this.getStatus();
    this.pending = this.runCheck().finally(() => {
      this.pending = null;
      if (!this.disposed) this.scheduleNext(this.backoffDelay());
    });
    await this.pending;
    return this.getStatus();
  }

  // ────────────────────────── 内部实现 ──────────────────────────

  /** 单次检查：拉取清单 → 解析 → 更新阻断状态（失败保留已知阻断） */
  private async runCheck(): Promise<void> {
    if (this.disposed) return;
    this.checking = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.config.manifestUrl, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
        headers: { accept: 'application/json', 'x-client-version': this.currentVersion },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = this.parseManifest(await res.json());
      this.failures = 0;
      this.lastError = null;
      this.applyManifest(manifest);
    } catch (err) {
      // 传输/解析失败：保留已建立的阻断决策，避免网络异常绕过最低版本要求
      this.failures++;
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
      this.checking = false;
      this.lastCheckedAt = Date.now();
    }
  }

  /** 校验并归一化清单字段 */
  private parseManifest(body: unknown): UpdateManifest {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('manifest must be a JSON object');
    }
    const o = body as Record<string, unknown>;
    const out: UpdateManifest = {};
    if (typeof o['minVersion'] === 'string' && /^\d+(\.\d+){0,3}$/.test(o['minVersion'])) {
      out.minVersion = o['minVersion'];
    }
    if (typeof o['latestVersion'] === 'string') out.latestVersion = o['latestVersion'];
    if (typeof o['mandatory'] === 'boolean') out.mandatory = o['mandatory'];
    if (typeof o['title'] === 'string' && o['title'].trim()) out.title = o['title'].slice(0, TITLE_MAX);
    if (typeof o['detail'] === 'string' && o['detail'].trim()) out.detail = o['detail'].slice(0, DETAIL_MAX);
    if (typeof o['downloadUrl'] === 'string' && this.isSafeUrl(o['downloadUrl'])) {
      out.downloadUrl = o['downloadUrl'];
    }
    if (out.minVersion === undefined && out.mandatory === undefined) {
      throw new Error('manifest lacks both minVersion and mandatory (not a decision)');
    }
    return out;
  }

  /** 应用清单决策：只有全新成功响应才能解除阻断 */
  private applyManifest(manifest: UpdateManifest): void {
    const versionBlocked =
      typeof manifest.minVersion === 'string' &&
      compareVersions(this.currentVersion, manifest.minVersion) < 0;
    const blocking = manifest.mandatory === true || versionBlocked;
    this.blocking = blocking;
    this.minVersion = manifest.minVersion ?? null;
    this.latestVersion = manifest.latestVersion ?? null;
    this.title = manifest.title ?? null;
    this.detail = manifest.detail ?? null;
    this.downloadUrl = manifest.downloadUrl ?? null;
    if (blocking) {
      this.logger.warn(`mandatory-update: BLOCKING (current=${this.currentVersion}, min=${manifest.minVersion ?? '-'}, mandatory=${manifest.mandatory === true})`);
    }
  }

  /** 退避调度：intervalMs * 2^failures，封顶 maxBackoff，加抖动 */
  private backoffDelay(): number {
    const base = Math.min(MAX_BACKOFF_MS, this.config.intervalMs * 2 ** Math.min(this.failures, 20));
    return Math.min(MAX_BACKOFF_MS, Math.round(base * (1 + Math.random() * JITTER)));
  }

  private scheduleNext(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.checkNow(false);
    }, delayMs);
  }

  /** downloadUrl 仅允许 https 或本机 http（防清单注入任意协议） */
  private isSafeUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    } catch {
      return false;
    }
  }

  /** 运行版本：cwd package.json（打包态 deploy 目录带原版 package.json） */
  private readAppVersion(): string {
    const candidates = [join(process.cwd(), 'package.json'), join(__dirname, '..', '..', '..', 'package.json')];
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as { version?: unknown };
        if (typeof raw.version === 'string' && /^\d+\.\d+\.\d+/.test(raw.version)) return raw.version;
      } catch {
        // 尝试下一个候选
      }
    }
    return '0.0.0';
  }

  /** 配置持久化：用户数据目录优先，回退读取 packages/web/data（与 mcp.json 同模式） */
  private configPath(): string {
    return join(getDefaultDataDir(), 'mandatory-update.json');
  }

  private loadConfig(): MandatoryUpdateConfig {
    const stored = loadJsonFile<Partial<MandatoryUpdateConfig>>(this.configPath(), {});
    const envUrl = process.env['SKYALYTICWING_MANDATORY_UPDATE_URL'];
    const cfg: MandatoryUpdateConfig = {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_CONFIG.enabled,
      manifestUrl: envUrl || (typeof stored.manifestUrl === 'string' ? stored.manifestUrl : DEFAULT_CONFIG.manifestUrl),
      intervalMs: typeof stored.intervalMs === 'number' && stored.intervalMs >= 60_000 ? stored.intervalMs : DEFAULT_CONFIG.intervalMs,
      timeoutMs: typeof stored.timeoutMs === 'number' && stored.timeoutMs >= 1_000 && stored.timeoutMs <= 120_000 ? stored.timeoutMs : DEFAULT_CONFIG.timeoutMs,
    };
    // 用户数据目录无文件时回退读 packages/web/data（仅读取，写回始终写用户目录）
    if (!stored.enabled && !stored.manifestUrl && !envUrl) {
      const legacy = loadJsonFile<Partial<MandatoryUpdateConfig>>(join(resolveWebDataDir(), 'mandatory-update.json'), {});
      if (typeof legacy.enabled === 'boolean') cfg.enabled = legacy.enabled;
      if (typeof legacy.manifestUrl === 'string' && legacy.manifestUrl) cfg.manifestUrl = legacy.manifestUrl;
    }
    return cfg;
  }

  private persistConfig(): void {
    saveJsonFile(this.configPath(), this.config);
  }
}

/** 三段数字版本比较：a<b → -1，a=b → 0，a>b → 1（仅支持数字段，缺失按 0） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}
