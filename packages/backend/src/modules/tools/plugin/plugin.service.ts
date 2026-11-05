import { ExtensionSelectionService } from '../../../extensions/extension-selection.service.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { pluginFingerprint } from './local-plugin-refresh.js';
import { hasPluginSecrets, mergePluginConfig, redactPluginConfig } from './plugin-config.js';
import { sealSecret, openSecret } from '../../core/utils/local-secrets.js';
import { writeJsonAtomicSync, readJsonRecover } from '../../core/utils/atomic-json.util.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { bundledPluginIds, bundledPlugins } from './bundled-plugins.js';
import type { ToolDefinition, ToolResult } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { resolveEffectiveWorkspace } from '../../core/config/effective-workspace.util.js';
import { ToolRegistryService } from '../executor/tool-registry.service.js';
import {
  PluginLoaderService,
  type PluginManifest,
  type DiscoveredPlugin,
  type DownloadMetadata,
} from './plugin-loader.service.js';

// ===========================================================================
// 常量（移植自 plugin-manager.cjs）
// ===========================================================================

/** 插件类型枚举（语音/转录/音乐/媒体理解等旧媒体套件类型已清理移除，
 *  媒体生成仅保留图片/视频两类——与统一模型体系的 API 生成对齐） */
export const PLUGIN_TYPES = [
  'provider', 'channel', 'tool', 'command', 'httpRoute', 'service',
  'hook',
  'imageGenerationProvider', 'videoGenerationProvider',
  'webSearchProvider', 'webFetchProvider',
  'securityAuditCollector', 'migrationProvider',
] as const;

/** 钩子类型枚举 */
export const HOOK_TYPES = [
  'beforeAgentStart', 'afterAgentEnd', 'messageReceived', 'messageSent',
  'beforeToolCall', 'afterToolCall', 'afterToolFailure', 'configChange',
  'gatewayStart', 'gatewayStop', 'pluginLoaded', 'pluginUnloaded',
  'sessionStart', 'sessionEnd', 'cronJobStart', 'cronJobEnd',
  'channelConnected', 'channelDisconnected', 'securityEvent',
  'approvalRequested', 'approvalResolved',
  'memoryUpdated', 'knowledgeAdded',
  'skillExecuted', 'daemonStart', 'daemonStop', 'customEvent',
] as const;

/** 插件槽位（单例插件位） */
const SLOTS = ['memory', 'contextEngine'] as const;

/** 插件类型 */
export type PluginType = typeof PLUGIN_TYPES[number];

/** 钩子类型 */
export type HookType = typeof HOOK_TYPES[number];

/** 槽位名 */
export type SlotName = typeof SLOTS[number];

// ===========================================================================
// 类型定义
// ===========================================================================

/** 插件信息（对外展示，不含敏感配置） */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  enabled: boolean;
  loaded: boolean;
  tools: string[];
}

/** 插件状态 */
export type PluginStatus = 'loaded' | 'active' | 'error' | 'not_found' | 'unknown';

/** 插件健康检查结果 */
export interface PluginHealth {
  pluginId: string;
  status: 'healthy' | 'unhealthy' | 'inactive' | 'not_found' | 'unknown' | 'error';
  message: string;
  checkedAt?: number;
}

/** ClawHub 搜索结果条目 */
export interface ClawHubSearchEntry {
  name: string;
  version: string;
  description: string;
  author: string;
  channel: string;
  downloads: number;
  rating: number;
}

/** ClawHub 搜索结果 */
export interface ClawHubSearchResult {
  query: string;
  results: ClawHubSearchEntry[];
  total: number;
  message: string;
}

/** ClawHub 更新检查结果 */
export interface ClawHubUpdateResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  changelog?: string;
  message: string;
}

/** ClawHub 发布结果 */
export interface ClawHubPublishResult {
  success: boolean;
  pluginId?: string;
  message: string;
}

/** 钩子处理器条目 */
interface HookEntry {
  id: string;
  handler: (ctx: unknown) => unknown | Promise<unknown>;
  priority: number;
  _pluginId: string | null;
  _addedAt: number;
}

/**
 * 插件条目（内部模型，融合 .cjs 插件对象与 NestJS 元数据）
 *
 * 包含：
 *   - 插件元数据（id/name/version/...）
 *   - 生命周期函数（activate/deactivate/healthCheck）
 *   - 内部状态（_status/_loadedAt/_activatedAt/_error/_path/_manifest）
 *   - 控制器兼容字段（info/config）
 */
interface PluginEntry {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  type?: string;
  enabled?: boolean;
  priority?: number;
  configSchema?: unknown;
  activate?: (api: PluginApi) => void;
  deactivate?: () => void;
  healthCheck?: () => Promise<{ healthy: boolean; message?: string }> | { healthy: boolean; message?: string };
  // 内部状态
  _status: PluginStatus;
  _loadedAt: number | null;
  _activatedAt: number | null;
  _error: string | null;
  _path: string;
  _manifest: PluginManifest | null;
  _source?: string;
  _installedAt?: number;
  // 控制器兼容字段
  info: PluginInfo;
  config: Record<string, unknown>;
}

/** 插件 API（通过 buildPluginApi 提供给插件使用） */
export interface PluginApi {
  registerProvider: (plugin: TypedPlugin) => boolean;
  registerChannel: (plugin: TypedPlugin) => boolean;
  registerTool: (plugin: TypedPlugin) => boolean;
  registerCommand: (plugin: TypedPlugin) => boolean;
  registerHttpRoute: (plugin: TypedPlugin) => boolean;
  registerService: (plugin: TypedPlugin) => boolean;
  registerHook: (plugin: TypedPlugin) => boolean;
  registerImageGenerationProvider: (plugin: TypedPlugin) => boolean;
  registerVideoGenerationProvider: (plugin: TypedPlugin) => boolean;
  registerWebSearchProvider: (plugin: TypedPlugin) => boolean;
  registerWebFetchProvider: (plugin: TypedPlugin) => boolean;
  registerSecurityAuditCollector: (plugin: TypedPlugin) => boolean;
  registerMigrationProvider: (plugin: TypedPlugin) => boolean;
  addHook: (hookName: string, handler: (ctx: unknown) => unknown, priority?: number) => string;
  removeHook: (hookName: string, handlerId: string) => boolean;
  getConfig: () => Record<string, unknown>;
  getState: () => unknown;
  setState: (state: unknown) => void;
  log: (...args: unknown[]) => void;
  getDataDir: () => string;
}

/** 类型化插件注册入参 */
export interface TypedPlugin {
  id: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  priority?: number;
  config?: Record<string, unknown>;
  configSchema?: unknown;
  activate?: (api: PluginApi) => void;
  deactivate?: () => void;
  healthCheck?: () => unknown;
  _pluginId?: string;
  [key: string]: unknown;
}

/**
 * PluginService - 插件管理服务（全量移植自 plugin-manager.cjs）
 *
 * 职责：
 *   1. 插件注册表：register/unregister/get/list/isLoaded/isEnabled
 *   2. 类型化注册：registerProvider/registerChannel/registerTool/...（18 种类型）
 *   3. 插件生命周期：loadPlugin/unloadPlugin/activatePlugin/deactivatePlugin/reloadPlugin
 *   4. 钩子系统：addHook/removeHook/runHook（支持优先级 + 异步处理器）
 *   5. 插件发现：discoverPlugins（扫描受信任目录）
 *   6. 插件 API：buildPluginApi（提供给插件的自注册接口）
 *   7. 槽位管理：resolveSlot/setSlot（memory/contextEngine 单例位）
 *   8. 配置管理：getPluginConfig/setPluginConfig（文件持久化）
 *   9. 健康检查：getPluginHealth/runHealthChecks
 *   10. ClawHub 集成：checkForUpdates/installFromClawHub/searchClawHub/publishToClawHub
 *
 * 通过 PluginLoaderService 沙箱化加载插件模块，
 * 通过 ToolRegistryService 注册插件工具供执行器调用，
 * 通过 SecurityManagerService 校验安装源路径。
 */
