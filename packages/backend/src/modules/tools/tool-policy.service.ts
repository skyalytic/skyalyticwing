import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir, platform } from 'node:os';
import { LoggerService } from '../core/logger/logger.service.js';
import { resolveWebDataDir } from '../core/utils/web-data.util.js';

/**
 * ToolPolicyService - 工具策略管线服务
 *
 * 移植自 start.cjs ToolPolicyPipeline（行 6669-6770）。
 *
 * 策略结构：
 *   { allow: string[], deny: string[] }
 * allow/deny 均为 glob 模式（支持 * 与 ?），deny 优先；allow 为空时表示放行全部。
 *
 * 持久化：${dataDir}/tool-policies.json
 */
export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface PolicySummary {
  name: string;
  allow: number;
  deny: number;
}

@Injectable()
export class ToolPolicyService implements OnModuleInit {
  private readonly policies = new Map<string, ToolPolicy>();
  private filePath = '';

  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.filePath = this.resolveFilePath('tool-policies.json');
    this.load();
  }

  /** 注册/覆盖策略 */
  registerPolicy(name: string, policy: ToolPolicy): void {
    if (!name) throw new Error('策略名必填');
    this.policies.set(name, policy || { allow: [], deny: [] });
    this.persist();
    this.logger.info('ToolPolicyService: registered policy', { name });
  }

  /** 移除策略 */
  removePolicy(name: string): boolean {
    const existed = this.policies.delete(name);
    if (existed) {
      this.persist();
      this.logger.info('ToolPolicyService: removed policy', { name });
    }
    return existed;
  }

  /** 获取单个策略 */
  getPolicy(name: string): ToolPolicy | null {
    return this.policies.get(name) || null;
  }

  /** 列出全部策略摘要（与 .cjs listPolicies 一致） */
  listPolicies(): PolicySummary[] {
    const summaries: PolicySummary[] = [];
    for (const [name, p] of this.policies) {
      summaries.push({
        name,
        allow: (p.allow || []).length,
        deny: (p.deny || []).length,
      });
    }
    return summaries;
  }

  /**
   * 按策略名列表过滤工具定义。
   * tools 入参支持 OpenAI function-calling 格式或简单 { name } 对象。
   */
  filterTools<T extends { function?: { name?: string }; name?: string }>(
    tools: T[],
    policyNames: string[],
  ): T[] {
    let filtered = tools.slice();
    for (const name of policyNames || []) {
      const policy = this.policies.get(name);
      if (!policy) continue;
      filtered = this.applyPolicy(filtered, policy);
    }
    return filtered;
  }

  /** 全部策略名（供 filterTools 全量应用；清单过滤用） */
  listPolicyNames(): string[] {
    return Array.from(this.policies.keys());
  }

  /**
   * 单工具聚合判定（全部已注册策略叠加，供执行期安全闸门调用）。
   * 语义：任一策略 deny 命中 → 'deny'（安全优先）；
   *       否则任一策略 allow 名单命中 → 'allow'（视为 auto 放行）；
   *       名单外/无策略 → null（不干预，交由常规闸门判定）。
   * 注：allow 非空且工具不在名单的"隐藏"语义由 LLM 工具清单过滤承担
   * （filterTools），执行期不硬拒——模型无法看到名单外工具即不会调用。
   */
  checkTool(toolName: string): 'deny' | 'allow' | null {
    if (!toolName) return null;
    for (const policy of this.policies.values()) {
      for (const d of policy.deny || []) {
        if (this.matchGlob(toolName, d)) return 'deny';
      }
    }
    for (const policy of this.policies.values()) {
      for (const a of policy.allow || []) {
        if (this.matchGlob(toolName, a)) return 'allow';
      }
    }
    return null;
  }

  // ─── 内部工具 ────────────────────────────────────────────────────────

  private applyPolicy<T extends { function?: { name?: string }; name?: string }>(
    tools: T[],
    policy: ToolPolicy,
  ): T[] {
    const allow = policy.allow || [];
    const deny = policy.deny || [];
    return tools.filter((tool) => {
      const name = (tool.function && tool.function.name) || tool.name || '';
      for (const d of deny) {
        if (this.matchGlob(name, d)) return false;
      }
      if (allow.length > 0) {
        for (const a of allow) {
          if (this.matchGlob(name, a)) return true;
        }
        return false;
      }
      return true;
    });
  }

  private matchGlob(name: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.indexOf('*') === -1 && pattern.indexOf('?') === -1) {
      return name === pattern;
    }
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(name);
  }

  private load(): void {
    try {
      // 主路径不存在时回退旧版 packages/web/data 位置（仅读取，persist 仍写新位置）
      let filePath = this.filePath;
      if (!existsSync(filePath)) {
        const legacy = resolvePath(resolveWebDataDir(), 'tool-policies.json');
        if (existsSync(legacy)) filePath = legacy;
      }
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            this.policies.set(k, v as ToolPolicy);
          }
        }
      }
    } catch (err) {
      this.logger.warn('ToolPolicyService: failed to load policies', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.logger.info('ToolPolicyService: loaded', { count: this.policies.size });
  }

  private persist(): void {
    try {
      const obj: Record<string, ToolPolicy> = {};
      for (const [k, v] of this.policies) obj[k] = v;
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn('ToolPolicyService: failed to persist policies', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveFilePath(filename: string): string {
    const dataDir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    return resolvePath(dataDir, filename);
  }

  private getDefaultDataDir(): string {
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
