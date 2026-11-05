import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { PluginManifest } from './types.js';
import type { PluginApi } from './plugin-api.js';

export interface PluginLoadOptions {
  directories: string[];
  autoActivate?: boolean;
}

/** M20: 包装异步操作以添加超时保护 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

/**
 * 校验 candidate 路径是否仍位于 trustedRoots 之一内（规范化后比较）。
 * 拒绝 baseDir 通过 `..` 路径穿越逃逸到受信任插件根目录之外。
 */
function isWithinTrustedRoots(candidate: string, trustedRoots: string[]): boolean {
  return trustedRoots.some(root => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
}

const manifestSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().min(1),
  type: z.enum(['channel', 'provider', 'tool', 'tts', 'stt', 'image-generation',
    'video-generation', 'music-generation', 'realtime-voice', 'realtime-transcription',
    'model-catalog', 'memory', 'hook', 'command']),
  entry: z.string().min(1),
  description: z.string().optional(),
  dependencies: z.record(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
});

function validateEntry(entry: string): void {
  if (!entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(entry)) {
    throw new Error(`Invalid plugin entry path: ${entry}`);
  }
}

async function canonicalRoots(directories: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const directory of directories) {
    try {
      const root = await fs.realpath(directory);
      if (!(await fs.stat(root)).isDirectory()) throw new Error(`Plugin root is not a directory: ${directory}`);
      if (!roots.includes(root)) roots.push(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return roots;
}

async function resolveEntry(manifest: PluginManifest, roots: string[]): Promise<string> {
  validateEntry(manifest.entry);
  if (!roots.length) throw new Error(`Plugin "${manifest.name}" has no trusted plugin root configured`);
  const base = await fs.realpath(manifest.baseDir || process.cwd());
  if (!isWithinTrustedRoots(base, roots)) throw new Error(`Plugin "${manifest.name}" baseDir escapes trusted plugin root`);
  const entry = await fs.realpath(path.resolve(base, manifest.entry));
  // Follow symlinks/junctions before checking; a lexical path check is insufficient.
  if (!isWithinTrustedRoots(entry, [base])) throw new Error(`Plugin "${manifest.name}" entry escapes plugin directory`);
  if (!(await fs.stat(entry)).isFile()) throw new Error(`Plugin "${manifest.name}" entry is not a file`);
  return entry;
}

export class PluginLoader {
  private plugins: Map<string, PluginApi> = new Map();
  /** H9: 加载锁 — 防止并发 load 同名插件导致 TOCTOU 竞态 */
  private loadingPromises: Map<string, Promise<PluginApi>> = new Map();
  /** H-E3 fix: 受信任的插件根目录列表，baseDir 解析后的路径必须落在其中 */
  private trustedRoots: string[] = [];

  /** H-E3 fix: 显式设置受信任插件根目录 */
  setTrustedRoots(directories: string[]): void {
    this.trustedRoots = (directories || []).map(d => path.resolve(d));
  }

  async discover(directories: string[]): Promise<PluginManifest[]> {
    if (!directories || directories.length === 0) {
      throw new Error('PluginLoader.discover: no directories specified');
    }
    const roots = await canonicalRoots(directories);
    const manifests = new Map<string, PluginManifest>();
    const visited = new Set<string>();
    const inspect = async (directory: string) => {
      let filename: string;
      try { filename = await fs.realpath(path.join(directory, 'plugin.json')); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return;
        throw error;
      }
      if (!isWithinTrustedRoots(filename, roots)) throw new Error(`Plugin manifest escapes trusted plugin root: ${directory}`);
      if (visited.has(filename)) return;
      visited.add(filename);
      let manifest: PluginManifest;
      try {
        const parsed = manifestSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
        // baseDir is derived from the manifest's actual location, never from JSON input.
        manifest = { ...parsed, baseDir: path.dirname(filename) } as PluginManifest;
      } catch (error) { throw new Error(`Invalid plugin manifest ${filename}: ${String(error)}`); }
      await resolveEntry(manifest, roots);
      if (manifests.has(manifest.name)) throw new Error(`Duplicate plugin name: ${manifest.name}`);
      manifests.set(manifest.name, manifest);
    };
    for (const root of roots) {
      await inspect(root);
      const children = await fs.readdir(root, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.isDirectory() || child.isSymbolicLink()) await inspect(path.join(root, child.name));
      }
    }
    this.setTrustedRoots(roots);
    return [...manifests.values()];
  }

  async load(manifest: PluginManifest): Promise<PluginApi> {
    // H9: 如果同名插件正在加载，返回同一个 Promise 避免竞态
    const existing = this.loadingPromises.get(manifest.name);
    if (existing) return existing;

    const loadPromise = this._doLoad(manifest);
    this.loadingPromises.set(manifest.name, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.loadingPromises.delete(manifest.name);
    }
  }

  private async _doLoad(manifest: PluginManifest): Promise<PluginApi> {
    let api: PluginApi = { manifest };
    if (manifest.entry) {
      const entryPath = await resolveEntry(manifest, await canonicalRoots(this.trustedRoots));
      const entryUrl = pathToFileURL(entryPath).href;

      try {
        // M20: 为动态 import 添加 30 秒超时，防止恶意插件永久阻塞
        const module = await withTimeout(import(entryUrl), 30_000, `Plugin import: ${manifest.name}`);
        const def = module.default;
        const isPlainObject = def && typeof def === 'object' && !Array.isArray(def);
        if (isPlainObject) {
          api = {
            manifest,
            channel: def.channel,
            provider: def.provider,
            tts: def.tts,
            stt: def.stt,
          };
        } else if (module.channel || module.provider || module.tts || module.stt) {
          api = { manifest, channel: module.channel, provider: module.provider, tts: module.tts, stt: module.stt };
        }
      } catch (error) {
        console.error(`Failed to load plugin entry: ${manifest.entry}`, error);
        throw error;
      }
    }

    // H9 + M21: 同名插件已存在时先清理旧资源（channel + provider + tts + stt），避免连接泄漏
    const existing = this.plugins.get(manifest.name);
    if (existing) {
      await this._cleanupPlugin(existing);
    }
    this.plugins.set(manifest.name, api);
    return api;
  }

  /** M21: 清理插件的所有资源连接（channel + provider + tts + stt） */
  private async _cleanupPlugin(api: PluginApi): Promise<void> {
    if (api.channel) {
      try { await withTimeout(api.channel.disconnect(), 10_000, `Channel disconnect: ${api.manifest.name}`); } catch { /* ignore */ }
    }
    // M21: provider/tts/stt 虽然没有标准 disconnect 方法，但如果存在则调用
    // PluginApi 无字符串索引签名，直接 as Record<string, unknown> 会触发 TS2352，先转 unknown 再转目标类型
    const anyApi = api as unknown as Record<string, unknown>;
    for (const key of ['provider', 'tts', 'stt']) {
      const component = anyApi[key];
      if (component && typeof component === 'object' && 'disconnect' in component) {
        try { await withTimeout((component as { disconnect(): Promise<void> }).disconnect(), 10_000, `${key} disconnect: ${api.manifest.name}`); } catch { /* ignore */ }
      }
    }
  }

  async unload(name: string): Promise<void> {
    const api = this.plugins.get(name);
    if (api) {
      await this._cleanupPlugin(api);
      if (this.plugins.get(name) === api) {
        this.plugins.delete(name);
      }
    }
  }

  list(): PluginApi[] {
    return Array.from(this.plugins.values());
  }

  get(name: string): PluginApi | undefined {
    // reload 期间 get() 不应返回正在被清理的旧 api。
    // _doLoad 在 await _cleanupPlugin(existing) 与 this.plugins.set(name, api) 之间存在窗口期，
    // 此时 this.plugins.get(name) 仍返回旧 api，但旧 api 的 channel/provider 等资源已被 disconnect，
    // 调用方拿到的是一个半失效的 api。修复：若该 name 正在 loading（即 reload 进行中），
    // 返回 undefined 表示当前不可用，调用方可选择重试或走异步 load() 等待完成。
    if (this.loadingPromises.has(name)) {
      return undefined;
    }
    return this.plugins.get(name);
  }

  /**
   * 异步获取插件，若插件正在 reload 则等待 reload 完成后返回新 api。
   * 提供给需要确保拿到最新 api 的调用方使用。
   */
  async getAsync(name: string): Promise<PluginApi | undefined> {
    const loading = this.loadingPromises.get(name);
    if (loading) {
      try {
        await loading;
      } catch {
        // reload 失败则返回当前 map 中的状态（可能是旧 api 或 undefined）
      }
    }
    return this.plugins.get(name);
  }
}
