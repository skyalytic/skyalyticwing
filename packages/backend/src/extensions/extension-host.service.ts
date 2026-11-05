import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ExtensionHost, ExtensionInstance, ExtensionManifest } from './host-api.js';
import type { ToolListItem } from '@skyalyticwing/shared';
import { ExtensionSelectionService } from './extension-selection.service.js';
import { ToolRegistryService } from '../modules/tools/executor/tool-registry.service.js';
import { LocalResourcePolicy } from '../modules/core/security/local-resource-policy.service.js';

type CatalogEntry = ExtensionManifest & { directory: string };
@Injectable()
export class ExtensionHostService implements OnModuleDestroy {
  private readonly logger = new Logger(ExtensionHostService.name);
  private host?: ExtensionHost;
  private active = new Map<string, ExtensionInstance>();
  private scope = '';
  private queue: Promise<unknown> = Promise.resolve();
  private catalog = new Map<string, CatalogEntry>();
  constructor(private readonly registry: ToolRegistryService, private readonly selection: ExtensionSelectionService,
    @Optional() private readonly policy?: LocalResourcePolicy) {
    const root = join(__dirname, 'bundled');
    if (existsSync(root)) for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const directory = join(root, dir.name), manifest = join(directory, 'manifest.json');
      if (!existsSync(manifest)) continue;
      const m = JSON.parse(readFileSync(manifest, 'utf8')) as ExtensionManifest;
      if (!/^wing-[a-z0-9-]+$/.test(m.id) || m.apiVersion !== 1 || !m.version || !m.name ||
          !Array.isArray(m.guides) || this.catalog.has(m.id)) throw new Error(`Invalid extension manifest: ${dir.name}`);
      this.contained(directory, m.entry);
      for (const path of m.guides) this.contained(directory, path);
      for (const paths of Object.values(m.platformGuides || {})) for (const path of paths || []) this.contained(directory, path);
      this.catalog.set(m.id, { ...m, directory });
    }
    this.policy?.registerBundledSource('plugin', id => this.catalog.has(id));
  }
  private contained(root: string, path: string): string {
    if (typeof path !== 'string') throw new Error('Invalid extension path');
    const target = resolve(root, path), canonicalRoot = realpathSync(root);
    if (!target.startsWith(resolve(root) + sep) ||
        (existsSync(target) && !realpathSync(target).startsWith(canonicalRoot + sep))) throw new Error('Extension path escapes its package');
    return target;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  async initialize(host: ExtensionHost): Promise<void> { this.host = host; await this.refresh(); }
  async refresh(): Promise<void> { await this.serial(() => this.reconcile()); }
  private async reconcile(): Promise<void> {
    const scope = this.selection.scope;
    if (scope !== this.scope) {
      for (const id of [...this.active.keys()]) await this.deactivate(id);
      this.scope = scope;
      this.selection.initialize('tools', [...this.catalog.keys()]);
    }
    if (!this.host) return;
    const installed = new Set(this.selection.list('tools'));
    const removed = this.selection.removedTools();
    const hasMembers = (id: string) => {
      const names = this.active.get(id)?.tools.map(t => t.name) || this.members(id).map(t => t.name);
      return names.length === 0 || names.some(name => !removed.has(name));
    };
    for (const id of [...this.active.keys()]) if (!installed.has(id) || !hasMembers(id)) await this.deactivate(id);
    this.registry.syncToolInstallations();
    for (const id of installed) if (this.catalog.has(id) && !this.active.has(id) && hasMembers(id)) {
      try { await this.activate(id); } catch (error) { this.logger.warn(`Extension ${id} unavailable: ${String(error)}`); }
    }
  }
  private members(id: string) {
    return (this.catalog.get(id)?.tools || []).filter(t => !t.platforms || t.platforms.includes(process.platform));
  }
  async toolCatalog() {
    await this.refresh();
    const packs = this.policy ? await this.policy.filterAvailable('plugin', [...this.catalog.values()], e => e.id) : [...this.catalog.values()];
    const removed = this.selection.removedTools();
    const installed = new Set(this.selection.list('tools')), loaded = new Set(this.registry.getAll().map(t => t.name));
    const result = new Map<string, ToolListItem>(this.registry.catalog().map(({ execute: _execute, parameters: _parameters, ...tool }) => [tool.name, tool]));
    // Hide disallowed bundled resources even if they were active before an enterprise policy update.
    const allowed = new Set(packs.map(p => p.id));
    for (const pack of this.catalog.values()) if (!allowed.has(pack.id)) for (const tool of this.members(pack.id)) result.delete(tool.name);
    for (const pack of packs) for (const tool of this.members(pack.id)) {
      const { platforms: _platforms, ...metadata } = tool;
      result.set(tool.name, { ...metadata, packageId: pack.id,
        installed: installed.has(pack.id) && !removed.has(tool.name), loaded: loaded.has(tool.name) });
    }
    return [...result.values()];
  }
  async setToolInstalled(name: string, installed: boolean): Promise<void> {
    await this.serial(async () => {
      await this.reconcile();
      const pack = [...this.catalog.values()].find(p => this.members(p.id).some(t => t.name === name));
      if (!pack && !this.registry.knows(name)) throw new Error('Unknown tool');
      if (pack) await this.policy?.assert('plugin', pack.id);
      const restore = this.selection.setToolInstalled(name, installed, pack ? { id: pack.id, names: this.members(pack.id).map(t => t.name) } : undefined);
      try {
        if (installed && pack && !this.active.has(pack.id)) await this.activate(pack.id);
        await this.reconcile();
      } catch (error) { restore(); this.registry.syncToolInstallations(); throw error; }
    });
  }
  async list() {
    await this.refresh();
    const entries = [...this.catalog.values()].map(({ directory: _directory, ...m }) => ({ ...m,
      installed: this.selection.has('tools', m.id), loaded: this.active.has(m.id),
      tools: this.active.get(m.id)?.tools.filter(t => this.registry.has(t.name)).map(t => t.name) || [],
    }));
    return this.policy ? this.policy.filterAvailable('plugin', entries, e => e.id) : entries;
  }
  async install(id: string): Promise<void> {
    await this.serial(async () => {
      await this.reconcile();
      await this.policy?.assert('plugin', id);
      if (!this.catalog.has(id)) throw new Error('Unknown extension');
      const existing = this.active.has(id);
      if (!existing) await this.activate(id);
      try { this.selection.installToolPackage(id, this.members(id).map(t => t.name)); this.registry.syncToolInstallations(); }
      catch (error) { if (!existing) await this.deactivate(id); throw error; }
    });
  }
  async uninstall(id: string): Promise<void> {
    await this.serial(async () => {
      await this.reconcile();
      await this.policy?.assert('plugin', id);
      this.selection.set('tools', id, false);
      await this.deactivate(id);
    });
  }
  async reload(id: string): Promise<void> {
    await this.serial(async () => {
      await this.reconcile();
      await this.policy?.assert('plugin', id);
      if (!this.selection.has('tools', id)) throw new Error('Extension is not installed');
      const old = this.active.get(id);
      const next = await this.create(id, true);
      // Validate before revoking the previous generation. No tool can escape ownership.
      try { this.registry.validateOwned(id, next.tools); }
      catch (error) { await next.dispose?.(); throw error; }
      await this.deactivate(id);
      try { this.register(id, next); }
      catch (error) { await next.dispose?.(); if (old) await this.activate(id); throw error; }
    });
  }
  private async create(id: string, fresh = false): Promise<ExtensionInstance> {
    const entry = this.catalog.get(id);
    if (!entry || !this.host) throw new Error('Extension host unavailable');
    const path = this.contained(entry.directory, entry.entry);
    if (fresh) for (const file of Object.keys(require.cache)) if (file.startsWith(entry.directory + sep)) delete require.cache[file];
    const mod = require(path) as { activate?: (host: ExtensionHost) => ExtensionInstance | Promise<ExtensionInstance> };
    if (typeof mod.activate !== 'function') throw new Error('Missing extension entry point');
    const instance = await mod.activate(this.host);
    if (!instance || !Array.isArray(instance.tools)) throw new Error('Invalid extension instance');
    return instance;
  }
  private register(id: string, instance: ExtensionInstance): void {
    const scope = this.selection.scope;
    this.registry.registerOwned(id, instance.tools.map(tool => ({ ...tool, execute: async (args, ctx) => {
      if (scope !== this.selection.scope || !this.selection.has('tools', id)) return { success: false, error: 'Extension is no longer installed for this identity' };
      await this.policy?.assert('plugin', id);
      if (ctx.signal?.aborted || scope !== this.selection.scope || !this.selection.has('tools', id)) return { success: false, error: 'Extension invocation cancelled' };
      return tool.execute(args, ctx);
    } })), true);
    this.active.set(id, instance);
  }
  private async activate(id: string): Promise<void> {
    await this.policy?.assert('plugin', id);
    const instance = await this.create(id);
    try { this.register(id, instance); } catch (error) { await instance.dispose?.(); throw error; }
  }
  private async deactivate(id: string): Promise<void> {
    this.registry.unregisterOwner(id);
    const instance = this.active.get(id); this.active.delete(id);
    await instance?.dispose?.();
  }
  async guidance(names: Set<string>): Promise<string> {
    await this.refresh();
    const result: string[] = [];
    for (const [id, instance] of this.active) {
      if (!instance.tools.some(tool => names.has(tool.name) && this.registry.has(tool.name))) continue;
      const manifest = this.catalog.get(id)!;
      for (const path of manifest.platformGuides?.[process.platform] || manifest.guides) result.push(readFileSync(this.contained(manifest.directory, path), 'utf8'));
    }
    return result.join('\n\n');
  }
  async onModuleDestroy(): Promise<void> { await this.serial(async () => { for (const id of [...this.active.keys()]) await this.deactivate(id); }); }
}
