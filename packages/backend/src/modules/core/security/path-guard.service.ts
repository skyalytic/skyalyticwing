import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { ConfigService } from '../config/config.service.js';

/**
 * 路径访问模式
 *  - read: 只读
 *  - write: 只写（含读写）
 *  - readwrite: 读写
 *  - execute: 执行
 *  - any: 任意模式
 */
export type PathMode = 'read' | 'write' | 'readwrite' | 'execute' | 'any';

/** 路径策略条目 */
export interface PathPolicy {
  path: string;
  mode: PathMode;
  allowed: boolean;
}

/**
 * PathGuardService - 路径安全验证（全量移植自 security-manager.cjs 第8节）
 *
 * 路径策略系统：
 *   - 默认允许当前工作区目录（readwrite）
 *   - 默认拒绝系统目录（/etc, /root, C:\Windows 等）
 *   - 支持动态添加/删除允许路径
 *   - 支持模式兼容性检查（read/write/execute/any）
 *   - 策略按逆序匹配（后添加=高优先级）
 *   - 模式不匹配时拒绝（C-F1 修复：防止权限提升）
 *   - 持久化到 path-policies.json
 *
 * 安全特性：
 *   - H-B2: 使用 realpathSync 解析符号链接，防止 symlink 绕过
 *   - M9: Windows 下大小写归一化，防止路径策略绕过
 *   - H-B9: 加载持久化策略时合并到默认策略，不替换
 */
@Injectable()
export class PathGuardService implements OnModuleInit {
  private readonly logger = new Logger(PathGuardService.name);

  /** 路径策略列表（按添加顺序，逆序匹配） */
  private pathPolicies: PathPolicy[] = [];

  /** 工作区目录 */
  private workspaceDir: string | null = null;

  /** 安全数据目录 */
  private dataDir: string;

  /** 是否已初始化 */
  private initialized = false;

  constructor(private readonly config: ConfigService) {
    this.dataDir = this.resolveDataDir();
  }

  onModuleInit(): void {
    this.init();
  }