@Injectable()
export class PluginService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PluginService.name);
  /** 插件注册表：id -> PluginEntry */
  private readonly plugins = new Map<string, PluginEntry>();
  /** 按类型索引：type -> id -> PluginEntry */
  private readonly pluginsByType = new Map<string, Map<string, PluginEntry>>();
  /** 钩子注册表：hookName -> HookEntry[] */
  private readonly hooks = new Map<string, HookEntry[]>();
  /** 插槽：slotName -> pluginId | null */
  private readonly slots = new Map<string, string | null>();
  /** 持久化配置：pluginId -> config */
  private configs: Record<string, Record<string, unknown>> = {};
  /** 插件状态：pluginId -> state */
  private readonly states = new Map<string, unknown>();
  /** 健康检查结果缓存：pluginId -> PluginHealth */
  private readonly healthResults = new Map<string, PluginHealth>();
  /** 钩子 ID 计数器 */
  private hookCounter = 0;
  /** 配置文件路径 */
  private configPath = '';
  /** 数据目录 */
  private dataDir = '';
  private readonly bundledEntries = new WeakSet<PluginEntry>();

  constructor(
    private readonly loader: PluginLoaderService,
    private readonly registry: ToolRegistryService,
    private readonly security: SecurityManagerService,
    @Optional() private readonly resourcePolicy?: LocalResourcePolicy,
    @Optional() private readonly selection?: ExtensionSelectionService,
  ) {
    this.resourcePolicy?.registerBundledSource?.('plugin', id => {
      const entry = this.plugins.get(id);
      return bundledPluginIds.includes(id) || (!!entry && this.bundledEntries.has(entry));
    });
    // 初始化按类型索引
    for (const t of PLUGIN_TYPES) {
      this.pluginsByType.set(t, new Map());
    }
    // 初始化钩子
    for (const h of HOOK_TYPES) {
      this.hooks.set(h, []);
    }
    // 初始化插槽
    for (const s of SLOTS) {
      this.slots.set(s, null);
    }
  }

  onModuleInit(): void {
    this.init();
    this.registerBundledBaseline();
    if (typeof this.loader.discoverPlugins === 'function') {
      this.refreshTimer = setInterval(() => { void this.refreshLocalPlugins().catch(e => this.logger.warn(errMsg(e))); }, 2000);
      this.refreshTimer.unref();
      void this.refreshLocalPlugins().catch(e => this.logger.warn(errMsg(e)));
    }
  }
  private registerBundledBaseline(): void {
    this.selection?.initialize('plugins', bundledPluginIds);
    for (const { plugin, tools } of bundledPlugins(bundledPluginIds.filter(id => !this.selection || this.selection.has('plugins', id)))) {
      if (this.plugins.has(plugin.id)) continue;
      if (!this.register(plugin)) continue;
      this.bundledTools.set(plugin.id, tools);
      const entry = this.plugins.get(plugin.id)!;
      this.bundledEntries.add(entry);
      entry.config = { ...entry.config, ...this.configs[plugin.id] };
      // Present in the UI; loading is explicit so installation never sends notifications.
      entry.info.tools = tools.map(tool => tool.name);
      if (this.configs[plugin.id]?.['_enabled'] === false) this.setEnabled(plugin.id, false);
    }
  }
  async bundledCatalog() {
    this.ensureResourceScope();
    const names: Record<string, string> = { 'operation-logger': '操作日志', 'security-audit': '安全审计', 'smart-notifier': '智能通知' };
    const entries = bundledPluginIds.map(id => ({ id, name: names[id]!, installed: this.plugins.has(id) }));
    return this.resourcePolicy ? this.resourcePolicy.filterAvailable('plugin', entries, p => p.id) : entries;
  }
  async installBundled(id: string): Promise<void> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('plugin', id);
    if (!bundledPluginIds.includes(id)) throw new Error('Unknown bundled plugin');
    this.selection?.set('plugins', id, true); this.registerBundledBaseline();
  }
  private switchingScope = false;
  private explicitDataDir?: string;
  private ensureResourceScope(): void {
    if (this.switchingScope || !this.dataDir) return;
    const base = this.explicitDataDir || this.resolveDataDir();
    const next = this.resourcePolicy?.localResourceRoot?.(base) || base;
    if (next === this.dataDir) return;
    this.switchingScope = true;
    try {
      for (const entry of this.plugins.values()) {
        if (entry._status === 'active') this.deactivatePlugin(entry.id);
        this.registry.unregisterOwner('plugin:' + entry.id);
        this.loader.unload(entry.id);
      }
      this.plugins.clear(); this.states.clear(); this.healthResults.clear(); this.bundledTools.clear();
      for (const group of this.pluginsByType.values()) group.clear();
      for (const key of this.hooks.keys()) this.hooks.set(key, []);
      for (const key of this.slots.keys()) this.slots.set(key, null);
      this.localCandidates.clear(); this.localLoaded.clear(); this.localSuppressed.clear();
      this.init(this.explicitDataDir);
      this.registerBundledBaseline();
    } finally { this.switchingScope = false; }
  }
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshingLocal = false;
  private localCandidates = new Map<string, string>();
  private localLoaded = new Map<string, { id: string; fingerprint: string }>();
  private localSuppressed = new Map<string, string>();
  async onModuleDestroy(): Promise<void> { if (this.refreshTimer) clearInterval(this.refreshTimer); for (const id of [...this.plugins.keys()]) await this.unloadPluginEntry(id); }

  /** Two equal scans debounce directory copies and editor atomic saves across all three platforms. */
  async refreshLocalPlugins(): Promise<void> {
    this.ensureResourceScope();
    if (this.refreshingLocal) return;
    this.refreshingLocal = true;
    try {
      const next = new Map<string, string>();
      const discovered = this.loader.discoverPlugins();
      const present = new Set(discovered.map(d => resolve(d.path)));
      for (const [dir, previous] of this.localLoaded) {
        if (!present.has(dir)) { await this.unloadPluginEntry(previous.id); this.localLoaded.delete(dir); }
      }
      for (const d of discovered) {
        const dir = resolve(d.path), id = d.manifest.id;
        if (!id || id.startsWith('enterprise-')) continue; // Signed enterprise packages have a separate lifecycle.
        try {
          const fingerprint = pluginFingerprint(dir); next.set(dir, fingerprint);
          if (this.localSuppressed.get(dir) === fingerprint || this.configs[id]?.['_localUninstalledFingerprint'] === fingerprint) continue;
          if (this.localCandidates.get(dir) !== fingerprint) continue;
          const prior = this.localLoaded.get(dir), existing = this.plugins.get(id);
          if (prior?.fingerprint === fingerprint && existing) continue;
          const entryPath = resolve(dir, typeof d.manifest.main === 'string' ? d.manifest.main : 'index.js');
          if (!entryPath.startsWith(dir + sep) || !this.loader.isPathTrustedPluginDir(entryPath)) continue;
          if (existing && existing._path !== entryPath) continue;
          if (existing && !prior) { this.localLoaded.set(dir, {id, fingerprint}); continue; }
          const active = prior && this.plugins.get(prior.id)?._status === 'active';
          const enabled = existing?.enabled !== false;
          if (prior) await this.unloadPluginEntry(prior.id);
          const loaded = await this.loadPluginFromPath(entryPath);
          if (loaded) {
            this.localLoaded.set(dir, { id, fingerprint });
            if (!enabled) this.setEnabled(id, false);
            if (active) this.activatePlugin(id);
          }
        } catch (error) { this.logger.warn(`Local plugin ${id}: ${errMsg(error)}`); }
      }
      this.localCandidates = next;
    } finally { this.refreshingLocal = false; }
  }
  private readonly bundledTools = new Map<string, ToolDefinition[]>();

  /**
   * 初始化插件管理器（移植自 .cjs _init）。
   * - 解析数据目录
   * - 加载持久化配置
   */
  init(dataDir?: string): void {
    if (dataDir) this.explicitDataDir = dataDir;
    const base = this.explicitDataDir || this.resolveDataDir();
    this.dataDir = this.resourcePolicy?.localResourceRoot?.(base) || base;
    this.ensureDir(this.dataDir);
    this.configPath = join(this.dataDir, 'plugin-config.json');
    const stored = readJsonRecover<Record<string, unknown>>(this.configPath, {});
    this.configs = (stored['format'] === 'wing-plugin-config-v1'
      ? openSecret(stored['sealed'] as string, 'plugin-config')
      : stored) as Record<string, Record<string, unknown>>;
    if (stored['format'] !== 'wing-plugin-config-v1' && Object.keys(stored).length) {
      for (const config of Object.values(this.configs)) if (hasPluginSecrets(config)) config['_credentialOwner'] = 'local';
      this.persistConfigs();
      // Replace the legacy plaintext recovery copy as part of migration.
      writeFileSync(this.configPath + '.bak', readFileSync(this.configPath), {mode:0o600});
    }
    this.logger.log(`PluginManager initialized, dataDir: ${this.dataDir}`);
  }

  /** 解析插件数据目录 */
  private resolveDataDir(): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    if (envDir) return join(envDir, 'plugin-data');
    return join(homedir(), '.skyalyticwing', 'plugin-data');
  }

  // ===========================================================================
  // 1. 插件注册表
  // ===========================================================================

  /**
   * 注册插件（移植自 .cjs register）。
   * - 缺少 id 则失败
   * - 已注册则失败
   * - 状态置为 loaded
   */
  register(plugin: TypedPlugin): boolean {
    if (!plugin || !plugin.id) {
      this.logger.warn('Cannot register plugin: missing id');
      return false;
    }
    if (this.plugins.has(plugin.id)) {
      this.logger.warn(`Plugin already registered: ${plugin.id}`);
      return false;
    }
    const entry = this.createEntry(plugin);
    entry._status = 'loaded';
    entry._loadedAt = Date.now();
    entry._error = null;
    this.plugins.set(plugin.id, entry);
    if (plugin.type && this.pluginsByType.has(plugin.type)) {
      this.pluginsByType.get(plugin.type)!.set(plugin.id, entry);
    }
    this.logger.log(`Registered plugin: ${plugin.id} type: ${plugin.type ?? 'unknown'}`);
    return true;
  }

  /** 注销插件（移植自 .cjs unregister） */
  unregister(pluginId: string): boolean {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for unregister: ${pluginId}`);
      return false;
    }
    if (entry._status === 'active') {
      this.logger.warn(`Cannot unregister active plugin, deactivate first: ${pluginId}`);
      return false;
    }
    if (entry.type && this.pluginsByType.has(entry.type)) {
      this.pluginsByType.get(entry.type)!.delete(pluginId);
    }
    // 清理插槽引用
    for (const [slotName, slotPluginId] of this.slots) {
      if (slotPluginId === pluginId) {
        this.slots.set(slotName, null);
      }
    }
    this.plugins.delete(pluginId);
    this.states.delete(pluginId);
    this.logger.log(`Unregistered plugin: ${pluginId}`);
    return true;
  }

  /** 获取插件条目 */
  get(pluginId: string): PluginEntry | null {
    this.ensureResourceScope();
    return this.plugins.get(pluginId) ?? null;
  }

  /**
   * 列出插件（移植自 .cjs list）。
   * @param type 可选，按类型过滤
   */
  list(type?: string): PluginEntry[] {
    this.ensureResourceScope();
    if (type) {
      const typed = this.pluginsByType.get(type);
      if (!typed) return [];
      return Array.from(typed.values());
    }
    return Array.from(this.plugins.values());
  }

  /** 插件是否已加载（loaded 或 active 状态） */
  isLoaded(pluginId: string): boolean {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    return !!entry && (entry._status === 'loaded' || entry._status === 'active');
  }

  /** 插件是否已启用（enabled 且 active） */
  isEnabled(pluginId: string): boolean {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) return false;
    if (entry.enabled === false) return false;
    return entry._status === 'active';
  }

  // ===========================================================================
  // 2. 类型化注册
  // ===========================================================================

  /**
   * 类型化注册内部方法（移植自 .cjs _registerTyped）。
   * - 设置 plugin.type
   * - 若未注册则先 register
   * - 加入 pluginsByType 索引
   */
  private registerTyped(type: string, plugin: TypedPlugin): boolean {
    if (!plugin || !plugin.id) {
      this.logger.warn(`Cannot register ${type} plugin: missing id`);
      return false;
    }
    plugin.type = type;
    if (!this.plugins.has(plugin.id)) {
      this.register(plugin);
    } else {
      this.plugins.get(plugin.id)!.type = type;
    }
    if (!this.pluginsByType.has(type)) {
      this.pluginsByType.set(type, new Map());
    }
    const entry = this.plugins.get(plugin.id) ?? this.createEntry(plugin);
    this.pluginsByType.get(type)!.set(plugin.id, entry);
    this.logger.log(`Registered ${type} plugin: ${plugin.id}`);
    return true;
  }

  registerProvider(plugin: TypedPlugin): boolean { return this.registerTyped('provider', plugin); }
  registerChannel(plugin: TypedPlugin): boolean { return this.registerTyped('channel', plugin); }
  registerTool(plugin: TypedPlugin): boolean { return this.registerTyped('tool', plugin); }
  registerCommand(plugin: TypedPlugin): boolean { return this.registerTyped('command', plugin); }
  registerHttpRoute(plugin: TypedPlugin): boolean { return this.registerTyped('httpRoute', plugin); }
  registerService(plugin: TypedPlugin): boolean { return this.registerTyped('service', plugin); }
  registerHook(plugin: TypedPlugin): boolean { return this.registerTyped('hook', plugin); }
  registerImageGenerationProvider(plugin: TypedPlugin): boolean { return this.registerTyped('imageGenerationProvider', plugin); }
  registerVideoGenerationProvider(plugin: TypedPlugin): boolean { return this.registerTyped('videoGenerationProvider', plugin); }
  registerWebSearchProvider(plugin: TypedPlugin): boolean { return this.registerTyped('webSearchProvider', plugin); }
  registerWebFetchProvider(plugin: TypedPlugin): boolean { return this.registerTyped('webFetchProvider', plugin); }
  registerSecurityAuditCollector(plugin: TypedPlugin): boolean { return this.registerTyped('securityAuditCollector', plugin); }
  registerMigrationProvider(plugin: TypedPlugin): boolean { return this.registerTyped('migrationProvider', plugin); }

  // ===========================================================================
  // 3. 插件生命周期
  // ===========================================================================

  /**
   * 从文件系统路径加载插件（移植自 .cjs loadPlugin）。
   *
   * 流程：
   *   1. INT-1 路径校验（由 loader 执行）
   *   2. 清单校验（validatePluginStructure）
   *   3. 沙箱化 require 加载模块
   *   4. 提取插件对象（函数则调用，对象则直接使用）
   *   5. 提取工具并注册到 ToolRegistryService
   *   6. 注册插件到注册表
   *   7. 触发 pluginLoaded 钩子
   *
   * @returns 注册的插件条目，失败返回 null
   */
  async loadPluginFromPath(pluginPath: string): Promise<PluginEntry | null> {
    this.ensureResourceScope();
    const scope = this.dataDir;
    try {
      const resolvedPath = resolve(pluginPath);
      // INT-1 路径校验（由 loader.load/loadModule 执行）
      if (!existsSync(resolvedPath)) {
        this.logger.warn(`Plugin path not found: ${resolvedPath}`);
        return null;
      }
      const manifest = this.loader.validatePluginStructure(dirname(resolvedPath));
      if (!manifest) {
        this.logger.warn(`Invalid plugin structure: ${resolvedPath}`);
        return null;
      }

      // 沙箱化加载模块
      const pluginId = manifest.id ?? manifest.name ?? randomUUID();
      if (this.plugins.has(pluginId)) return null;
      await this.resourcePolicy?.assert('plugin', pluginId);
      const modExports = await this.loader.loadModule(resolvedPath, pluginId);
      const pluginObj = (typeof modExports === 'function')
        ? (modExports as () => TypedPlugin)()
        : (modExports as TypedPlugin);
      if (!pluginObj || !pluginObj.id || pluginObj.id !== pluginId) {
        this.logger.warn(`Plugin module does not export valid plugin object: ${resolvedPath}`);
        return null;
      }

      pluginObj['_path'] = resolvedPath;
      // 存储清单和生命周期函数
      const entry = this.createEntry(pluginObj);
      entry._path = resolvedPath;
      entry._manifest = manifest;
      const pluginType = pluginObj['type'] as string | undefined;
      if (pluginType !== undefined) {
        entry.type = pluginType;
      }
      if (pluginObj.type && this.pluginsByType.has(pluginObj.type)) {
        this.pluginsByType.get(pluginObj.type)!.set(pluginObj.id, entry);
      }

      // 提取并注册工具
      try {
        const tools = await this.loader.load(resolvedPath, pluginObj.id);
        this.ensureResourceScope();
        if (scope !== this.dataDir) throw new Error('登录身份已变化，请重试');
        if (new Set(tools.map(t => t.name)).size !== tools.length || tools.some(t => this.registry.has(t.name))) {
          this.loader.unload(pluginObj.id);
          throw new Error('插件工具名称与已有工具冲突');
        }
        this.registry.registerOwned('plugin:' + pluginObj.id, tools.map(t => this.guardedTool(pluginObj.id, t)));
        entry.info.tools = tools.map((t) => t.name);
      } catch (toolErr) {
        this.logger.warn(`Failed to extract tools from plugin ${pluginObj.id}: ${errMsg(toolErr)}`);
        return null;
      }

      this.register(pluginObj);
      const registered = this.plugins.get(pluginObj.id);
      if (registered) {
        registered.info.tools = entry.info.tools;
        registered._path = entry._path;
        registered._manifest = entry._manifest;
        registered.info.loaded = true;
        registered.config = {...registered.config, ...this.configs[pluginObj.id]};
        if (this.configs[pluginObj.id]?.['_enabled'] === false) this.setEnabled(pluginObj.id, false);
      }
      this.logger.log(`Loaded plugin: ${pluginObj.id} from: ${resolvedPath}`);
      void this.runHook('pluginLoaded', { pluginId: pluginObj.id, path: resolvedPath });
      return this.plugins.get(pluginObj.id) ?? entry;
    } catch (e) {
      this.logger.warn(`Error loading plugin: ${pluginPath} - ${errMsg(e)}`);
      return null;
    }
  }

  /**
   * 卸载插件（移植自 .cjs unloadPlugin）。
   * - 若活跃则先停用
   * - 从类型索引移除
   * - 清理钩子
   * - 从注册表删除
   * - 触发 pluginUnloaded 钩子
   */
  async unloadPluginEntry(pluginId: string): Promise<boolean> {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for unload: ${pluginId}`);
      return false;
    }
    if (entry._status === 'active') {
      this.deactivatePlugin(pluginId);
    }
    if (entry.type && this.pluginsByType.has(entry.type)) {
      this.pluginsByType.get(entry.type)!.delete(pluginId);
    }
    // 清理该插件注册的钩子
    for (const [hookName, handlers] of this.hooks) {
      this.hooks.set(hookName, handlers.filter((h) => h._pluginId !== pluginId));
    }
    // 注销工具
    this.registry.unregisterOwner('plugin:' + pluginId);
    this.plugins.delete(pluginId);
    this.states.delete(pluginId);
    this.loader.unload(pluginId);
    void this.runHook('pluginUnloaded', { pluginId });
    this.logger.log(`Unloaded plugin: ${pluginId}`);
    return true;
  }

  /**
   * 激活插件（移植自 .cjs activatePlugin）。
   * - 调用 plugin.activate(api)，api 由 buildPluginApi 构建
   * - 状态置为 active
   */
  activatePlugin(pluginId: string): boolean {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for activate: ${pluginId}`);
      return false;
    }
    if (entry._status === 'active') {
      this.logger.log(`Plugin already active: ${pluginId}`);
      return true;
    }
    if (entry.enabled === false) {
      this.logger.warn(`Plugin is disabled, cannot activate: ${pluginId}`);
      return false;
    }
    try {
      if (typeof entry.activate === 'function') {
        const api = this.buildPluginApi(pluginId);
        entry.activate(api);
      }
      entry._status = 'active';
      entry._activatedAt = Date.now();
      entry.info.loaded = true;
      this.logger.log(`Activated plugin: ${pluginId}`);
      return true;
    } catch (e) {
      entry._status = 'error';
      entry._error = errMsg(e);
      this.logger.warn(`Error activating plugin: ${pluginId} - ${errMsg(e)}`);
      return false;
    }
  }

  /** 停用插件（移植自 .cjs deactivatePlugin） */
  deactivatePlugin(pluginId: string): boolean {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for deactivate: ${pluginId}`);
      return false;
    }
    if (entry._status !== 'active') {
      this.logger.warn(`Plugin not active, cannot deactivate: ${pluginId}`);
      return false;
    }
    try {
      if (typeof entry.deactivate === 'function') {
        entry.deactivate();
      }
      entry._status = 'loaded';
      entry._activatedAt = null;
      this.logger.log(`Deactivated plugin: ${pluginId}`);
      return true;
    } catch (e) {
      entry._status = 'error';
      entry._error = errMsg(e);
      this.logger.warn(`Error deactivating plugin: ${pluginId} - ${errMsg(e)}`);
      return false;
    }
  }

  /**
   * 重载插件（移植自 .cjs reloadPlugin）。
   * - 记录原状态
   * - 停用 + 卸载
   * - 重新从路径加载
   * - 若原为活跃则重新激活
   */
  async reloadPlugin(pluginId: string): Promise<boolean> {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for reload: ${pluginId}`);
      return false;
    }
    if (this.bundledTools.has(pluginId)) {
      const enabled = entry.enabled !== false;
      await this.doUnload(pluginId, entry);
      if (enabled) await this.loadPlugin(pluginId);
      return true;
    }
    const pluginPath = entry._path;
    const wasActive = entry._status === 'active';
    this.deactivatePlugin(pluginId);
    await this.unloadPluginEntry(pluginId);
    const reloaded = await this.loadPluginFromPath(pluginPath);
    if (reloaded && wasActive) {
      this.activatePlugin(pluginId);
    }
    this.logger.log(`Reloaded plugin: ${pluginId}`);
    return !!reloaded;
  }

  // ===========================================================================
  // 4. 钩子系统
  // ===========================================================================

  /**
   * 添加钩子处理器（移植自 .cjs addHook）。
   * @param priority 优先级（数字越小越先执行，默认 100）
   * @returns 处理器 ID
   */
  addHook(hookName: string, handler: (ctx: unknown) => unknown, priority?: number): string {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, []);
    }
    this.hookCounter++;
    const handlerId = `hook_${this.hookCounter}`;
    const entry: HookEntry = {
      id: handlerId,
      handler,
      priority: typeof priority === 'number' ? priority : 100,
      _pluginId: null,
      _addedAt: Date.now(),
    };
    this.hooks.get(hookName)!.push(entry);
    // 按优先级排序（数字越小越先）
    this.hooks.get(hookName)!.sort((a, b) => a.priority - b.priority);
    return handlerId;
  }

  /** 移除钩子处理器（移植自 .cjs removeHook） */
  removeHook(hookName: string, handlerId: string): boolean {
    const handlers = this.hooks.get(hookName);
    if (!handlers) return false;
    const idx = handlers.findIndex((h) => h.id === handlerId);
    if (idx >= 0) {
      handlers.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * 执行钩子（移植自 .cjs runHook）。
   * - 按优先级顺序依次执行处理器
   * - 支持异步处理器
   * - 处理器返回非空值则更新上下文
   * - 单个处理器异常不影响后续
   */
  async runHook(hookName: string, context?: unknown): Promise<unknown> {
    this.ensureResourceScope();
    const scope = this.dataDir;
    const handlers = this.hooks.get(hookName);
    if (!handlers || handlers.length === 0) {
      return context;
    }
    let ctx = context ?? {};
    const snapshot = handlers.slice();
    for (const h of snapshot) {
      try {
          if (h._pluginId) { await this.resourcePolicy?.assert('plugin', h._pluginId); this.assertConfigIdentity(h._pluginId); }
        this.ensureResourceScope();
        if (this.dataDir !== scope) return context;
        let result = h.handler(ctx);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          result = await result;
        }
        this.ensureResourceScope();
        if (this.dataDir !== scope) return context;
        if (result !== undefined && result !== null) {
          ctx = result;
          if (hookName === 'beforeToolCall' && typeof result === 'object' && (result as { blocked?: boolean }).blocked) return result;
        }
      } catch (e) {
        this.logger.warn(`Hook handler error: ${hookName} ${h.id} - ${errMsg(e)}`);
      }
    }
    return ctx;
  }

  // ===========================================================================
  // 5. 插件发现
  // ===========================================================================

  /** 发现受信任目录中的所有插件（委托给 loader） */
  discoverPlugins(): DiscoveredPlugin[] {
    this.ensureResourceScope();
    return this.loader.discoverPlugins();
  }

  // ===========================================================================
  // 6. 插件 API
  // ===========================================================================

  /**
   * 构建插件 API（移植自 .cjs buildPluginApi）。
   *
   * 提供给插件 activate(api) 调用的自注册接口：
   *   - 类型化注册（registerProvider/registerTool/...）
   *   - 钩子注册（addHook/removeHook）
   *   - 配置/状态访问（getConfig/getState/setState）
   *   - 日志（log）
   *   - 数据目录（getDataDir）
   */
  buildPluginApi(pluginId: string): PluginApi {
    const scope = this.dataDir;
    const current = () => {
      const base = this.explicitDataDir || this.resolveDataDir();
      if ((this.resourcePolicy?.localResourceRoot?.(base) || base) !== scope) throw new Error('插件所属身份已变化');
    };
    const scopedRegister = (type: string) => (plugin: TypedPlugin) => {
      current();
      plugin._pluginId = pluginId;
      return this.registerTyped(type, plugin);
    };

    const api: PluginApi = {
      registerProvider: scopedRegister('provider'),
      registerChannel: scopedRegister('channel'),
      registerTool: scopedRegister('tool'),
      registerCommand: scopedRegister('command'),
      registerHttpRoute: scopedRegister('httpRoute'),
      registerService: scopedRegister('service'),
      registerHook: scopedRegister('hook'),
      registerImageGenerationProvider: scopedRegister('imageGenerationProvider'),
      registerVideoGenerationProvider: scopedRegister('videoGenerationProvider'),
      registerWebSearchProvider: scopedRegister('webSearchProvider'),
      registerWebFetchProvider: scopedRegister('webFetchProvider'),
      registerSecurityAuditCollector: scopedRegister('securityAuditCollector'),
      registerMigrationProvider: scopedRegister('migrationProvider'),

      addHook: (hookName: string, handler: (ctx: unknown) => unknown, priority?: number) => {
        current();
        const handlerId = this.addHook(hookName, handler, priority);
        const handlers = this.hooks.get(hookName);
        if (handlers) {
          const entry = handlers.find((h) => h.id === handlerId);
          if (entry) entry._pluginId = pluginId;
        }
        return handlerId;
      },

      removeHook: (hookName: string, handlerId: string) => this.removeHook(hookName, handlerId),

      getConfig: () => { current(); return this.getPluginConfig(pluginId); },

      getState: () => { current(); return this.states.get(pluginId) ?? null; },

      setState: (state: unknown) => {
        current();
        this.states.set(pluginId, state);
      },

      log: (...args: unknown[]) => {
        this.logger.log(`[plugin:${pluginId}]`, ...args);
      },

      getDataDir: () => {
        const dir = join(scope, 'plugin-data', pluginId);
        this.ensureDir(dir);
        return dir;
      },
    };

    return api;
  }

  // ===========================================================================
  // 7. 槽位管理
  // ===========================================================================

  /** 解析槽位绑定的插件（移植自 .cjs resolveSlot） */
  resolveSlot(slotName: string): PluginEntry | null {
    this.ensureResourceScope();
    if (!this.slots.has(slotName)) {
      this.logger.warn(`Unknown slot: ${slotName}`);
      return null;
    }
    const pluginId = this.slots.get(slotName);
    if (pluginId && this.plugins.has(pluginId)) {
      return this.plugins.get(pluginId)!;
    }
    return null;
  }

  /** 设置槽位绑定的插件（移植自 .cjs setSlot） */
  setSlot(slotName: string, pluginId: string | null): boolean {
    this.ensureResourceScope();
    if (!this.slots.has(slotName)) {
      this.logger.warn(`Unknown slot: ${slotName}`);
      return false;
    }
    if (pluginId && !this.plugins.has(pluginId)) {
      this.logger.warn(`Plugin not found for slot: ${slotName} ${pluginId}`);
      return false;
    }
    const previousId = this.slots.get(slotName);
    this.slots.set(slotName, pluginId ?? null);
    this.logger.log(`Slot ${slotName} set to: ${pluginId ?? 'null'} (was: ${previousId ?? 'null'})`);
    return true;
  }

  // ===========================================================================
  // 8. 配置管理
  // ===========================================================================

  /**
   * 获取插件配置（移植自 .cjs getPluginConfig）。
   * 优先返回持久化配置，其次插件自带配置，最后空对象。
   */
  getPluginConfig(pluginId: string): Record<string, unknown> {
    this.ensureResourceScope();
    this.assertConfigIdentity(pluginId);
    if (this.configs[pluginId]) {
      return { ...this.configs[pluginId] };
    }
    const entry = this.plugins.get(pluginId);
    if (entry && entry.config) {
      return { ...entry.config };
    }
    return {};
  }

  /**
   * 设置插件配置（移植自 .cjs setPluginConfig）。
   * - 合并到持久化配置
   * - 写入磁盘
   * - 同步到插件对象的 config 字段
   */
  setPluginConfig(pluginId: string, config: Record<string, unknown>): boolean {
    this.ensureResourceScope();
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('插件配置必须为 JSON 对象');
    const previous = this.configs[pluginId] ?? {};
    const owner = this.resourcePolicy?.credentialIdentity?.() || 'local';
    const sameOwner = !previous['_credentialOwner'] || previous['_credentialOwner'] === owner;
    const next = mergePluginConfig(sameOwner ? previous : {},config);
    next['_enabled'] = previous['_enabled'];
    if (hasPluginSecrets(next,this.getPluginSchema(pluginId))) next['_credentialOwner'] = owner;
    else delete next['_credentialOwner'];
    this.configs[pluginId] = next;
    try { this.persistConfigs(); } catch (error) { this.configs[pluginId] = previous; throw error; }
    const entry = this.plugins.get(pluginId);
    if (entry) {
      entry.config = {...next};
    }
    this.logger.log(`Config updated for plugin: ${pluginId}`);
    return true;
  }

  /** 获取插件配置 Schema（移植自 .cjs getPluginSchema） */
  getPluginSchema(pluginId: string): unknown {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) return null;
    if (entry.configSchema) return entry.configSchema;
    if (entry._manifest && entry._manifest.configSchema) return entry._manifest.configSchema;
    return null;
  }

  // ===========================================================================
  // 9. 状态与健康检查
  // ===========================================================================

  /** 获取插件状态（移植自 .cjs getPluginStatus） */
  getPluginStatus(pluginId: string): PluginStatus {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) return 'not_found';
    return entry._status ?? 'unknown';
  }

  /** 获取插件健康状态（移植自 .cjs getPluginHealth） */
  getPluginHealth(pluginId: string): PluginHealth {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      return { pluginId, status: 'not_found', message: 'Plugin not registered' };
    }
    if (entry._status !== 'active') {
      return { pluginId, status: 'inactive', message: 'Plugin is not active' };
    }
    if (this.healthResults.has(pluginId)) {
      return this.healthResults.get(pluginId)!;
    }
    return { pluginId, status: 'unknown', message: 'No health check performed' };
  }

  /**
   * 运行所有活跃插件的健康检查（移植自 .cjs runHealthChecks）。
   * - 调用每个插件的 healthCheck 方法
   * - 缓存结果
   */
  async runHealthChecks(): Promise<Record<string, PluginHealth>> {
    this.ensureResourceScope();
    const results: Record<string, PluginHealth> = {};
    const activePlugins = this.list().filter((e) => e._status === 'active');
    for (const entry of activePlugins) {
      try {
        if (typeof entry.healthCheck === 'function') {
          let result = entry.healthCheck();
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            result = await result;
          }
          const r = result as { healthy?: boolean; message?: string } | undefined;
          const health: PluginHealth = {
            pluginId: entry.id,
            status: r && r.healthy ? 'healthy' : 'unhealthy',
            message: (r && r.message) || '',
            checkedAt: Date.now(),
          };
          this.healthResults.set(entry.id, health);
        } else {
          const health: PluginHealth = {
            pluginId: entry.id,
            status: 'healthy',
            message: 'No health check defined, assuming healthy',
            checkedAt: Date.now(),
          };
          this.healthResults.set(entry.id, health);
        }
      } catch (e) {
        const health: PluginHealth = {
          pluginId: entry.id,
          status: 'error',
          message: errMsg(e),
          checkedAt: Date.now(),
        };
        this.healthResults.set(entry.id, health);
      }
      results[entry.id] = this.healthResults.get(entry.id)!;
    }
    this.logger.log(`Health checks completed for ${activePlugins.length} plugins`);
    return results;
  }

  // ===========================================================================
  // 10. ClawHub 集成
  // ===========================================================================

  /**
   * 检查插件更新（移植自 .cjs checkForUpdates）。
   * 向 ClawHub 查询最新版本，比较版本号判断是否有更新。
   */
  async checkForUpdates(pluginId: string): Promise<ClawHubUpdateResult> {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for update check: ${pluginId}`);
      return { hasUpdate: false, currentVersion: '0.0.0', latestVersion: '0.0.0', message: 'Plugin not found' };
    }
    const currentVersion = entry.version ?? '0.0.0';
    const { hostname, token, mod } = this.getClawHubConfig();

    return new Promise<ClawHubUpdateResult>((resolve) => {
      const apiPath = `/api/v1/packages/${encodeURIComponent(pluginId)}/versions/latest`;
      const options = {
        hostname,
        path: apiPath,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 8000,
      } as const;
      if (token) (options as { headers: Record<string, string> }).headers['Authorization'] = `Bearer ${token}`;

      const req = mod.request(options, (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 10485760) {
            try { res.destroy(); } catch {}
            resolve({ hasUpdate: false, currentVersion, latestVersion: currentVersion, message: 'API响应过大(>10MB)' });
          }
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const latestVersion = data.version ?? data.latestVersion ?? currentVersion;
            const hasUpdate = this.loader.compareVersions(latestVersion, currentVersion) > 0;
            resolve({
              hasUpdate,
              currentVersion,
              latestVersion,
              changelog: data.changelog ?? '',
              message: hasUpdate ? `Update available: ${latestVersion}` : 'Plugin is up to date',
            });
          } catch {
            resolve({ hasUpdate: false, currentVersion, latestVersion: currentVersion, message: 'Update check failed: invalid response' });
          }
        });
      });
      req.on('error', () => {
        resolve({ hasUpdate: false, currentVersion, latestVersion: currentVersion, message: 'Update check not available' });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ hasUpdate: false, currentVersion, latestVersion: currentVersion, message: 'Update check timed out' });
      });
      req.end();
    });
  }

  /**
   * 更新插件（移植自 .cjs updatePlugin）。
   * - 若插件有路径则尝试重载
   * - 否则从 ClawHub 下载安装
   */
  async updatePlugin(pluginId: string): Promise<boolean> {
    this.ensureResourceScope();
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for update: ${pluginId}`);
      return false;
    }
    if (entry._path) {
      this.logger.log(`Attempting reload as update for: ${pluginId}`);
      return this.reloadPlugin(pluginId);
    }
    const result = await this.installFromClawHub(pluginId);
    if (result.success) {
      this.logger.log(`Plugin updated from ClawHub: ${pluginId}`);
      return true;
    }
    this.logger.warn(`Cannot update plugin: ${pluginId} - ${result.message}`);
    return false;
  }

  /** 获取插件信息（移植自 .cjs getPluginInfo） */
  getPluginInfo(pluginId: string): {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    type: string;
    status: PluginStatus;
    path: string;
    loadedAt: number | null;
    activatedAt: number | null;
    enabled: boolean;
    priority: number;
  } | null {
    const entry = this.plugins.get(pluginId);
    if (!entry) return null;
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      version: entry.version ?? '0.0.0',
      description: entry.description ?? '',
      author: entry.author ?? '',
      type: entry.type ?? '',
      status: entry._status ?? 'unknown',
      path: entry._path ?? '',
      loadedAt: entry._loadedAt ?? null,
      activatedAt: entry._activatedAt ?? null,
      enabled: entry.enabled !== false,
      priority: typeof entry.priority === 'number' ? entry.priority : 100,
    };
  }

  /**
   * 从 ClawHub 安装插件（移植自 .cjs installFromClawHub）。
   *
   * 流程：
   *   1. 向 ClawHub 查询制品 URL
   *   2. 校验 API 兼容性
   *   3. 下载并安装（由 loader.downloadAndInstallPlugin 执行）
   *   4. 注册插件元数据
   */
  async installFromClawHub(packageName: string): Promise<{
    success: boolean;
    packageName?: string;
    version?: string;
    path?: string;
    message?: string;
  }> {
    this.logger.log(`ClawHub install requested for: ${packageName}`);
    const { hostname, token, mod } = this.getClawHubConfig();
    this.ensureResourceScope();
    const pluginDir = join(this.dataDir, 'plugins', 'installed');
    this.ensureDir(pluginDir);

    return new Promise((resolve) => {
      const apiPath = `/api/v1/packages/${encodeURIComponent(packageName)}/latest/artifact`;
      const options = {
        hostname,
        path: apiPath,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 30000,
      } as const;
      if (token) (options as { headers: Record<string, string> }).headers['Authorization'] = `Bearer ${token}`;

      const req = mod.request(options, (res: IncomingMessage) => {
        if (res.statusCode === 404) {
          return resolve({ success: false, packageName, message: `Package not found on ClawHub: ${packageName}` });
        }
        if (res.statusCode === 401) {
          return resolve({ success: false, packageName, message: 'ClawHub authentication required. Set CLAWHUB_TOKEN environment variable.' });
        }
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 10485760) {
            try { res.destroy(); } catch {}
            resolve({ success: false, packageName, message: 'API响应过大(>10MB)' });
          }
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body) as DownloadMetadata & { artifactUrl?: string; downloadUrl?: string };
            if (!data.artifactUrl && !data.downloadUrl) {
              return resolve({ success: false, packageName, message: 'No artifact URL in response' });
            }
            // API 兼容性检查
            if (data.pluginApiRange && data.pluginApiRange.min) {
              const currentApi = '1.1.0';
              if (this.loader.compareVersions(data.pluginApiRange.min, currentApi) > 0) {
                return resolve({ success: false, packageName, message: `Incompatible plugin API: requires ${data.pluginApiRange.min}` });
              }
            }
            if (data.sha256) {
              this.logger.log(`Package SHA-256 checksum: ${data.sha256}`);
            }
            const artifactUrl = data.artifactUrl ?? data.downloadUrl!;
            this.loader.downloadAndInstallPlugin(artifactUrl, packageName, pluginDir, data)
              .then(resolve)
              .catch((err: unknown) => {
                resolve({ success: false, packageName, message: `Install failed: ${errMsg(err)}` });
              });
          } catch (e) {
            resolve({ success: false, packageName, message: `Invalid response from ClawHub: ${errMsg(e)}` });
          }
        });
      });
      req.on('error', (err: unknown) => {
        resolve({ success: false, packageName, message: `ClawHub connection failed: ${errMsg(err)}` });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, packageName, message: 'ClawHub request timed out' });
      });
      req.end();
    });
  }

  /**
   * 搜索 ClawHub（移植自 .cjs searchClawHub）。
   * 向 ClawHub 查询匹配的插件包。
   */
  async searchClawHub(query: string): Promise<ClawHubSearchResult> {
    this.logger.log(`ClawHub search requested for: ${query}`);
    const { hostname, token, mod } = this.getClawHubConfig();

    return new Promise<ClawHubSearchResult>((resolve) => {
      const apiPath = `/api/v1/packages/search?q=${encodeURIComponent(query ?? '')}`;
      const options = {
        hostname,
        path: apiPath,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: 10000,
      } as const;
      if (token) (options as { headers: Record<string, string> }).headers['Authorization'] = `Bearer ${token}`;

      const req = mod.request(options, (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 10485760) {
            try { res.destroy(); } catch {}
            resolve({ query, results: [], total: 0, message: 'API响应过大(>10MB)' });
          }
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body) as { packages?: unknown[]; results?: unknown[]; total?: number };
            const rawList = (data.packages ?? data.results ?? []) as Array<Record<string, unknown>>;
            const results: ClawHubSearchEntry[] = rawList.map((pkg) => ({
              name: (pkg['name'] as string) ?? (pkg['id'] as string) ?? '',
              version: (pkg['version'] as string) ?? (pkg['latestVersion'] as string) ?? '',
              description: (pkg['description'] as string) ?? '',
              author: (pkg['author'] as string) ?? '',
              channel: (pkg['channel'] as string) ?? 'community',
              downloads: (pkg['downloads'] as number) ?? 0,
              rating: (pkg['rating'] as number) ?? 0,
            }));
            resolve({
              query,
              results,
              total: data.total ?? results.length,
              message: results.length > 0 ? `Found ${results.length} packages` : 'No packages found',
            });
          } catch {
            resolve({ query, results: [], total: 0, message: 'Search failed: invalid response from ClawHub' });
          }
        });
      });
      req.on('error', (err: unknown) => {
        resolve({ query, results: [], total: 0, message: `ClawHub connection failed: ${errMsg(err)}` });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ query, results: [], total: 0, message: 'Search timed out' });
      });
      req.end();
    });
  }

  /**
   * 发布插件到 ClawHub（移植自 .cjs publishToClawHub）。
   * 需要 CLAWHUB_TOKEN 认证。
   */
  async publishToClawHub(pluginId: string): Promise<ClawHubPublishResult> {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      this.logger.warn(`Plugin not found for ClawHub publish: ${pluginId}`);
      return { success: false, message: 'Plugin not found' };
    }
    const { hostname, token, mod } = this.getClawHubConfig();
    if (!token) {
      return { success: false, pluginId, message: 'ClawHub authentication required. Set CLAWHUB_TOKEN environment variable.' };
    }

    this.logger.log(`ClawHub publish requested for: ${pluginId}`);
    const packageData = {
      name: entry.name ?? pluginId,
      id: pluginId,
      version: entry.version ?? '1.0.0',
      description: entry.description ?? '',
      author: entry.author ?? '',
      type: entry.type ?? 'tool',
      family: 'code-plugin',
      channel: 'community',
    };
    const bodyStr = JSON.stringify(packageData);

    return new Promise<ClawHubPublishResult>((resolve) => {
      const apiPath = '/api/v1/packages';
      const options = {
        hostname,
        path: apiPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      } as const;

      const req = mod.request(options, (res: IncomingMessage) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString();
          if (responseBody.length > 10485760) {
            try { res.destroy(); } catch {}
            resolve({ success: false, pluginId, message: 'API响应过大(>10MB)' });
          }
        });
        res.on('end', () => {
          if (res.statusCode === 201 || res.statusCode === 200) {
            this.logger.log(`Plugin published to ClawHub: ${pluginId}`);
            resolve({ success: true, pluginId, message: 'Plugin published to ClawHub successfully' });
          } else {
            try {
              const errData = JSON.parse(responseBody) as { message?: string; error?: string };
              resolve({ success: false, pluginId, message: `Publish failed: ${errData.message ?? errData.error ?? `HTTP ${res.statusCode}`}` });
            } catch {
              resolve({ success: false, pluginId, message: `Publish failed with HTTP ${res.statusCode}` });
            }
          }
        });
      });
      req.on('error', (err: unknown) => {
        resolve({ success: false, pluginId, message: `ClawHub connection failed: ${errMsg(err)}` });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, pluginId, message: 'Publish request timed out' });
      });
      req.write(bodyStr);
      req.end();
    });
  }

  // ===========================================================================
  // 控制器兼容方法（保留原有 PluginController 调用的接口）
  // ===========================================================================

  /** 列出全部已安装插件（脱敏：不含 config） */
  listPlugins(): PluginInfo[] {
    this.ensureResourceScope();
    return Array.from(this.plugins.values()).map((e) => ({ ...e.info }));
  }

  /**
   * 安装插件：注册元数据（不立即加载）。
   * 保留原有控制器接口：通过 source 路径注册插件。
   */
  async installPlugin(source: string): Promise<PluginInfo> {
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('Plugin source is required');
    }
    const abs = resolve(source);
    if (abs.includes('\0')) {
      throw new Error('Plugin source must not contain null bytes');
    }
    if (!this.security.isPathAllowed(abs)) {
      throw new Error(`Plugin source path not allowed: ${abs}`);
    }
    const id = randomUUID();
    const info: PluginInfo = {
      id,
      name: id,
      version: '0.0.0',
      description: '',
      source: abs,
      enabled: true,
      loaded: false,
      tools: [],
    };
    const entry: PluginEntry = {
      id,
      enabled: true,
      _status: 'loaded',
      _loadedAt: null,
      _activatedAt: null,
      _error: null,
      _path: abs,
      _manifest: null,
      info,
      config: {},
    };
    this.plugins.set(id, entry);
    this.logger.log(`Installed plugin ${id} from ${abs}`);
    return { ...info };
  }

  /** 卸载插件：从内存移除并注销工具 */
  async uninstallPlugin(id: string): Promise<void> {
    this.ensureResourceScope();
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    // A manual install can be uninstalled before the first polling scan.
    if (typeof this.loader.discoverPlugins === 'function') for (const d of this.loader.discoverPlugins()) {
      if (d.manifest.id !== id) continue;
      const dir = resolve(d.path), fingerprint = pluginFingerprint(dir);
      this.localLoaded.set(dir, {id, fingerprint});
    }
    if (bundledPluginIds.includes(id)) this.selection?.set('plugins', id, false);
    this.clearPluginConfig(id);
    await this.unloadPluginEntry(id);
    // An explicit uninstall is different from removing the folder: suppress
    // automatic rediscovery until its contents change or the user loads it.
    for (const [dir, loaded] of this.localLoaded) if (loaded.id === id) {
      this.localSuppressed.set(dir, loaded.fingerprint);
      this.configs[id] = {...this.configs[id], _localUninstalledFingerprint: loaded.fingerprint};
      this.persistConfigs();
      this.localLoaded.delete(dir);
    }
    this.logger.log(`Uninstalled plugin ${id}`);
  }

  /** 加载插件到内存（注册工具到执行器） */
  private guardedTool(id: string, tool: ToolDefinition): ToolDefinition {
    const scope = this.dataDir;
    return { ...tool, execute: async (args, ctx) => {
      this.ensureResourceScope();
      await this.resourcePolicy?.assert('plugin', id);
      this.ensureResourceScope();
      if (scope !== this.dataDir || !this.plugins.has(id)) return { success: false, error: '登录身份已变化，请重新加载插件' };
      this.assertConfigIdentity(id);
      if (ctx.signal?.aborted || this.plugins.get(id)?.enabled === false) return {success:false,error:'插件已停用'};
      return tool.execute(args, { ...ctx, config: this.getPluginConfig(id) });
    } };
  }

  async loadPlugin(id: string): Promise<void> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('plugin', id);
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    if (entry.info.loaded) return;
    if (entry.enabled === false) throw new Error(`Plugin is disabled: ${id}`);

    const bundled = this.bundledTools.get(id);
    const tools: ToolDefinition[] = bundled ?? await this.loader.load(entry.info.source, id);
    this.registry.registerOwned('plugin:' + id, tools.map(t => this.guardedTool(id, t)));
    if (bundled && !this.activatePlugin(id)) {
      this.registry.unregisterOwner('plugin:' + id);
      throw new Error('内置插件激活失败');
    }
    entry.info.tools = tools.map((t) => t.name);
    entry.info.loaded = true;
    entry._status = 'active';
    entry._activatedAt = Date.now();
    this.logger.log(`Loaded plugin ${id}: ${entry.info.tools.join(', ') || '(no tools)'}`);
  }

  /** 从内存卸载插件（注销工具，保留安装记录） */
  async unloadPlugin(id: string): Promise<void> {
    this.ensureResourceScope();
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    if (!entry.info.loaded) return;
    if (this.bundledTools.has(id)) this.deactivatePlugin(id);
    await this.doUnload(id, entry);
  }

  /** 获取插件配置（原始，供内部使用；对外须经脱敏） */
  getPluginConfigForController(id: string): Record<string, unknown> {
    this.ensureResourceScope();
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    try { this.assertConfigIdentity(id); } catch { return {}; }
    return redactPluginConfig(this.getPluginConfig(id),this.getPluginSchema(id));
  }

  /** 设置插件配置（覆盖） */
  setPluginConfigForController(id: string, config: Record<string, unknown>): void {
    this.ensureResourceScope();
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Plugin config must be a plain object');
    }
    entry.config = { ...config };
    this.setPluginConfig(id, config);
    this.logger.log(`Updated config for plugin ${id}`);
  }

  /** 启用/禁用插件 */
  setEnabled(id: string, enabled: boolean): void {
    this.ensureResourceScope();
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin not found: ${id}`);
    entry.enabled = enabled;
    this.configs[id] = {...this.configs[id], _enabled: enabled};
    this.persistConfigs();
    entry.info.enabled = enabled;
    if (!enabled) {
      if (entry._status === 'active') this.deactivatePlugin(id);
      this.registry.unregisterOwner('plugin:' + id);
      entry.info.loaded = false;
    }
  }

  // ===========================================================================
  // 旧版兼容扩展（对齐 start.cjs PluginSystem）
  // ===========================================================================

  /**
   * 列出全部插件提供的工具（对齐旧版 getPluginTools）。
   * 聚合每个已加载插件的工具，并从工具注册表补全定义。
   */
  getPluginTools(): Array<{
    name: string;
    description: string;
    parameters?: unknown;
    pluginId: string;
    pluginName: string;
  }> {
    this.ensureResourceScope();
    const result: Array<{
      name: string;
      description: string;
      parameters?: unknown;
      pluginId: string;
      pluginName: string;
    }> = [];
    for (const entry of this.plugins.values()) {
      if (entry.enabled === false || !entry.info.loaded) continue;
      for (const toolName of entry.info.tools) {
        const def = this.registry.get(toolName);
        result.push({
          name: toolName,
          description: def?.description ?? '',
          parameters: def?.parameters,
          pluginId: entry.id,
          pluginName: entry.name ?? entry.id,
        });
      }
    }
    return result;
  }

  /**
   * 调用插件工具（对齐旧版 callPluginTool）。
   * 从工具注册表按名称解析（注册表全局共享，插件加载后工具以名称注册）。
   */
  async callPluginTool(
    pluginId: string,
    toolName: string,
    args: unknown,
  ): Promise<ToolResult & { plugin?: string }> {
    const entry = this.plugins.get(pluginId);
    if (!entry) return { success: false, error: 'Not found' };
    if (!entry.info.tools.includes(toolName)) return { success: false, error: 'Tool does not belong to this plugin' };
    await this.resourcePolicy?.assert('plugin', pluginId);
    const tool = this.registry.get(toolName);
    if (!tool || typeof tool.execute !== 'function') {
      return { success: false, error: 'Tool not found' };
    }
    try {
      const ctx = {
        sessionId: `plugin-call-${Date.now()}`,
        workspace: resolveEffectiveWorkspace(),
        config: {},
        log: () => undefined,
        broadcast: () => undefined,
      };
      const result = await tool.execute(args ?? {}, ctx);
      return { ...result, plugin: entry.name ?? entry.id };
    } catch (e) {
      return { success: false, error: errMsg(e), plugin: entry.name ?? entry.id };
    }
  }

  /**
   * 重载全部插件（对齐旧版 reloadAll）。
   * 对每个已加载插件执行 reloadPlugin（停用→卸载→重新加载→恢复激活）。
   */
  async reloadAllPlugins(): Promise<{ success: boolean; reloaded: number; loaded: number; errors: string[] }> {
    const ids = Array.from(this.plugins.keys());
    const errors: string[] = [];
    for (const id of ids) {
      try {
        const ok = await this.reloadPlugin(id);
        if (!ok) errors.push(`Failed to reload plugin: ${id}`);
      } catch (e) {
        errors.push(`Error reloading plugin ${id}: ${errMsg(e)}`);
      }
    }
    return {
      success: errors.length === 0,
      reloaded: ids.length - errors.length,
      loaded: this.plugins.size,
      errors,
    };
  }

  /**
   * 获取钩子定义列表（对齐旧版 getHookDefinitions）。
   * 返回每个内置钩子的名称与当前注册的处理器数量。
   */
  getHookDefinitions(): Array<{ name: string; count: number }> {
    this.ensureResourceScope();
    return HOOK_TYPES.map((name) => ({
      name,
      count: this.hooks.get(name)?.length ?? 0,
    }));
  }

  /** 按名称执行钩子（对齐旧版 executeHook） */
  async executeHookByName(hookName: string, context?: unknown): Promise<unknown> {
    return this.runHook(hookName, context ?? {});
  }

  /**
   * 以文件内容安装插件（对齐旧版 POST /plugins/install）。
   * - filename 经 basename 归一化，防路径穿越
   * - 写入 dataDir/plugins/<filename> 后立即加载
   */
  async installPluginFile(
    filename: string,
    content: string,
  ): Promise<{ success: boolean; filename: string; path: string; error?: string }> {
    this.ensureResourceScope();
    if (!filename || typeof content !== 'string') {
      return { success: false, filename: filename ?? '', path: '', error: 'Missing filename or content' };
    }
    const pluginsDir = join(this.dataDir, 'plugins');
    this.ensureDir(pluginsDir);
    const safeName = basename(filename);
    const filePath = join(pluginsDir, safeName);
    const base = resolve(pluginsDir) + sep;
    if (resolve(filePath).indexOf(base) !== 0) {
      return { success: false, filename, path: '', error: '路径不允许' };
    }
    try {
      writeFileSync(filePath, content, 'utf-8');
      this.logger.log(`Plugin installed: ${safeName}`);
      await this.loadPluginFromPath(filePath);
      return { success: true, filename: safeName, path: filePath };
    } catch (e) {
      return { success: false, filename: safeName, path: filePath, error: errMsg(e) };
    }
  }

  /** 插件系统状态汇总（对齐旧版 getStatus） */
  getStatusSummary(): Record<string, unknown> {
    const hookDefs = this.getHookDefinitions();
    const registeredHooks = hookDefs.reduce((sum, h) => sum + h.count, 0);
    return {
      totalLoaded: this.plugins.size,
      totalTools: this.getPluginTools().length,
      plugins: this.listPlugins(),
      hooks: hookDefs,
      stats: {
        totalPlugins: this.plugins.size,
        totalHooks: HOOK_TYPES.length,
        registeredHooks,
        tools: this.getPluginTools().length,
      },
    };
  }

  /**
   * 按 id 或名称切换插件启用状态（对齐旧版 POST/PUT /plugins/toggle）。
   * @returns 启用状态；插件未找到返回 null
   */
  async togglePluginById(id: string, enabled: boolean): Promise<boolean | null> {
    let entry: PluginEntry | null = this.plugins.get(id) ?? null;
    if (!entry) {
      entry = Array.from(this.plugins.values()).find((e) => e.name === id) ?? null;
    }
    if (!entry) return null;
    this.setEnabled(entry.id, enabled);
    if (enabled) {
      try { await this.loadPlugin(entry.id); }
      catch (error) { this.setEnabled(entry.id, false); throw error; }
    }
    this.logger.log(`Plugin "${entry.name ?? id}" ${enabled ? 'enabled' : 'disabled'}`);
    return enabled;
  }

  /** 内部卸载逻辑：注销工具 + 清理加载缓存 */
  private async doUnload(id: string, entry: PluginEntry): Promise<void> {
    if (this.bundledTools.has(id) && entry._status === 'active') this.deactivatePlugin(id);
    this.registry.unregisterOwner('plugin:' + id);
    entry.info.tools = [];
    entry.info.loaded = false;
    entry._status = 'loaded';
    entry._activatedAt = null;
    this.loader.unload(id);
  }

  // ===========================================================================
  // 内部辅助方法
  // ===========================================================================

  /** 从 TypedPlugin 创建 PluginEntry */
  private createEntry(plugin: TypedPlugin): PluginEntry {
    const id = plugin.id;
    const name = plugin.name as string | undefined;
    const version = plugin['version'] as string | undefined;
    const description = plugin['description'] as string | undefined;
    const author = plugin['author'] as string | undefined;
    const pluginType = plugin.type as string | undefined;
    const pluginPath = (plugin['_path'] as string) ?? '';
    const pluginConfig = (plugin['config'] as Record<string, unknown>) ?? {};
    const info: PluginInfo = {
      id,
      name: name ?? id,
      version: version ?? '0.0.0',
      description: description ?? '',
      source: pluginPath,
      enabled: plugin.enabled !== false,
      loaded: false,
      tools: [],
    };
    const entry: PluginEntry = {
      id,
      _status: 'loaded',
      _loadedAt: null,
      _activatedAt: null,
      _error: null,
      _path: pluginPath,
      _manifest: null,
      info,
      config: pluginConfig,
    };
    // 条件赋值可选属性（exactOptionalPropertyTypes 要求不能赋值 undefined）
    if (name !== undefined) entry.name = name;
    if (version !== undefined) entry.version = version;
    if (description !== undefined) entry.description = description;
    if (author !== undefined) entry.author = author;
    if (pluginType !== undefined) entry.type = pluginType;
    if (plugin.enabled !== undefined) entry.enabled = plugin.enabled;
    const priority = plugin.priority as number | undefined;
    if (priority !== undefined) entry.priority = priority;
    if (plugin.configSchema !== undefined) entry.configSchema = plugin.configSchema;
    // 使用局部变量确保类型收窄后不再携带 undefined（exactOptionalPropertyTypes 要求）
    const activate = plugin.activate;
    if (activate !== undefined) entry.activate = activate;
    const deactivate = plugin.deactivate;
    if (deactivate !== undefined) entry.deactivate = deactivate;
    const healthCheck = plugin.healthCheck;
    if (healthCheck !== undefined) {
      // TypedPlugin.healthCheck 返回 unknown，需断言为 PluginEntry 期望的签名；
      // 使用 Object.assign 绕过 exactOptionalPropertyTypes 对可选属性赋值的严格限制
      Object.assign(entry, { healthCheck: healthCheck as PluginEntry['healthCheck'] });
    }
    return entry;
  }

  /** 获取 ClawHub 配置（URL/hostname/token/模块） */
  private getClawHubConfig(): {
    hostname: string;
    token: string;
    mod: typeof http | typeof https;
  } {
    const hubUrl = process.env['CLAWHUB_URL'] ?? 'https://clawhub.ai';
    let hostname: string;
    try {
      hostname = new URL(hubUrl).hostname;
    } catch {
      hostname = hubUrl.replace(/^https?:\/\//, '').split(':')[0];
    }
    const token = process.env['CLAWHUB_TOKEN'] ?? process.env['SKYALYTICWING_CLAWHUB_TOKEN'] ?? '';
    const mod = hubUrl.startsWith('https') ? https : http;
    return { hostname, token, mod };
  }

  /** 确保目录存在 */
  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        this.logger.warn(`Failed to create dir: ${dir} - ${errMsg(e)}`);
      }
    }
  }

  private persistConfigs(): void {
    writeJsonAtomicSync(this.configPath, {format:'wing-plugin-config-v1',sealed:sealSecret(this.configs,'plugin-config')});
  }
  private assertConfigIdentity(id: string): void {
    const config=this.configs[id];
    if (config && !config['_credentialOwner'] && hasPluginSecrets(config,this.getPluginSchema(id))) {
      config['_credentialOwner']='local';this.persistConfigs();
    }
    const owner = config?.['_credentialOwner'];
    if (owner && owner !== (this.resourcePolicy?.credentialIdentity?.() || 'local')) throw new Error('插件凭据属于其他登录身份，请重新配置');
  }
  clearPluginConfig(id: string): void {
    this.ensureResourceScope();
    if (!this.plugins.has(id) && !Object.prototype.hasOwnProperty.call(this.configs,id)) return;
    const enabled = this.configs[id]?.['_enabled'];
    this.configs[id] = {_enabled:enabled};
    this.persistConfigs();
    writeFileSync(this.configPath+'.bak',readFileSync(this.configPath),{mode:0o600});
    const entry=this.plugins.get(id);if(entry)entry.config = {};
  }
}

/** 错误消息提取 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
