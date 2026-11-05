import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { LoggerService } from '../core/logger/logger.service.js';
import { SecurityManagerService } from '../core/security/security-manager.service.js';
import { parseCommandSegments, type CommandSegment } from '../core/utils/exec-args.util.js';

/**
 * WorktreeService - Git Worktree 管理服务
 *
 * 移植自 start.cjs WorktreeSystem（行 16069-16370）的核心能力：
 *   - ensureGitRepo：检测/初始化 git 仓库
 *   - executeInWorktree：在 worktree 中执行命令（经 SecurityManager.isCommandAllowed 校验）
 *   - getWorktreeDiff：获取 worktree 的 git diff
 *
 * 出于安全考虑，本服务不再维护独立的 activeWorktrees 列表，调用方需提供 worktree 路径或
 * 通过 id 在内部维护的轻量映射中查找。exec 命令必须通过 SecurityManager.isCommandAllowed。
 */
export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  task: string;
  createdAt: number;
  status: 'active' | 'removed';
}

export interface ExecInWorktreeResult {
  success: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
  worktreeId?: string;
}

export interface WorktreeDiffResult {
  success: boolean;
  diff: string;
  worktreeId?: string;
  message?: string;
  error?: string;
}

export interface InitGitResult {
  success: boolean;
  repoPath?: string;
  error?: string;
  detail?: string;
}

/** git worktree list 单条记录 */
export interface GitWorktreeEntry {
  path: string;
  commit: string;
  branch: string;
}

/** GET /worktrees 列表结果（对齐 .cjs WorktreeSystem.listWorktrees） */
export interface ListWorktreesResult {
  worktrees: GitWorktreeEntry[];
  systemWorktrees: WorktreeInfo[];
  activeWorktrees: number;
  baseRepo: string | null;
  warning?: string;
  error?: string;
}

/** POST /worktrees/remove 结果 */
export interface RemoveWorktreeResult {
  success: boolean;
  error?: string;
}

/** POST /worktrees 创建结果 */
export interface CreateWorktreeResult {
  success: boolean;
  worktree?: WorktreeInfo;
  error?: string;
}

/** GET /worktrees/stats 统计信息（对齐 .cjs WorktreeSystem.getStats） */
export interface WorktreeStats {
  activeWorktrees: number;
  baseRepo: string;
  worktrees: Array<{ id: string; branch: string; status: string }>;
}

/** 单条命令执行的最大超时（ms） */
const EXEC_TIMEOUT_MS = 30_000;

@Injectable()
export class WorktreeService implements OnModuleInit {
  private storePath?: string;
  onModuleInit(): void {
    this.storePath = join(getDefaultDataDir(), 'worktrees.json');
    const saved = readJsonRecover<{ baseRepo?: string; worktrees?: WorktreeInfo[] }>(
      this.storePath,
      {},
    );
    if (saved.baseRepo && existsSync(saved.baseRepo)) this.baseRepo = saved.baseRepo;
    for (const wt of saved.worktrees ?? []) {
      if (wt && typeof wt.path === 'string' && existsSync(join(wt.path, '.git')))
        this.worktrees.set(wt.id, wt);
    }
  }
  private persist(): void {
    if (this.storePath)
      writeJsonAtomicSync(this.storePath, {
        baseRepo: this.baseRepo,
        worktrees: [...this.worktrees.values()],
      });
  }

