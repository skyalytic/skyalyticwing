import { Injectable, Logger, Optional } from '@nestjs/common';
import { ExtensionSelectionService } from '../../../extensions/extension-selection.service.js';
import type { ToolDefinition } from '@skyalyticwing/shared';

/**
 * ToolRegistryService - 工具注册表
 *
 * 维护 name → ToolDefinition 的映射，是 ToolExecutorService / PluginService /
 * McpService 共享的工具存储。提供同步的 register/unregister/get/getAll，
 * 以及异步的 ensureLoaded 用于插件/MCP 工具的并发安全加载。
 *
 * 并发保护：loadingPromises Map 对同名工具的并发加载去重，避免 TOCTOU
 * （检查未注册→注册期间另一并发加载也进入注册分支导致重复加载）。
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  /** name → 工具定义 */
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly reserved = new Set<string>();
  private readonly builtins = new Map<string, ToolDefinition>();
  private readonly owners = new Map<string, { names: string[]; abort: AbortController }>();
  private readonly generations = new Map<string, number>();
  private readonly available = new Map<string, ToolDefinition>();
  private readonly calls = new Map<string, AbortController>();
  constructor(@Optional() private readonly selection?: ExtensionSelectionService) {}

  /** Retain metadata for reinstall, but remove callable definitions and cancel active calls. */
  syncToolInstallations(): void {
    if (!this.selection) return;
    let removed: Set<string>;
    try { removed = this.selection.removedTools(); }
    catch { for (const name of this.tools.keys()) this.revoke(name); return; }
    for (const [name, original] of this.available) {
      if (removed.has(name)) { this.revoke(name); continue; }
      if (this.tools.has(name)) continue;
      const abort = new AbortController(), scope = this.selection.scope;
      this.calls.set(name, abort);
      this.tools.set(name, { ...original, execute: async (args, ctx) => {
        if (abort.signal.aborted || scope !== this.selection!.scope || this.selection!.removedTools().has(name))
          return { success: false, error: 'Tool is no longer installed for this identity' };
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
        if (signal.aborted) return { success: false, error: 'Task cancelled' };
        return original.execute(args, { ...ctx, signal });
      } });
    }
  }
  private revoke(name: string): void {
    this.calls.get(name)?.abort(); this.calls.delete(name); this.tools.delete(name);
  }
  private store(tool: ToolDefinition): void {
    this.revoke(tool.name); this.available.set(tool.name, tool);
    if (this.selection) this.syncToolInstallations(); else this.tools.set(tool.name, tool);
  }
  catalog(): Array<ToolDefinition & { installed: boolean; loaded: boolean }> {
    this.syncToolInstallations();
    return [...this.available.values()].map(tool => ({ ...tool, installed: this.tools.has(tool.name), loaded: this.tools.has(tool.name) }));
  }
  knows(name: string): boolean { return this.available.has(name); }

  validateOwned(owner: string, tools: ToolDefinition[]): void {
    const old = new Set(this.owners.get(owner)?.names || []), seen = new Set<string>();
    for (const tool of tools) {
      const key = tool.name?.replace(/_/g, '-');
      if (!key || seen.has(key) || typeof tool.execute !== 'function' ||
          (this.knows(tool.name) && !old.has(tool.name)) || (this.isReserved(tool.name) && !old.has(tool.name))) {
        throw new Error(`Tool registration conflict: ${tool.name}`);
      }
      seen.add(key);
    }
  }
  registerOwned(owner: string, tools: ToolDefinition[], trusted = false): void {
    this.validateOwned(owner, tools);
    if (this.owners.has(owner)) throw new Error(`Extension is already active: ${owner}`);
    const abort = new AbortController();
    this.owners.set(owner, { names: tools.map(t => t.name), abort });
    for (const tool of tools) {
      const wrapped: ToolDefinition = { ...tool, execute: async (args, ctx) => {
        if (abort.signal.aborted) return { success: false, error: 'Tool was uninstalled or reloaded' };
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
        if (signal.aborted) return { success: false, error: 'Task cancelled' };
        return tool.execute(args, { ...ctx, signal });
      } };
      if (trusted) this.registerBuiltin(wrapped); else this.register(wrapped);
    }
  }
  unregisterOwner(owner: string): void {
    const record = this.owners.get(owner);
    if (!record) return;
    record.abort.abort();
    this.owners.delete(owner);
    for (const name of record.names) {
      this.unregister(name);
      this.builtins.delete(name);
      this.reserved.delete(name.replace(/_/g, '-'));
    }
  }

  isBuiltin(name: string): boolean {
    return this.builtins.has(name) && this.builtins.get(name) === this.available.get(name) && this.has(name);
  }

  registerBuiltin(tool: ToolDefinition): void {
    this.reserved.add(tool.name.replace(/_/g, '-'));
    this.builtins.set(tool.name, tool);
    this.store(tool);
  }
  /** name → 进行中的加载 Promise（防止并发重复加载） */
  private readonly loadingPromises = new Map<string, Promise<void>>();

  /** 获取单个工具定义 */
  get(name: string): ToolDefinition | undefined {
    this.syncToolInstallations();
    return this.tools.get(name);
  }

  /** 获取全部工具定义 */
  getAll(): ToolDefinition[] {
    this.syncToolInstallations();
    return Array.from(this.tools.values());
  }

  /** 是否已注册指定工具 */
  has(name: string): boolean {
    this.syncToolInstallations();
    return this.tools.has(name);
  }

  isReserved(name: string): boolean {
    return this.reserved.has(name.replace(/_/g, '-'));
  }

  /** 注册工具（同名覆盖） */
  register(tool: ToolDefinition): void {
    if (this.isReserved(tool.name))
      throw new Error(`Cannot replace built-in tool: ${tool.name}`);
    this.store(tool);
    this.logger.log(`Registered tool: ${tool.name}`);
  }

  /** 注销工具 */
  unregister(name: string): void {
    this.generations.set(name, (this.generations.get(name) || 0) + 1);
    this.revoke(name);
    if (this.available.delete(name)) {
      this.logger.log(`Unregistered tool: ${name}`);
    }
  }

  /** 清空全部工具 */
  clear(): void {
    for (const owner of [...this.owners.keys()]) this.unregisterOwner(owner);
    for (const name of this.loadingPromises.keys()) this.generations.set(name, (this.generations.get(name) || 0) + 1);
    for (const name of this.tools.keys()) this.revoke(name);
    this.available.clear();
    this.builtins.clear(); this.reserved.clear();
    this.loadingPromises.clear();
  }

  /**
   * 确保工具已加载（并发安全）。
   *
   * 若工具已注册则立即返回；若已有同名加载进行中则复用同一 Promise；
   * 否则执行 loader 并在完成后注册。loader 抛错或返回 undefined 时不注册，
   * 但清除加载标记以便后续重试。
   */
  async ensureLoaded(
    name: string,
    loader: () => Promise<ToolDefinition | undefined>,
  ): Promise<void> {
    if (this.tools.has(name)) return;
    const existing = this.loadingPromises.get(name);
    if (existing) return existing;

    const generation = this.generations.get(name) || 0;
    const promise = (async (): Promise<void> => {
      try {
        const tool = await loader();
        if (tool && generation === (this.generations.get(name) || 0)) this.register(tool);
      } finally {
        this.loadingPromises.delete(name);
      }
    })();

    this.loadingPromises.set(name, promise);
    return promise;
  }
}