  /** 解析安全数据目录 */
  private resolveDataDir(): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    if (envDir) return join(envDir, 'security');
    return join(homedir(), '.skyalyticwing', 'security');
  }

  /** 初始化（幂等，重复调用安全） */
  init(): void {
    if (this.initialized) {
      this.logger.log('init() 已初始化，跳过（幂等）');
      return;
    }

    this.ensureDir(this.dataDir);

    // 初始化默认路径策略
    this.initDefaultPathPolicies();

    // 从 ConfigService 读取用户自定义允许路径，合并为允许策略
    this.loadConfigAllowedPaths();

    // 加载持久化策略（合并到默认策略之后，H-B9 修复）
    this.loadPathPolicies();

    this.initialized = true;
    this.logger.log(`PathGuard 已初始化 (dataDir: ${this.dataDir})`);
  }

  /** 确保已初始化，否则抛异常 */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PathGuardService 未初始化，请等待 OnModuleInit 完成');
    }
  }

  // ===========================================================================
  // 路径策略核心
  // ===========================================================================

  /**
   * 检查目标路径是否被允许
   * @param filePath 目标路径
   * @param mode 请求的访问模式（默认 read）
   * @returns true=允许，false=拒绝
   */
  isPathAllowed(filePath: string, mode?: PathMode): boolean {
    this.ensureInitialized();

    if (!filePath) return false;

    const normalizedPath = this.normalizePath(filePath);
    const requestedMode: PathMode = mode || 'read';

    // 按逆序检查策略（后添加=高优先级）
    for (let i = this.pathPolicies.length - 1; i >= 0; i--) {
      const policy = this.pathPolicies[i];

      // 检查请求路径是否在策略路径之下（含根本身）
      if (this.isSubPath(policy.path, normalizedPath) || normalizedPath === policy.path) {
        if (policy.allowed) {
          // 检查模式兼容性
          if (policy.mode === 'readwrite') return true;
          if (policy.mode === 'read' && requestedMode === 'read') return true;
          if (policy.mode === 'write' && (requestedMode === 'write' || requestedMode === 'readwrite')) return true;
          if (policy.mode === 'execute' && requestedMode === 'execute') return true;
          if (policy.mode === 'any') return true;
          // C-F1 修复：匹配策略上的模式不兼容必须 DENY，而不是继续向下检查。
          // 防止高优先级只读策略被低优先级读写策略绕过（权限提升）。
          return false;
        } else {
          // 明确拒绝
          return false;
        }
      }
    }

    // 默认：拒绝
    return false;
  }

  /** 添加允许路径 */
  addAllowedPath(filePath: string, mode?: PathMode): void {
    // 修复：依赖模块（如 SkillService）的 onModuleInit 可能先于本服务执行，
    // 此时白名单尚未初始化会导致注册被静默吞掉（技能编辑"路径未在白名单内"）。
    // init() 幂等，晚到调用方先补齐初始化再注册。
    if (!this.initialized) {
      this.init();
    }
    if (!filePath) return;

    const normalizedPath = this.normalizePath(filePath);
    this.pathPolicies.push({
      path: normalizedPath,
      mode: mode || 'readwrite',
      allowed: true,
    });

    this.logger.log(`添加允许路径: ${normalizedPath} (${mode || 'readwrite'})`);
    this.persistPathPolicies();
  }

  /** 移除允许路径 */
  removeAllowedPath(filePath: string): boolean {
    this.ensureInitialized();
    if (!filePath) return false;

    const normalizedPath = this.normalizePath(filePath);

    for (let i = this.pathPolicies.length - 1; i >= 0; i--) {
      if (this.pathPolicies[i].path === normalizedPath && this.pathPolicies[i].allowed) {
        this.pathPolicies.splice(i, 1);
        this.persistPathPolicies();
        this.logger.log(`移除允许路径: ${normalizedPath}`);
        return true;
      }
    }
    return false;
  }

  /** 列出所有路径策略（副本） */
  listPathPolicies(): PathPolicy[] {
    this.ensureInitialized();
    return this.pathPolicies.slice();
  }

  // ===========================================================================
  // 内部辅助方法
  // ===========================================================================

  /**
   * 归一化路径
   * H-B2 修复：path.resolve() 不解析符号链接，使用 fs.realpathSync() 完全解析。
   * 使用 native 统一 Windows 短路径与完整路径；新文件解析最近存在的父目录。
   */
  private normalizePath(filePath: string): string {
    if (!filePath) return '';
    try {
      const absolute = resolve(filePath);
      let ancestor = absolute;
      while (!existsSync(ancestor)) {
        const parent = dirname(ancestor);
        if (parent === ancestor) return absolute;
        ancestor = parent;
      }
      // fs.promises.realpath (used by the editor) also uses native resolution.
      // Resolve the parent even for a new file so a junction cannot escape its grant.
      return resolve(realpathSync.native(ancestor), relative(ancestor, absolute));
    } catch {
      return resolve(filePath);
    }
  }

  /**
   * 判断 childPath 是否在 parentPath 之下
   * M9 修复：Windows 下 path.relative() 大小写敏感，需归一化为小写。
   */
  private isSubPath(parentPath: string, childPath: string): boolean {
    let parent = parentPath;
    let child = childPath;
    if (platform() === 'win32') {
      parent = String(parent).toLowerCase();
      child = String(child).toLowerCase();
    }
    const rel = relative(parent, child);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }

  /** 初始化默认路径策略 */
  private initDefaultPathPolicies(): void {
    this.workspaceDir = this.normalizePath(process.cwd());

    // 允许工作区目录
    this.pathPolicies.push({
      path: this.workspaceDir,
      mode: 'readwrite',
      allowed: true,
    });

    // 限制系统目录
    const systemDirs = [
      '/etc', '/root', '/var/log', '/var/run',
      '/usr/local/etc', '/opt',
      'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData',
      join(homedir(), '.ssh'),
      join(homedir(), '.gnupg'),
      join(homedir(), '.aws'),
      join(homedir(), '.config'),
    ];

    for (const dir of systemDirs) {
      if (dir) {
        this.pathPolicies.push({
          path: this.normalizePath(dir),
          mode: 'any',
          allowed: false,
        });
      }
    }
  }

  /** 从 ConfigService 读取用户自定义允许路径 */
  private loadConfigAllowedPaths(): void {
    try {
      const security = this.config.get<Record<string, unknown>>('security');
      const allowed = security['allowedPaths'];
      if (Array.isArray(allowed)) {
        for (const p of allowed) {
          if (typeof p === 'string' && p.length > 0) {
            try {
              const normalized = this.normalizePath(p);
              this.pathPolicies.push({
                path: normalized,
                mode: 'readwrite',
                allowed: true,
              });
            } catch {}
          }
        }
      }
    } catch {
      // 配置读取失败不影响初始化
    }
  }

  // ===========================================================================
  // 持久化
  // ===========================================================================

  /** 持久化路径策略到 path-policies.json */
  private persistPathPolicies(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'path-policies.json');
    this.saveJson(filePath, this.pathPolicies);
  }

  /**
   * 从 path-policies.json 加载路径策略
   * H-B9 修复：合并到默认策略，不替换。保证默认拒绝规则始终存在，
   * 用户持久化策略保持高优先级（后追加，isPathAllowed 逆序遍历）。
   */
  private loadPathPolicies(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'path-policies.json');
    const loaded = this.loadJson<PathPolicy[] | null>(filePath, null);
    if (Array.isArray(loaded) && loaded.length > 0) {
      for (const policy of loaded) {
        if (policy && typeof policy.path === 'string')
          this.pathPolicies.push({...policy, path:this.normalizePath(policy.path)});
      }
    }
  }

  // ===========================================================================
  // 通用文件持久化辅助（原子写入，M-B14 修复）
  // ===========================================================================

  private ensureDir(dirPath: string): void {
    try {
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    } catch (err) {
      this.logger.error(`创建目录失败 ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadJson<T>(filePath: string, defaultValue: T): T {
    try {
      if (existsSync(filePath)) {
        const data = readFileSync(filePath, 'utf8');
        return JSON.parse(data) as T;
      }
    } catch (err) {
      this.logger.error(`加载文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return defaultValue;
  }

  /**
   * 原子写入 JSON 文件（M-B14 修复）
   * 先写临时文件再 rename，避免半写入导致 JSON 损坏。
   * Windows 上若目标已存在 rename 会失败，先 unlink 再 rename。
   */
  private saveJson(filePath: string, data: unknown): void {
    try {
      this.ensureDir(dirname(filePath));
      const content = JSON.stringify(data, null, 2);
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpPath, content, 'utf8');
      try {
        renameSync(tmpPath, filePath);
      } catch {
        try { unlinkSync(filePath); } catch {}
        renameSync(tmpPath, filePath);
      }
    } catch (err) {
      this.logger.error(`保存文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