  /** 活跃 worktree 映射：id -> WorktreeInfo */
  private readonly worktrees = new Map<string, WorktreeInfo>();
  /** 已检测到的 base repo 路径 */
  private baseRepo: string | null = null;
  /** 最近一次 init 失败的错误描述（与 .cjs 一致） */
  private lastInitError: string | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  /**
   * 确保 targetDir 是一个 git 仓库；若否则初始化（init + config + 首次提交）。
   * 与 .cjs ensureGitRepo 行为一致。
   */
  ensureGitRepo(targetDir: string): string | null {
    const dir = resolvePath(targetDir || process.cwd());
    this.logger.info('WorktreeService: ensureGitRepo checking', { dir });

    try {
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        cwd: dir,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: EXEC_TIMEOUT_MS,
      });
      this.logger.info('WorktreeService: git repo already exists', { dir });
      return dir;
    } catch {
      this.logger.info('WorktreeService: no git repo, initializing', { dir });
    }

    const steps: Array<{ argv: string[]; desc: string }> = [
      { argv: ['init'], desc: 'Initializing repository' },
      { argv: ['config', 'user.email', 'skyalytic@local.dev'], desc: 'Setting user email' },
      { argv: ['config', 'user.name', 'SkyalyticWing'], desc: 'Setting user name' },
    ];

    for (const step of steps) {
      try {
        execFileSync('git', step.argv, {
          encoding: 'utf-8',
          cwd: dir,
          stdio: ['pipe', 'pipe', 'ignore'],
          timeout: 10_000,
        });
      } catch (err) {
        this.lastInitError = `${step.desc}: ${err instanceof Error ? err.message : String(err)}`;
        this.logger.warn('WorktreeService: init step failed', {
          step: step.desc,
          error: this.lastInitError,
        });
        return null;
      }
    }

    try {
      // Initializing metadata must not silently stage every user file or secret.
      execFileSync('git', ['commit', '-m', 'Initial commit by SkyalyticWing', '--allow-empty'], {
        encoding: 'utf-8',
        cwd: dir,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 15_000,
      });
    } catch (err) {
      this.logger.warn('WorktreeService: initial commit skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.lastInitError = null;
    this.logger.info('WorktreeService: git repo initialized', { dir });
    return dir;
  }

  /**
   * 初始化 base repo（POST /api/worktrees/init-git 的服务入口）。
   * 优先尝试 process.cwd()，其次 APP_DIR（回退到 cwd 自身）。
   */
  initGit(): InitGitResult {
    let repo = this.ensureGitRepo(process.cwd());
    if (!repo && existsSync(join(process.cwd(), '.git'))) {
      // 首次尝试可能在 init 之后的步骤（config/commit）失败，此时 .git 已存在；
      // 有条件地重试一次，可经 rev-parse 检测恢复（对齐 .cjs 二次回退语义，避免无意义的同参重试）
      repo = this.ensureGitRepo(process.cwd());
    }
    if (repo) {
      this.baseRepo = repo;
      this.persist();
      this.logger.info('WorktreeService: git initialized via API', { repoPath: repo });
      return { success: true, repoPath: repo };
    }
    const detail = this.lastInitError || 'Unknown error - check server logs';
    this.logger.warn('WorktreeService: git init API failed', { detail });
    return {
      success: false,
      error: 'Failed to initialize git repository',
      detail,
    };
  }

  /**
   * 在指定 worktree 中执行命令。
   * 命令经 SecurityManager.isCommandAllowed 校验，未通过则拒绝。
   */
  executeInWorktree(worktreeId: string, command: string): ExecInWorktreeResult {
    const found = this.findWorktree(worktreeId);
    if (!found) {
      return { success: false, error: 'Worktree not found' };
    }
    const wt = found.info;
    if (!command || typeof command !== 'string') {
      return { success: false, error: 'command required' };
    }
    if (!this.security.isCommandAllowed(command)) {
      this.logger.warn('WorktreeService: command blocked by SecurityManager', {
        worktreeId,
        command: command.substring(0, 200),
      });
      return {
        success: false,
        error: 'Command not allowed by security policy',
        worktreeId,
      };
    }
    try {
      const output = this.runCommandIn(command, wt.path);
      this.logger.info('WorktreeService: exec succeeded', { worktreeId });
      return {
        success: true,
        exitCode: 0,
        output: String(output || ''),
        worktreeId,
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        ...(typeof e.status === 'number' ? { exitCode: e.status } : {}),
        output: e.stdout ? String(e.stdout) : '',
        error: e.stderr ? String(e.stderr) : e.message || String(err),
        worktreeId,
      };
    }
  }

  /**
   * 在指定目录执行命令（execFileSync 数组参数，防 shell 注入）。
   * - Windows：npm/make 等为 .cmd 批处理，execFileSync 无法直接 spawn，
   *   统一经 cmd.exe /c 执行（命令已过 CommandGuard，与 bash -c 同等防线）
   * - 其它平台：解析为 argv 段（支持 && / || 短路），逐段 execFileSync
   *   管道/重定向/分号等 shell 特性无法安全表达，直接拒绝
   */
  private runCommandIn(command: string, cwd: string): string {
    if (process.platform === 'win32') {
      return execFileSync('cmd.exe', ['/d', '/s', '/c', command], {
        encoding: 'utf-8',
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as string;
    }

    const segments = parseCommandSegments(command);
    if (!segments) {
      throw new Error('Command contains unsupported shell features (pipe/redirect/semicolon)');
    }
    let output = '';
    let ok = true;
    segments.forEach((seg: CommandSegment, idx: number) => {
      // 首段（joiner 为占位 '&&'）总是执行；后续段按自身 joiner（与前段的连接符）短路：
      //   seg.joiner === '&&'：前段失败 → 跳过；seg.joiner === '||'：前段成功 → 跳过
      if (idx > 0 && ((seg.joiner === '&&' && !ok) || (seg.joiner === '||' && ok))) return;
      try {
        output += execFileSync(seg.argv[0] as string, seg.argv.slice(1), {
          encoding: 'utf-8',
          cwd,
          timeout: EXEC_TIMEOUT_MS,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as string;
        ok = true;
      } catch (err) {
        ok = false;
        // 失败后若剩余段不可能回退（最后一段，或下一段是 && 需要本段成功）则立即抛出
        const next = segments[idx + 1];
        if (!next || next.joiner === '&&') {
          throw err;
        }
      }
    });
    return output;
  }

  /**
   * 获取 worktree 与 HEAD 的 diff（git diff HEAD~1..HEAD --stat）。
   * 无提交或单提交时返回空 diff。
   */
  getWorktreeDiff(worktreeId: string): WorktreeDiffResult {
    const found = this.findWorktree(worktreeId);
    if (!found) {
      return { success: false, diff: '', error: 'Worktree not found' };
    }
    const wt = found.info;
    try {
      const diff = execFileSync('git', ['diff', 'HEAD~1..HEAD', '--stat'], {
        encoding: 'utf-8',
        cwd: wt.path,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: EXEC_TIMEOUT_MS,
      });
      return { success: true, diff: String(diff || ''), worktreeId };
    } catch {
      return {
        success: true,
        diff: '',
        worktreeId,
        message: 'No changes or not a commit yet',
      };
    }
  }

  /** 注册一个 worktree（供测试或其他服务调用） */
  registerWorktree(info: WorktreeInfo): void {
    this.worktrees.set(info.id, info);
  }

  /**
   * 将 git worktree list 扫描结果同步进内部 Map（以 path 为键/id）。
   * 幂等：已登记的条目不覆盖，保证 registerWorktree 登记的信息优先。
   */
  private syncWorktreesFromGit(entries: GitWorktreeEntry[]): void {
    for (const entry of entries) {
      if (!entry.path) continue;
      if (this.worktrees.has(entry.path)) continue;
      // 跳过已通过其他 id（如 path hash）登记的同路径条目
      let alreadyRegistered = false;
      for (const wt of this.worktrees.values()) {
        if (wt.path === entry.path) {
          alreadyRegistered = true;
          break;
        }
      }
      if (alreadyRegistered) continue;
      this.worktrees.set(entry.path, {
        id: entry.path,
        path: entry.path,
        branch: entry.branch,
        task: '',
        createdAt: Date.now(),
        status: 'active',
      });
    }
  }

  /**
   * 按 id 或 path 查找 worktree。
   * 1) 精确 id 命中；2) path 精确匹配；3) path 模糊匹配（大小写不敏感、尾部分隔符归一、后缀包含）。
   * 返回 Map 键与信息，便于调用方按正确键清理。
   */
  private findWorktree(idOrPath: string): { key: string; info: WorktreeInfo } | null {
    if (!idOrPath) return null;
    const direct = this.worktrees.get(idOrPath);
    if (direct) return { key: idOrPath, info: direct };

    for (const [key, wt] of this.worktrees) {
      if (wt.path === idOrPath) return { key, info: wt };
    }

    const normalize = (p: string): string => {
      const resolved = resolvePath(p).replace(/[\\/]+$/, '');
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    for (const [key, wt] of this.worktrees)
      if (normalize(wt.path) === normalize(idOrPath)) return { key, info: wt };
    return null;
  }

  /**
   * 列出全部 worktree：`git worktree list` 扫描 + 系统内部登记的 systemWorktrees。
   * 无 git 仓库时返回 warning 与空列表（对齐 .cjs listWorktrees）。
   */
  listWorktrees(): ListWorktreesResult {
    const repo = this.detectBaseRepo();
    if (!repo) {
      const systemWorktrees = Array.from(this.worktrees.values());
      return {
        worktrees: [],
        systemWorktrees,
        activeWorktrees: systemWorktrees.length,
        baseRepo: null,
        warning: 'No git repository detected',
      };
    }

    try {
      const output = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
        encoding: 'utf-8',
        cwd: repo,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: EXEC_TIMEOUT_MS,
      });
      const worktrees = parseWorktreePorcelain(String(output || ''));
      // 先同步 git 扫描结果再取快照，确保本次扫描的 worktree 计入 systemWorktrees/activeWorktrees
      this.syncWorktreesFromGit(worktrees);
      const systemWorktrees = Array.from(this.worktrees.values());
      return {
        worktrees,
        systemWorktrees,
        activeWorktrees: systemWorktrees.length,
        baseRepo: repo,
      };
    } catch (err) {
      const systemWorktrees = Array.from(this.worktrees.values());
      return {
        worktrees: [],
        systemWorktrees,
        activeWorktrees: systemWorktrees.length,
        baseRepo: this.baseRepo,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 创建 worktree（git worktree add <path> <branch>），成功后登记进内部 Map。
   * path 经 SecurityManager.isPathAllowed（write 模式，即 PathGuard）校验，拒绝越权路径；
   * branch 以 "-" 开头时拒绝，防止被 git 解析为选项（参数注入）。
   */
  createWorktree(path: string, branch: string): CreateWorktreeResult {
    if (!path || !branch) {
      return { success: false, error: 'path and branch required' };
    }
    if (branch.startsWith('-')) {
      return { success: false, error: 'Invalid branch name' };
    }
    const absPath = resolvePath(path);
    if (!this.security.isPathAllowed(absPath, 'write')) {
      this.logger.warn('WorktreeService: create path blocked by PathGuard', { path: absPath });
      return { success: false, error: 'Path not allowed by security policy' };
    }
    const repo = this.detectBaseRepo() ?? this.ensureGitRepo(process.cwd());
    if (!repo) {
      return { success: false, error: 'No git repository detected' };
    }
    try {
      let branchExists = false;
      try {
        execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
          cwd: repo, stdio: 'ignore', timeout: EXEC_TIMEOUT_MS,
        });
        branchExists = true;
      } catch { /* A new branch is created from HEAD without replacing existing refs. */ }
      const args = branchExists
        ? ['worktree', 'add', absPath, branch]
        : ['worktree', 'add', '-b', branch, absPath, 'HEAD'];
      execFileSync('git', args, {
        encoding: 'utf-8',
        cwd: repo,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn('WorktreeService: create worktree failed', { path: absPath, branch, error });
      return { success: false, error };
    }
    const info: WorktreeInfo = {
      id: absPath,
      path: absPath,
      branch,
      task: '',
      createdAt: Date.now(),
      status: 'active',
    };
    this.worktrees.set(absPath, info);
    this.persist();
    this.logger.info('WorktreeService: created worktree', { path: absPath, branch });
    return { success: true, worktree: info };
  }

  /** 移除 worktree（git worktree remove --force），并从内部登记中删除 */
  removeWorktree(worktreeId: string): RemoveWorktreeResult {
    const found = this.findWorktree(worktreeId);
    if (!found) {
      return { success: false, error: 'Worktree not found' };
    }
    const wt = found.info;
    const repo = this.detectBaseRepo();
    try {
      execFileSync('git', ['worktree', 'remove', wt.path], {
        encoding: 'utf-8',
        cwd: repo ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: EXEC_TIMEOUT_MS,
      });
      this.worktrees.delete(found.key);
      this.persist();
      this.logger.info('WorktreeService: removed worktree', { worktreeId, path: wt.path });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 统计信息：活跃数、baseRepo、worktree 摘要（对齐 .cjs getStats） */
  getStats(): WorktreeStats {
    return {
      activeWorktrees: this.worktrees.size,
      baseRepo: this.detectBaseRepo() || 'not-detected',
      worktrees: Array.from(this.worktrees.values()).map((w) => ({
        id: w.id,
        branch: w.branch,
        status: w.status,
      })),
    };
  }

  /** 获取 base repo 路径（已检测或初始化） */
  getBaseRepo(): string | null {
    return this.baseRepo;
  }

  /** 检测 base repo（与 .cjs detectBaseRepo 行为一致，简化版） */
  detectBaseRepo(): string | null {
    if (this.baseRepo) return this.baseRepo;
    const candidates = [process.cwd(), join(process.cwd(), '..')];
    for (const c of candidates) {
      const dir = resolvePath(c);
      if (existsSync(join(dir, '.git'))) {
        this.baseRepo = dir;
        return dir;
      }
    }
    return null;
  }
}

export function parseWorktreePorcelain(output: string): GitWorktreeEntry[] {
  return output
    .split('\0\0')
    .filter(Boolean)
    .map((block) => {
      const fields = block.split('\0');
      return {
        path: fields.find((f) => f.startsWith('worktree '))?.slice(9) ?? '',
        commit: fields.find((f) => f.startsWith('HEAD '))?.slice(5) ?? '',
        branch:
          fields
            .find((f) => f.startsWith('branch '))
            ?.slice(7)
            .replace(/^refs\/heads\//, '') ?? 'detached',
      };
    })
    .filter((wt) => wt.path.length > 0);
}
