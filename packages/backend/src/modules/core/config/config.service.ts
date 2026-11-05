import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { ConfigError } from '@skyalyticwing/shared';
import { getDefaultDataDir, resolveWebDataDir } from '../utils/web-data.util.js';

/**
 * ConfigService
 *
 * 负责 config.json 的读取、深度合并更新、环境变量覆盖与持久化。
 * 读取路径优先级：
 *   1. process.env.SKYALYTICWING_DATA_DIR
 *   2. Windows: %APPDATA%/SkyalyticWing
 *      macOS:  ~/Library/Application Support/SkyalyticWing
 *      Linux:  $XDG_CONFIG_HOME/skyalyticwing 或 ~/.config/skyalyticwing
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  private config: Record<string, unknown> = {};
  private configPath: string = '';

  onModuleInit(): void {
    this.configPath = this.resolveConfigPath();
    this.load();
    this.migrateLegacyData();
  }

  /** 获取指定配置段；不存在则抛 ConfigError */
  get<T>(section: string): T {
    if (!(section in this.config)) {
      throw new ConfigError(`Section '${section}' not found`);
    }
    return this.config[section] as T;
  }

  /** 设置指定配置段（覆盖整段，不合并） */
  set(section: string, value: unknown): void {
    this.config[section] = value;
  }

  /** 获取全部配置（浅拷贝避免外部直接修改内部状态） */
  getAll(): Record<string, unknown> {
    return { ...this.config };
  }

  /** 深度合并 source 到当前配置（用于 PUT /api/config 整体更新） */
  merge(source: Record<string, unknown>): Record<string, unknown> {
    this.config = deepMerge(this.config, source);
    return this.config;
  }

  /** 深度合并指定段（用于 PUT /api/config/:section 当前后端均为对象时） */
  mergeSection(section: string, value: unknown): unknown {
    const current = this.config[section];
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      this.config[section] = deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      this.config[section] = value;
    }
    return this.config[section];
  }

  /** 持久化到 config.json */
  save(): void {
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      throw new ConfigError(
        `Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 重新从磁盘加载配置（用于热重载场景） */
  reload(): void {
    this.load();
  }

  private resolveConfigPath(): string {
    const dataDir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    if (!existsSync(dataDir)) {
      try {
        mkdirSync(dataDir, { recursive: true });
      } catch {
        // 忽略目录创建失败，后续 save() 会再次尝试
      }
    }
    return join(dataDir, 'config.json');
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

  private load(): void {
    try {
      if (existsSync(this.configPath)) {
        const content = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.config = deepMerge(this.getDefaultConfig(), parsed as Record<string, unknown>);
        } else {
          this.config = this.getDefaultConfig();
        }
      } else {
        this.config = this.getDefaultConfig();
        // 首次启动写入默认配置，便于用户编辑
        try {
          this.save();
        } catch {
          // 写入失败不阻断启动
        }
      }
    } catch {
      this.config = this.getDefaultConfig();
    }
    this.applyEnvOverrides();
  }

  // ===========================================================================
  // 旧版数据迁移（幂等：已有数据不覆盖）
  // ===========================================================================

  /**
   * 启动时迁移旧版独立 JSON 数据文件到 config.json：
   *   - permissions.json      → general.permissionMode + security.permissionRules
   *   - tool-disabled.json    → tools.toolSettings[name].disabled
   *   - tool-permissions.json → tools.toolSettings[name].permission
   * 旧文件优先从用户数据目录读取，不存在再回退 packages/web/data。
   */
  private migrateLegacyData(): void {
    try {
      let changed = false;
      changed = this.migrateLegacyPermissions() || changed;
      changed = this.migrateLegacyToolSettings() || changed;
      if (changed) this.save();
    } catch {
      // 迁移失败不阻断启动
    }
  }

  /** permissions.json → general.permissionMode + security.permissionRules */
  private migrateLegacyPermissions(): boolean {
    const legacy = this.readLegacyJson('permissions.json');
    if (!legacy || typeof legacy !== 'object') return false;

    let changed = false;

    // 权限模式：mode / permissionMode → general.permissionMode（已有配置不覆盖）
    const legacyMode = (legacy as Record<string, unknown>)['permissionMode']
      ?? (legacy as Record<string, unknown>)['mode'];
    if (
      (legacyMode === 'ask' || legacyMode === 'auto-safe' || legacyMode === 'manual') &&
      this.getOrCreateSection<Record<string, unknown>>('general')['permissionMode'] === undefined
    ) {
      this.config['general'] = { ...this.getOrCreateSection<Record<string, unknown>>('general'), permissionMode: legacyMode };
      changed = true;
    }

    // 规则：rules → security.permissionRules（config 已有非空规则时不覆盖）
    const rules = (legacy as Record<string, unknown>)['rules'];
    const security = this.getOrCreateSection<Record<string, unknown>>('security');
    const existingRules = security['permissionRules'];
    if (Array.isArray(rules) && rules.length > 0 && !Array.isArray(existingRules)) {
      const now = Date.now();
      security['permissionRules'] = rules
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r, i) => ({
          id: typeof r['id'] === 'string' ? r['id'] : `legacy-perm-${i}-${now.toString(36)}`,
          type: r['type'] ?? 'ask',
          tool: r['tool'] ?? r['toolName'] ?? '',
          reason: r['reason'] ?? '',
          createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : now,
        }));
      this.config['security'] = security;
      changed = true;
    }

    return changed;
  }

  /** tool-disabled.json / tool-permissions.json → tools.toolSettings */
  private migrateLegacyToolSettings(): boolean {
    const disabledRaw = this.readLegacyJson('tool-disabled.json');
    const permsRaw = this.readLegacyJson('tool-permissions.json');
    if (disabledRaw === null && permsRaw === null) return false;

    // 归一化禁用列表：支持 { name: true } / { disabled: [...] } / ["a","b"]
    const disabledNames = new Set<string>();
    if (Array.isArray(disabledRaw)) {
      for (const n of disabledRaw) if (typeof n === 'string' && n) disabledNames.add(n);
    } else if (disabledRaw && typeof disabledRaw === 'object') {
      const obj = disabledRaw as Record<string, unknown>;
      if (Array.isArray(obj['disabled'])) {
        for (const n of obj['disabled'] as unknown[]) if (typeof n === 'string' && n) disabledNames.add(n);
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k !== 'disabled' && v === true) disabledNames.add(k);
      }
    }

    // 归一化权限映射：支持 { name: "allow" } / { permissions: {...} }
    const permMap = new Map<string, string>();
    const collectPerms = (source: unknown): void => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) return;
      for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (k === 'permissions') {
          collectPerms(v);
        } else if (typeof v === 'string' && v) {
          permMap.set(k, v);
        }
      }
    };
    collectPerms(permsRaw);

    if (disabledNames.size === 0 && permMap.size === 0) return false;

    const tools = this.getOrCreateSection<Record<string, unknown>>('tools');
    const toolSettings = (tools['toolSettings'] && typeof tools['toolSettings'] === 'object')
      ? (tools['toolSettings'] as Record<string, unknown>)
      : {};
    let changed = false;

    for (const name of disabledNames) {
      const cfg = (toolSettings[name] && typeof toolSettings[name] === 'object')
        ? (toolSettings[name] as Record<string, unknown>)
        : {};
      if (cfg['disabled'] === undefined) {
        cfg['disabled'] = true;
        toolSettings[name] = cfg;
        changed = true;
      }
    }
    for (const [name, permission] of permMap) {
      const cfg = (toolSettings[name] && typeof toolSettings[name] === 'object')
        ? (toolSettings[name] as Record<string, unknown>)
        : {};
      if (cfg['permission'] === undefined) {
        cfg['permission'] = permission;
        toolSettings[name] = cfg;
        changed = true;
      }
    }

    if (changed) {
      tools['toolSettings'] = toolSettings;
      this.config['tools'] = tools;
    }
    return changed;
  }

  /** 读取旧版数据文件：优先用户数据目录，回退 packages/web/data；不存在返回 null */
  private readLegacyJson(filename: string): unknown {
    const candidates = [join(getDefaultDataDir(), filename), join(resolveWebDataDir(), filename)];
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        // 解析失败尝试下一个候选
      }
    }
    return null;
  }

  private getDefaultConfig(): Record<string, unknown> {
    return {
      version: '1.0.0',
      providers: {},
      general: {},
      security: {
        auth: { mode: 'none' },
        yolo: 'ask',
        allowedPaths: [],
        blockedCommands: [],
      },
      server: {
        port: 19111,
        host: '127.0.0.1',
        websocketPort: 19111,
        maxBodySize: 50 * 1024 * 1024,
        requestTimeoutMs: 30000,
      },
      log: {
        level: 'info',
        redactKeys: ['authToken', 'apiKey', 'tls.key', 'password', 'secret', 'token'],
        maxBufferEntries: 1000,
      },
    };
  }

  /**
   * 环境变量覆盖（仅覆盖运行期相关字段，不持久化）
   *   - PORT → server.port
   *   - SKYALYTICWING_LOG_LEVEL → log.level
   *   - SKYALYTICWING_AUTH_TOKEN → security.auth.token + security.auth.mode='token'
   */
  private applyEnvOverrides(): void {
    const portEnv = process.env['PORT'];
    if (portEnv) {
      const port = parseInt(portEnv, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        const server = this.getOrCreateSection<Record<string, unknown>>('server');
        server['port'] = port;
      }
    }

    const logLevelEnv = process.env['SKYALYTICWING_LOG_LEVEL'];
    if (logLevelEnv) {
      const log = this.getOrCreateSection<Record<string, unknown>>('log');
      log['level'] = logLevelEnv;
    }

    const authTokenEnv = process.env['SKYALYTICWING_AUTH_TOKEN'];
    if (authTokenEnv) {
      const security = this.getOrCreateSection<Record<string, unknown>>('security');
      const auth = (security['auth'] || {}) as Record<string, unknown>;
      auth['token'] = authTokenEnv;
      auth['mode'] = 'token';
      security['auth'] = auth;
      this.config['security'] = security;
    }
  }

  private getOrCreateSection<T>(section: string): T {
    const existing = this.config[section];
    if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      return existing as T;
    }
    const created: Record<string, unknown> = {};
    this.config[section] = created;
    return created as unknown as T;
  }
}

/**
 * 深度合并两个对象：对同为对象（非数组）的键递归合并，其余键由 source 覆盖。
 * 不修改入参。
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const targetVal = result[key];
    const sourceVal = source[key];
    if (
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}
