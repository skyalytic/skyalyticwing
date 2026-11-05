import { Injectable, Logger, Optional } from '@nestjs/common';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { resolve, dirname, join, basename, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import Module from 'node:module';
import type { ToolDefinition } from '@skyalyticwing/shared';

/** 插件沙箱默认阻断的 Node 模块（防插件直接 spawn 进程） */
const DEFAULT_BLOCKED_MODULES = new Set<string>([
  'child_process',
  'cluster',
  'vm',
]);

/** 插件可导出的合法形态 */
interface PluginModuleShape {
  tools?: ToolDefinition[];
  default?: ToolDefinition[] | { tools?: ToolDefinition[] };
  // 以下字段用于 ClawHub 安装后合并到注册元数据
  activate?: (api: unknown) => void;
  deactivate?: () => void;
  execute?: (...args: unknown[]) => unknown;
  hooks?: unknown;
  id?: string;
}

/** 插件清单（来自 package.json 的 skyalyticwing 字段或 plugin.json） */
export interface PluginManifest {
  main?: string;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  type?: string;
  configSchema?: unknown;
  [key: string]: unknown;
}

/** discoverPlugins 返回的发现条目 */
export interface DiscoveredPlugin {
  path: string;
  manifest: PluginManifest;
  name: string;
}

/** ClawHub 安装结果 */
export interface ClawHubInstallResult {
  success: boolean;
  packageName?: string;
  version?: string;
  path?: string;
  message?: string;
}

/** 下载安装的元数据 */
export interface DownloadMetadata {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  type?: string;
  format?: string;
  sha256?: string;
  pluginApiRange?: { min?: string };
}

/** 最大下载重定向次数（C-C11 / H-D10） */
const MAX_DOWNLOAD_REDIRECTS = 3;

/**
 * PluginLoaderService - 插件加载器（全量移植自 plugin-manager.cjs）
 *
 * 职责：
 *   1. 沙箱化加载插件模块（Module._load 拦截阻断危险模块）
 *   2. 并发保护（loadingPromises Map 防止同一路径重复加载导致 TOCTOU）
 *   3. INT-1 路径校验：仅允许加载受信任插件目录内的插件，防止 RCE
 *   4. 插件发现（discoverPlugins）：扫描受信任目录 + node_modules
 *   5. 清单校验（validatePluginStructure）：读取 package.json/plugin.json
 *   6. ClawHub 安装辅助：安全 ZIP 解压、下载校验、版本比较
 *
 * 插件模块可导出：
 *   - ToolDefinition[]（module.exports 为数组）
 *   - { tools: ToolDefinition[] }
 *   - { default: ToolDefinition[] | { tools: ToolDefinition[] } }
 */
@Injectable()
export class PluginLoaderService {
  private readonly logger = new Logger(PluginLoaderService.name);
  /** pluginId → 绝对路径 */
  private readonly pathById = new Map<string, string>();
  /** 绝对路径 → 进行中的加载 Promise（防 TOCTOU） */
  private readonly loadingPromises = new Map<string, Promise<ToolDefinition[]>>();
  /** 沙箱阻断模块集合 */
  private readonly blockedModules: Set<string> = new Set(DEFAULT_BLOCKED_MODULES);
  /** 插件数据目录（用于 INT-1 校验和 ClawHub 安装） */
  private readonly baseDataDir: string;
  private get dataDir() { return this.resourcePolicy?.localResourceRoot?.(this.baseDataDir) || this.baseDataDir; }

  constructor(@Optional() private readonly resourcePolicy?: LocalResourcePolicy) {
    this.baseDataDir = this.resolveDataDir();
  }

  /** 解析插件数据目录 */
  private resolveDataDir(): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    if (envDir) return join(envDir, 'plugin-data');
    return join(homedir(), '.skyalyticwing', 'plugin-data');
  }

  /** 获取数据目录（供 PluginService 共享使用） */
  getDataDir(): string {
    return this.dataDir;
  }

  /** 运行期调整沙箱阻断列表 */
  setBlockedModules(modules: string[]): void {
    this.blockedModules.clear();
    for (const m of modules) this.blockedModules.add(m);
  }

  /**
   * 加载插件模块并提取工具定义。
   *
   * 安全：
   *   - INT-1：仅允许加载受信任插件目录内的插件路径，防止 AI 工具 plugin_install 任意 require() 模块导致 RCE
   *   - 沙箱：拦截源自插件目录的 require，阻断危险模块（child_process/cluster/vm）
   *   - 并发：loadingPromises Map 对同一插件路径的并发加载去重
   *
   * @param pluginPath 插件入口文件绝对路径
   * @param pluginId   插件唯一 ID（用于 unload 时清理缓存）
   */
  async load(pluginPath: string, pluginId: string): Promise<ToolDefinition[]> {
    const abs = resolve(pluginPath);
    if (abs.includes('\0')) {
      throw new Error('Plugin path must not contain null bytes');
    }

    // INT-1：路径校验 - 仅允许加载受信任的插件目录内的插件
    if (!this.isPathTrustedPluginDir(abs)) {
      throw new Error(
        `SECURITY [INT-1]: 拒绝加载插件，路径不在受信任的插件目录内: ${abs}`,
      );
    }

    if (!existsSync(abs)) {
      throw new Error(`Plugin not found: ${abs}`);
    }

    // TOCTOU 去重：同一路径并发加载复用同一 Promise
    const existing = this.loadingPromises.get(abs);
    if (existing) return existing;

    const promise = (async (): Promise<ToolDefinition[]> => {
      const tools = this.loadSandboxed(abs, pluginId);
      this.pathById.set(pluginId, abs);
      this.logger.log(`Loaded plugin ${pluginId} from ${abs} (${tools.length} tools)`);
      return tools;
    })().finally(() => this.loadingPromises.delete(abs));

    this.loadingPromises.set(abs, promise);
    return promise;
  }

  /** 卸载插件：清除其模块缓存（后续 require 会重新加载） */
  unload(pluginId: string): void {
    const abs = this.pathById.get(pluginId);
    this.pathById.delete(pluginId);
    if (!abs) return;
    this.clearCache(abs);
    this.logger.log(`Unloaded plugin ${pluginId}`);
  }

  /**
   * 加载插件模块并返回原始导出（含 activate/deactivate/healthCheck 等生命周期函数）。
   *
   * 与 load() 的区别：load() 仅返回提取的 ToolDefinition[]，
   * loadModule() 返回原始模块导出，供 PluginService 获取插件生命周期钩子。
   *
   * 安全：同样执行 INT-1 路径校验 + 沙箱拦截。
   *
   * @param pluginPath 插件入口文件绝对路径
   * @param pluginId   插件唯一 ID
   */
  async loadModule(pluginPath: string, pluginId: string): Promise<unknown> {
    const abs = resolve(pluginPath);
    if (abs.includes('\0')) {
      throw new Error('Plugin path must not contain null bytes');
    }
    // INT-1：路径校验
    if (!this.isPathTrustedPluginDir(abs)) {
      throw new Error(
        `SECURITY [INT-1]: 拒绝加载插件，路径不在受信任的插件目录内: ${abs}`,
      );
    }
    if (!existsSync(abs)) {
      throw new Error(`Plugin not found: ${abs}`);
    }
    const pluginDir = dirname(abs);
    this.pathById.set(pluginId, abs);
    const modExports = this.sandboxedRequire(abs, pluginDir);
    this.logger.log(`Loaded plugin module ${pluginId} from ${abs}`);
    return modExports;
  }

  // ─── INT-1 路径校验 ──────────────────────────────────────────

  /**
   * 判断路径是否在受信任的插件目录内（INT-1 安全校验）。
   *
   * 受信任根目录：
   *   - <dataDir>/plugins
   *   - <dataDir>/extensions
   *   - <appDir>/plugins
   *   - <appDir>/extensions
   *
   * 严格匹配：要么路径恰好等于根目录，要么路径以根目录+分隔符开头（避免兄弟前缀绕过）。
   */
  isPathTrustedPluginDir(resolvedPath: string): boolean {
    const allowedRoots = this.pluginRoots();
    const isWin = platform() === 'win32';
    const norm = (p: string) => (isWin ? p.toLowerCase() : p);
    const resolvedNorm = norm(resolve(resolvedPath));
    for (const root of allowedRoots) {
      const rootNorm = norm(root);
      if (resolvedNorm === rootNorm || resolvedNorm.startsWith(rootNorm + sep)) {
        // Resolve junctions and symlinks as well as lexical traversal.
        if (!existsSync(root) || !existsSync(resolvedPath)) return false;
        const realRoot = norm(realpathSync(root)), realPath = norm(realpathSync(resolvedPath));
        return realRoot === rootNorm && (realPath === realRoot || realPath.startsWith(realRoot + sep));
      }
    }
    return false;
  }

  pluginRoots(): string[] {
    if (this.dataDir !== this.baseDataDir) return [join(this.dataDir, 'plugins'), join(this.dataDir, 'extensions')];
    return [...new Set([
      join(this.dataDir, 'plugins'), join(this.dataDir, 'extensions'),
      join(this.dataDir, '..', 'plugins'), join(this.dataDir, '..', 'extensions'),
      join(this.resolveAppDir(), 'plugins'), join(this.resolveAppDir(), 'extensions'),
    ].map(p => resolve(p)))];
  }

  /** 解析应用主目录（用于定位 appDir/plugins 等受信任根） */
  private resolveAppDir(): string {
    // require.main 在 NestJS 运行时可能为 dist/main.js
    const mainFile = require.main?.filename ?? __dirname;
    return dirname(mainFile);
  }

  // ─── 插件发现 ──────────────────────────────────────────────

  /**
   * 发现受信任目录中的所有插件（移植自 .cjs discoverPlugins）。
   *
   * 搜索目录：
   *   - <dataDir>/plugins、<dataDir>/extensions
   *   - <dataDir>/../plugins、<dataDir>/../extensions（项目根目录）
   *   - <appDir>/plugins、<appDir>/extensions
   *   - <appDir>/node_modules/@skyalyticwing-* 和 skyalyticwing-*
   *
   * 安全：路径遍历防护 - 解析后的路径必须以 dataDir 为前缀。
   */
  discoverPlugins(): DiscoveredPlugin[] {
    const searchDirs = this.pluginRoots();

    const discovered: DiscoveredPlugin[] = [];
    const seen = new Set<string>();

    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue;
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) continue;
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const entryPath = join(dir, entry);
          try {
            const entryStat = lstatSync(entryPath);
            if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) continue;
            if (seen.has(entryPath)) continue;
            seen.add(entryPath);
            // 路径遍历防护
            const resolvedEntry = resolve(entryPath);
            if (!this.isPathTrustedPluginDir(resolvedEntry)) {
              continue;
            }
            const manifest = this.validatePluginStructure(resolvedEntry);
            if (manifest) {
              discovered.push({
                path: entryPath,
                manifest,
                name: manifest.name ?? entry,
              });
            }
          } catch {
            // 跳过无效条目
          }
        }
      } catch (e) {
        this.logger.warn(`Error scanning plugin dir ${dir}: ${errMsg(e)}`);
      }
    }
    this.logger.log(`Discovered ${discovered.length} plugins`);
    return discovered;
  }

  /**
   * 校验插件目录结构并提取清单（移植自 .cjs _validatePluginStructure）。
   *
   * 优先读取 package.json 的 skyalyticwing 字段或含 skyalyticwing-plugin 关键字的包；
   * 其次读取 plugin.json。若均不存在则返回 null。
   */
  validatePluginStructure(pluginDir: string): PluginManifest | null {
    const pkgJsonPath = join(pluginDir, 'package.json');
    const pluginJsonPath = join(pluginDir, 'plugin.json');
    let manifest: PluginManifest | null = null;

    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (
          pkg.skyalyticwing ||
          (pkg.keywords && Array.isArray(pkg.keywords) && pkg.keywords.includes('skyalyticwing-plugin'))
        ) {
          manifest = {
            ...(pkg.skyalyticwing ?? {}),
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            author: pkg.author,
            main: pkg.skyalyticwing?.main || pkg.main,
          };
        }
      } catch {
        // 非法 package.json，忽略
      }
    }

    if (!manifest && existsSync(pluginJsonPath)) {
      try {
        manifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
      } catch {
        // 非法 plugin.json，忽略
      }
    }

    if (manifest && !manifest.id) {
      manifest.id = manifest.name ?? basename(pluginDir);
    }

    return manifest;
  }

  // ─── ClawHub 安装辅助 ──────────────────────────────────────

  /**
   * 安全解压 ZIP 文件（移植自 .cjs _extractZipSecure）。
   *
   * 安全防护：
   *   - ZIP 炸弹检测：最大条目数 10000、最大未压缩总大小 100MB、单文件最大 50MB
   *   - 路径遍历防护：H-D11 严格边界匹配，防止兄弟前缀绕过
   *   - 支持存储（method=0）和 deflate（method=8）压缩
   */
  extractZipSecure(zipPath: string, targetDir: string): {
    success: boolean;
    files?: string[];
    count?: number;
    error?: string;
  } {
    const MAX_ENTRIES = 10000;
    const MAX_UNCOMPRESSED_SIZE = 100 * 1024 * 1024; // 100MB
    const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024; // 50MB

    try {
      const buffer = readFileSync(zipPath);

      if (buffer.length < 22) {
        return { success: false, error: 'Invalid ZIP file: too small' };
      }

      // 查找 End of Central Directory
      let eocdOffset = -1;
      for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
          eocdOffset = i;
          break;
        }
      }
      if (eocdOffset === -1) {
        return { success: false, error: 'Invalid ZIP: EOCD not found' };
      }

      const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
      const cdEntryCount = buffer.readUInt16LE(eocdOffset + 10);

      // ZIP 炸弹：条目过多
      if (cdEntryCount > MAX_ENTRIES) {
        return { success: false, error: `ZIP bomb detected: too many entries (${cdEntryCount})` };
      }

      let totalUncompressed = 0;
      let offset = cdOffset;
      const extractedFiles: string[] = [];
      const targetBase = resolve(targetDir);
      const isWin = platform() === 'win32';
      const normTarget = isWin ? targetBase.toLowerCase() : targetBase;

      for (let e = 0; e < cdEntryCount; e++) {
        if (offset + 46 > buffer.length) break;

        const sig = buffer.readUInt32LE(offset);
        if (sig !== 0x02014b50) break;

        const compressionMethod = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);

        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;

        // 路径遍历检查（H-D11：严格边界匹配防止兄弟前缀绕过）
        const normalizedPath = resolve(join(targetDir, name));
        const normPath = isWin ? normalizedPath.toLowerCase() : normalizedPath;
        if (normPath !== normTarget && !normPath.startsWith(normTarget + sep)) {
          this.logger.warn(`Path traversal blocked: ${name}`);
          continue;
        }

        // 跳过目录条目
        if (name.endsWith('/')) continue;

        // 单文件大小检查
        if (uncompressedSize > MAX_SINGLE_FILE_SIZE) {
          this.logger.warn(`File too large, skipping: ${name} (${uncompressedSize} bytes)`);
          continue;
        }
        totalUncompressed += uncompressedSize;
        if (totalUncompressed > MAX_UNCOMPRESSED_SIZE) {
          return { success: false, error: 'ZIP bomb detected: total uncompressed size exceeds limit' };
        }

        // 读取本地文件头
        if (localHeaderOffset + 30 > buffer.length) continue;
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const fileData = buffer.subarray(dataOffset, dataOffset + compressedSize);

        // 解压
        let content: Buffer;
        if (compressionMethod === 0) {
          content = fileData;
        } else if (compressionMethod === 8) {
          try {
            content = inflateRawSync(fileData);
          } catch (inflateErr) {
            this.logger.warn(`Failed to decompress ${name}: ${errMsg(inflateErr)}`);
            continue;
          }
        } else {
          this.logger.warn(`Unsupported compression method ${compressionMethod} for: ${name}`);
          continue;
        }

        // 写入文件
        const filePath = join(targetDir, name);
        try {
          const fileDir = dirname(filePath);
          if (!existsSync(fileDir)) {
            mkdirSync(fileDir, { recursive: true });
          }
          writeFileSync(filePath, content);
          extractedFiles.push(name);
        } catch (writeErr) {
          this.logger.warn(`Failed to write ${name}: ${errMsg(writeErr)}`);
        }
      }

      this.logger.log(`ZIP extracted: ${extractedFiles.length} files from ${zipPath}`);
      return { success: true, files: extractedFiles, count: extractedFiles.length };
    } catch (e) {
      return { success: false, error: `ZIP extraction error: ${errMsg(e)}` };
    }
  }

  /**
   * 校验下载 URL 是否允许（C-C11 / H-D10）。
   *
   * 规则：
   *   - 仅允许 http/https 协议
   *   - 主机名必须与 CLAWHUB_URL 一致（防 MITM 跨域重定向和 SSRF）
   */
  allowedDownloadHost(urlStr: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hubUrl = process.env['CLAWHUB_URL'] ?? 'https://clawhub.ai';
    let hubHost: string;
    try {
      hubHost = new URL(hubUrl).hostname;
    } catch {
      hubHost = hubUrl.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    }
    return parsed.hostname === hubHost;
  }

  /**
   * 下载并安装插件（移植自 .cjs _downloadAndInstallPlugin）。
   *
   * 安全：
   *   - 下载前校验 URL 协议和主机（_allowedDownloadHost）
   *   - 重定向限制（最多 3 次），且重定向目标也须通过主机校验
   *   - SHA-256 完整性校验（若元数据提供）
   *   - 下载大小限制（50MB）
   */
  async downloadAndInstallPlugin(
    artifactUrl: string,
    packageName: string,
    pluginDir: string,
    metadata: DownloadMetadata,
    redirectCount = 0,
  ): Promise<ClawHubInstallResult> {
    // C-C11 / H-D10：下载前校验 URL 协议和主机
    if (!this.allowedDownloadHost(artifactUrl)) {
      throw new Error(`Download URL host not allowed (must match CLAWHUB_URL): ${artifactUrl}`);
    }

    const targetPath = join(pluginDir, packageName);
    return new Promise<ClawHubInstallResult>((resolve, reject) => {
      const req = (artifactUrl.startsWith('https') ? httpsRequest : httpRequest)(
        artifactUrl,
        { timeout: 60000 },
        (res) => {
          // 处理重定向
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectCount + 1 > MAX_DOWNLOAD_REDIRECTS) {
              return reject(new Error(`Too many redirects (max ${MAX_DOWNLOAD_REDIRECTS})`));
            }
            let nextUrl: string;
            try {
              nextUrl = new URL(res.headers.location, artifactUrl).toString();
            } catch {
              return reject(new Error(`Invalid redirect Location header: ${res.headers.location}`));
            }
            if (!this.allowedDownloadHost(nextUrl)) {
              return reject(new Error(`Redirect target host not allowed (cross-domain blocked): ${nextUrl}`));
            }
            this.downloadAndInstallPlugin(nextUrl, packageName, pluginDir, metadata, redirectCount + 1)
              .then(resolve)
              .catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Download failed with status: ${res.statusCode}`));
          }

          const chunks: Buffer[] = [];
          let totalSize = 0;
          const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50MB
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            totalSize += chunk.length;
            if (totalSize > MAX_DOWNLOAD_SIZE) {
              try { res.destroy(); } catch {}
              reject(new Error('插件下载响应过大(>50MB)'));
            }
          });
          res.on('end', () => {
            try {
              const buffer = Buffer.concat(chunks);

              // SHA-256 完整性校验
              if (metadata && metadata.sha256) {
                const hash = createHash('sha256').update(buffer).digest('hex');
                if (hash !== metadata.sha256) {
                  return reject(new Error('Integrity check failed: SHA-256 mismatch'));
                }
                this.logger.log(`Integrity check passed for ${packageName}`);
              }

              // 保存制品
              if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });

              if (metadata && (metadata.format === 'legacy-zip' || metadata.format === 'npm-pack')) {
                const zipPath = join(targetPath, 'package.zip');
                writeFileSync(zipPath, buffer);
                const extractResult = this.extractZipSecure(zipPath, targetPath);
                if (!extractResult.success) {
                  this.logger.warn(`ZIP extraction failed: ${extractResult.error}`);
                }
              } else {
                // 保存为 JS 模块
                const mainFile = join(targetPath, 'index.cjs');
                writeFileSync(mainFile, buffer);
              }

              const version = metadata?.version ?? '1.0.0';
              this.logger.log(`Plugin installed from ClawHub: ${packageName} v${version}`);
              resolve({
                success: true,
                packageName,
                version,
                path: targetPath,
                message: 'Plugin installed successfully from ClawHub',
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Download timed out'));
      });
    });
  }

  /**
   * 比较语义化版本号（移植自 .cjs _compareVersions）。
   * @returns 1 if a > b, -1 if a < b, 0 if equal
   */
  compareVersions(a: string, b: string): number {
    const pa = (a || '0.0.0').split('.');
    const pb = (b || '0.0.0').split('.');
    for (let i = 0; i < 3; i++) {
      const na = parseInt(pa[i] || '0', 10);
      const nb = parseInt(pb[i] || '0', 10);
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  // ─── 沙箱加载（保留原有实现） ──────────────────────────────

  /** 沙箱化加载：拦截源自插件目录的 require，阻断危险模块 */
  private loadSandboxed(absPath: string, pluginId: string): ToolDefinition[] {
    const pluginDir = dirname(absPath);
    const modExports = this.sandboxedRequire(absPath, pluginDir);
    return this.extractTools(modExports, pluginId);
  }

  /**
   * 使用 Module._load 拦截实现沙箱 require。
   * 拦截范围：仅当 require 的父模块位于插件目录树下时，才检查阻断列表。
   * 拦截在加载完成后立即还原，避免影响全局 require。
   */
  private sandboxedRequire(absPath: string, pluginDir: string): unknown {
    const nativeModule = Module as unknown as {
      _load: (request: string, parent: Module | undefined, isMain?: boolean) => unknown;
      _cache: Record<string, NodeModule>;
    };
    const origLoad = nativeModule._load;
    const self = this;

    const wrappedLoad = function (
      this: unknown,
      request: string,
      parent: Module | undefined,
      isMain?: boolean,
    ): unknown {
      const parentFile = parent?.filename;
      if (
        parentFile &&
        (parentFile.startsWith(pluginDir + '\\') || parentFile.startsWith(pluginDir + '/') || parentFile === pluginDir) &&
        self.blockedModules.has(request.replace(/^node:/, ''))
      ) {
        throw new Error(
          `Plugin sandbox blocked module '${request}' (required from ${parentFile})`,
        );
      }
      return origLoad.call(this, request, parent, isMain);
    };

    // Cache belongs to this loader; unload clears it. Reading lifecycle and tools
    // must not execute a module twice during one installation.
    nativeModule._load = wrappedLoad;
    try {
      // 使用基于插件文件路径的 require，确保相对路径解析正确
      return nativeModule._load(absPath, undefined, false);
    } finally {
      nativeModule._load = origLoad;
    }
  }

  /** 从插件导出中提取 ToolDefinition[] */
  private extractTools(modExports: unknown, pluginId: string): ToolDefinition[] {
    const tools = this.collectTools(modExports);
    if (tools.length === 0) {
      throw new Error(`Plugin '${pluginId}' exports no tools`);
    }
    // 校验每个工具具备必要字段
    for (const t of tools) {
      if (!t || typeof t.name !== 'string' || typeof t.execute !== 'function') {
        throw new Error(`Plugin '${pluginId}' contains an invalid tool definition`);
      }
      if (typeof t.dangerous !== 'boolean') t.dangerous = false;
      if (typeof t.category !== 'string') t.category = 'plugin';
    }
    return tools;
  }

  private collectTools(modExports: unknown): ToolDefinition[] {
    if (Array.isArray(modExports)) {
      return modExports as ToolDefinition[];
    }
    const shape = modExports as PluginModuleShape | undefined;
    if (shape && Array.isArray(shape.tools)) {
      return shape.tools;
    }
    if (shape && shape.default) {
      if (Array.isArray(shape.default)) return shape.default as ToolDefinition[];
      if (Array.isArray((shape.default as { tools?: ToolDefinition[] }).tools)) {
        return (shape.default as { tools: ToolDefinition[] }).tools;
      }
    }
    return [];
  }

  /** 清除插件及其子模块的 require 缓存 */
  private clearCache(absPath: string): void {
    const nativeModule = Module as unknown as { _cache: Record<string, NodeModule> };
    const pluginDir = dirname(absPath);
    for (const key of Object.keys(nativeModule._cache)) {
      if (key === absPath || key.startsWith(pluginDir + '\\') || key.startsWith(pluginDir + '/')) {
        delete nativeModule._cache[key];
      }
    }
  }
}

/** 错误消息提取 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 生成随机十六进制 ID（供外部使用） */
export function generatePluginId(): string {
  return randomBytes(8).toString('hex');
}
