import { createWorkfile } from './create-workfile.js';
import { createEntry } from './create-entry.js';
import { withFileMutation } from './checkpoint-store.js';
import { rollbackDocumentSession, trackDocumentMutationSync } from './document-history.js';
import { LargeTextStore } from './large-text.store.js';
import { listProjects, saveProject, removeProject } from '../../core/config/project-catalog.store.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  StreamableFile,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { ConfigService } from '../../core/config/config.service.js';
import {
  registerProjectDirProvider,
  registerSessionProjectDirProvider,
} from '../../core/config/effective-workspace.util.js';
import {
  getSessionProjectDir,
  setSessionProjectDir,
  removeSessionProjectDir,
} from '../../core/config/session-project.store.js';

/** 静态文件 MIME 类型表（对齐旧版 /files/serve 完整映射） */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'text/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 文件读取大小上限（5MB，对齐旧版） */
const MAX_READ_SIZE = 5 * 1024 * 1024;
/** 文件写入大小上限（5MB） */
const MAX_WRITE_SIZE = 5 * 1024 * 1024;
/** 命令执行默认超时（30s，对齐旧版） */
const DEFAULT_EXEC_TIMEOUT = 30_000;
/** 命令输出缓冲上限（10MB） */
const MAX_EXEC_BUFFER = 10 * 1024 * 1024;
/** 目录树默认深度 */
const TREE_DEFAULT_DEPTH = 3;
/** 目录树最大深度 */
const TREE_MAX_DEPTH = 6;
/** 目录树最大条目数（防止超大仓库卡死） */
const TREE_MAX_ENTRIES = 2000;
/** 设计稿帧缓存 TTL（10 分钟：前端刷新即重新注册，无需长存） */
const DESIGN_FRAME_TTL_MS = 10 * 60 * 1000;
/** 设计稿帧缓存容量上限（超出丢弃最旧；防爆内存） */
const DESIGN_FRAME_MAX = 32;
/** 设计稿帧大小上限（1.5MB：与 JSON body 2MB 限制匹配） */
const MAX_DESIGN_FRAME_SIZE = 6 * 1024 * 1024;
/** 文件树忽略目录（构建产物/VCS/依赖） */
const TREE_IGNORED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'out', '.next',
  '.nuxt', '__pycache__', '.venv', 'venv', 'target', '.gradle', '.idea',
  '.vs', 'coverage', '.turbo', '.cache', 'vendor',
]);

/** 文件读取结果 */
export interface FileReadResult {
  path: string;
  content: string;
  size: number;
  modified: Date;
  revision: string;
}

/** git 变更查询结果（工作区"代码变更"tab） */
export interface GitChangesResult {
  dir: string;
  isRepo: boolean;
  branch: string;
  files: Array<{ status: string; path: string }>;
  stat: string;
  diff: string;
}

/** 目录条目 */
export interface DirEntry {
  name: string;
  type: 'dir' | 'file' | 'unknown';
  size: number;
}

/** 目录列表结果 */
export interface FileListResult {
  path: string;
  entries: DirEntry[];
}

/** 静态文件服务结果 */
export interface ServeResult {
  stream: StreamableFile;
  mime: string;
  size: number;
}

/** 命令执行结果 */
export interface ExecResult {
  exitCode: number;
  output: string;
  error: string;
}

/** 文件树节点 */
export interface FileTreeNode {
  name: string;
  type: 'dir' | 'file';
  size: number;
  /** 子节点（仅 dir 且未达深度/条目上限时） */
  children?: FileTreeNode[];
  /** true = 子节点因深度/条目上限未展开（前端可懒加载） */
  truncated?: boolean;
}

/** 文件树结果 */
export interface FileTreeResult {
  path: string;
  name: string;
  type: 'dir';
  children: FileTreeNode[];
  truncated: boolean;
}

/** 根目录条目（盘符/常用目录） */
export interface RootEntry {
  path: string;
  label: string;
  type: 'drive' | 'home' | 'cwd';
  exists: boolean;
}

/**
 * FilesService - 文件服务
 *
 * 对齐旧版 /files/serve、/files/read、/files/list、/exec/command：
 *   - serve：MIME 类型识别 + 流式返回
 *   - read：5MB 大小上限 + UTF-8 文本内容
 *   - list：目录条目（名称/类型/大小）
 *   - exec：shell 命令执行（SecurityManager.isCommandAllowed 校验）
 *
 * 安全：所有路径必须通过 SecurityManager.isPathAllowed 校验。
 */
@Injectable()
export class FilesService {
  rollbackConversation(sessionId: string, sinceTs: number) { return rollbackDocumentSession(sessionId, sinceTs, path => this.security.isPathAllowed(path, 'write')); }
  createEntry(directory: string, name: string, type: 'file' | 'dir') {
    return createEntry(directory, name, type, path => this.security.isPathAllowed(path, 'write'));
  }
  /** Open a user-selected local document. Never interpret a filename as a command. */
  async localAction(rawPath: string, action: 'open' | 'reveal') {
    if (typeof rawPath !== 'string' || !rawPath.trim() || !path.isAbsolute(rawPath)) throw new BadRequestException('请选择有效的本地文件');
    if (action !== 'open' && action !== 'reveal') throw new BadRequestException('不支持的文件操作');
    const checked = this.checkReadablePath(rawPath);
    this.assertExists(checked, true);
    // Revalidate symlink targets before handing the path to the operating system.
    const target = this.checkReadablePath(realpathSync(checked));
    const directory = statSync(target).isDirectory();
    if (action === 'open' && !directory && /\.(exe|com|scr|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|scf|sh|app|desktop)$/i.test(target))
      throw new BadRequestException('此类型请在文件夹中选择编辑器打开');
    let command: string, args: string[];
    const directExplorer = process.platform === 'win32' && (action === 'reveal' || directory);
    if (directExplorer) {
      // Explorer hands off to the existing desktop process. Do not start PowerShell,
      // wait for Explorer to exit, or kill a window the user is still using.
      command = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'explorer.exe');
      args = [action === 'reveal' ? `/select,"${target}"` : `"${target}"`];
    } else if (process.platform === 'win32') {
      command = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const literal = "'" + target.replace(/'/g, "''") + "'";
      const operation = `Invoke-Item -LiteralPath ${literal}`;
      args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; try { ${operation} } catch { exit 1 }`, 'utf16le').toString('base64')];
    } else if (process.platform === 'darwin') {
      command = 'open'; args = action === 'reveal' ? ['-R', target] : [target];
    } else {
      command = 'xdg-open'; args = [action === 'reveal' ? dirname(target) : target];
    }
    await new Promise<void>((resolveOpen, reject) => {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: !directExplorer,
        ...(directExplorer ? { windowsVerbatimArguments: true } : {}) });
      if (directExplorer) {
        child.once('error', () => reject(new BadRequestException('无法启动系统文件管理器')));
        child.once('spawn', () => { child.unref(); resolveOpen(); });
        return;
      }
      const timer = setTimeout(() => { child.kill(); reject(new BadRequestException('打开超时，请从文件管理器重试')); }, 15000);
      child.once('error', () => { clearTimeout(timer); reject(new BadRequestException('无法打开，请检查系统默认应用')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveOpen() : reject(new BadRequestException('无法打开，请检查文件关联或系统文件管理器')); });
    });
    return { success: true };
  }
  readonly largeText: LargeTextStore;
  listProjects() { return listProjects(); }
  removeProject(rawPath: string) {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0'))
      throw new BadRequestException('项目路径无效');
    return removeProject(resolve(rawPath));
  }
  saveProject(rawPath: string, name?: string) {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0'))
      throw new BadRequestException('项目路径无效');
    const path = resolve(rawPath);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new NotFoundException('目录不存在: ' + path);
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80))
      throw new BadRequestException('项目显示名称需为 1–80 个字符');
    this.security.addAllowedPath(path, 'readwrite');
    return saveProject(path, name);
  }
  constructor(
    private readonly security: SecurityManagerService,
    private readonly config: ConfigService,
  ) {
    this.largeText = new LargeTextStore((path, write) => this.security.isPathAllowed(path, write ? 'write' : 'read'));
    // 接线产物落点：resolveEffectiveWorkspace() 由此读取当前工程目录
    // （会话绑定优先 → 全局 projectDir 兜底，规则见 effective-workspace.util）
    registerProjectDirProvider(() => this.getProjectDir());
    registerSessionProjectDirProvider((sessionId) => getSessionProjectDir(sessionId));
  }

  // ─── 工程目录（IDE 工程模式；会话绑定：一目录可多会话、一会话仅一目录） ──────

  /**
   * 解析生效的工程目录：sessionId 提供时优先会话绑定，未绑定回退全局配置。
   * 返回 path 与来源（session / global / ''）。
   */
  resolveProjectDir(sessionId?: string): { path: string; source: 'session' | 'global' | '' } {
    if (sessionId) {
      const bound = getSessionProjectDir(sessionId);
      if (bound) return { path: bound, source: 'session' };
      return { path: '', source: '' };
    }
    const global = this.getProjectDir();
    return global ? { path: global, source: 'global' } : { path: '', source: '' };
  }

  /** 全局工程目录（config general.projectDir；空串=未选择） */
  getProjectDir(): string {
    try {
      const general = this.config.get<Record<string, unknown>>('general');
      const v = general?.['projectDir'];
      return typeof v === 'string' ? v : '';
    } catch {
      return '';
    }
  }

  /**
   * 设置工程目录（用户通过原生对话框主动选择 = 明确授权）：
   * 校验存在且为目录 → 加入路径白名单（readwrite，随 path-policies 持久化）。
   * sessionId 提供时绑定为该会话的项目文件夹（存 session-projects.json，不改全局配置）；
   * 未提供 sessionId 时保持旧行为写 config.general.projectDir（全局默认）。
   * 旧全局工程目录在设置全局时移出白名单；会话换绑不移出（可能被其他会话/全局共用）。
   */
  setProjectDir(rawPath: string, sessionId?: string): { path: string } {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new ForbiddenException('path parameter required');
    }
    if (rawPath.includes('\0')) {
      throw new ForbiddenException('path must not contain null bytes');
    }
    const absPath = resolve(rawPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException('目录不存在: ' + absPath);
    }
    if (!statSync(absPath).isDirectory()) {
      throw new ForbiddenException('所选路径不是目录: ' + absPath);
    }
    this.security.addAllowedPath(absPath, 'readwrite');
    if (sessionId) {
      // 会话绑定：一个会话仅一个项目文件夹（重新选择即换绑），不改全局配置
      saveProject(absPath);
      setSessionProjectDir(sessionId, absPath);
      return { path: absPath };
    }
    // 全局设置：旧工程目录移出白名单（若存在且非当前设置）
    const prev = this.getProjectDir();
    if (prev && prev !== absPath) {
      try {
        this.security.removeAllowedPath(prev);
      } catch {
        // 忽略（可能已被手动清理）
      }
    }
    this.config.mergeSection('general', { projectDir: absPath });
    this.config.save();
    return { path: absPath };
  }

  /**
   * 清除工程目录：sessionId 提供时仅解绑该会话（回退全局）；未提供时清全局配置。
   */
  clearProjectDir(sessionId?: string): { cleared: boolean } {
    if (sessionId) {
      removeSessionProjectDir(sessionId);
      return { cleared: true };
    }
    const prev = this.getProjectDir();
    if (prev) {
      try {
        this.security.removeAllowedPath(prev);
      } catch {
        // 忽略
      }
    }
    this.config.mergeSection('general', { projectDir: '' });
    this.config.save();
    return { cleared: true };
  }

  /** 列出可选根目录（Windows 盘符 + 用户目录 + 当前目录） */
  listRoots(): { roots: RootEntry[] } {
    const roots: RootEntry[] = [];
    if (process.platform === 'win32') {
      for (let i = 65; i <= 90; i++) {
        const letter = String.fromCharCode(i);
        const drive = letter + ':\\';
        roots.push({ path: drive, label: letter + ':', type: 'drive', exists: existsSync(drive) });
      }
    } else {
      roots.push({ path: '/', label: '/', type: 'drive', exists: true });
    }
    roots.push({ path: homedir(), label: '用户目录', type: 'home', exists: true });
    roots.push({ path: process.cwd(), label: '应用目录', type: 'cwd', exists: true });
    return { roots };
  }

  /**
   * 递归目录树（IDE 文件树数据源）。
   * 忽略 VCS/依赖/构建产物目录；深度默认 3（最大 6）、条目上限 2000；
   * 超限节点标记 truncated=true，前端可对其懒加载展开（调 /files/list）。
   */
  tree(rawPath: string, depth?: number): FileTreeResult {
    const absPath = this.checkReadablePath(rawPath);
    this.assertExists(absPath, false);
    const maxDepth = Math.min(
      Math.max(typeof depth === 'number' && depth > 0 ? Math.floor(depth) : TREE_DEFAULT_DEPTH, 1),
      TREE_MAX_DEPTH,
    );
    let budget = TREE_MAX_ENTRIES;
    const walk = (dir: string, curDepth: number): { children: FileTreeNode[]; truncated: boolean } => {
      let entries: FileTreeNode[] = [];
      let raw: Array<{ name: string; isDir: boolean; size: number }>;
      try {
        raw = readdirSync(dir, { withFileTypes: true }).map((e) => {
          if (e.isDirectory()) return { name: e.name, isDir: true, size: 0 };
          if (e.isFile()) {
            try {
              return { name: e.name, isDir: false, size: statSync(path.join(dir, e.name)).size };
            } catch {
              return { name: e.name, isDir: false, size: 0 };
            }
          }
          return null;
        }).filter((v): v is { name: string; isDir: boolean; size: number } => v !== null);
      } catch {
        return { children: [], truncated: false };
      }
      // 目录在前、文件在后，各自按名称排序；忽略集合仅作用于目录
      const dirs = raw.filter((e) => e.isDir && !TREE_IGNORED_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      const files = raw.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
      const ordered = [...dirs, ...files];
      let truncated = false;
      for (const e of ordered) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        budget--;
        if (e.isDir) {
          if (curDepth >= maxDepth) {
            entries.push({ name: e.name, type: 'dir', size: 0, truncated: true });
            continue;
          }
          const sub = walk(path.join(dir, e.name), curDepth + 1);
          entries.push({ name: e.name, type: 'dir', size: 0, children: sub.children, ...(sub.truncated ? { truncated: true } : {}) });
        } else {
          entries.push({ name: e.name, type: 'file', size: e.size });
        }
      }
      return { children: entries, truncated };
    };
    const result = walk(absPath, 1);
    return {
      path: absPath,
      name: basename(absPath) || absPath,
      type: 'dir',
      children: result.children,
      truncated: result.truncated,
    };
  }

  /** 写入文本文件（前端编辑器保存；5MB 上限；自动创建父目录） */
  write(rawPath: string, content: string): { path: string; size: number } {
    if (typeof content !== 'string') {
      throw new ForbiddenException('content must be a string');
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_SIZE) {
      throw new ForbiddenException('文件内容过大(>5MB)');
    }
    if (!rawPath) {
      throw new ForbiddenException('path parameter required');
    }
    if (rawPath.includes('\0')) {
      throw new ForbiddenException('path must not contain null bytes');
    }
    const absPath = resolve(rawPath);
    if (!this.security.isPathAllowed(absPath, 'write')) {
      throw new ForbiddenException(`Path not allowed: ${absPath}`);
    }
    const parent = dirname(absPath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    trackDocumentMutationSync(absPath, () => writeFileSync(absPath, content, 'utf-8'));
    return { path: absPath, size: Buffer.byteLength(content, 'utf-8') };
  }

  createDesign(directory: string, name: string, content: string) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_WRITE_SIZE) throw new BadRequestException('设计文件过大');
    return createWorkfile(directory, name, 'html', content, path => this.security.isPathAllowed(path, 'write'));
  }

  /** Share AI file mutation lock; verify the loaded revision before writing. */
  async saveText(rawPath: string, content: string, revision: string) {
    if (!/^[a-f0-9]{64}$/.test(revision || '') || typeof content !== 'string') throw new BadRequestException('需要内容和原始文件版本');
    if (!this.security.isPathAllowed(resolve(rawPath), 'write')) throw new ForbiddenException('文件没有写入权限');
    return withFileMutation(resolve(rawPath), async () => {
      if (this.read(rawPath).revision !== revision) throw new ConflictException('文件已被 AI 或其他编辑器修改，请保留草稿并重新打开合并');
      return { ...this.write(rawPath, content), revision: createHash('sha256').update(content).digest('hex') };
    });
  }

  async saveDesign(rawPath: string, content: string, expectedContent?: string, expectedRevision?: string) {
    if ((typeof expectedContent !== 'string' && !/^[a-f0-9]{64}$/.test(expectedRevision || '')) || typeof content !== 'string' || !/\.html?$/i.test(rawPath || '')) throw new BadRequestException('需要 HTML 路径、内容和原始版本');
    if (!this.security.isPathAllowed(resolve(rawPath), 'write')) throw new ForbiddenException('文件没有写入权限');
    return withFileMutation(resolve(rawPath),async()=>{
      const current=this.read(rawPath);
      if(expectedRevision ? current.revision!==expectedRevision : current.content!==expectedContent) throw new ConflictException('文件已被 AI 或其他编辑器修改。请导出当前修改后重新加载，再合并内容。');
      return {...this.write(rawPath,content),revision:createHash('sha256').update(content).digest('hex')};
    });
  }

  /** 静态文件服务（对齐旧版 /files/serve） */
  serve(rawPath: string): ServeResult {
    const absPath = this.checkReadablePath(rawPath);
    this.assertExists(absPath, true);

    const ext = extname(absPath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = statSync(absPath);
    const stream = new StreamableFile(createReadStream(absPath));
    return { stream, mime, size: stat.size };
  }

  /** 读取文件文本（对齐旧版 /files/read） */
  read(rawPath: string): FileReadResult {
    const absPath = this.checkReadablePath(rawPath);
    this.assertExists(absPath, true);

    const stat = statSync(absPath);
    if (stat.size > MAX_READ_SIZE) {
      throw new ForbiddenException(`文件过大(>5MB)`);
    }
    const content = readFileSync(absPath, 'utf-8');
    return {
      path: absPath,
      content,
      size: stat.size,
      modified: stat.mtime,
      revision: createHash('sha256').update(content).digest('hex'),
    };
  }

  /** 列出目录（对齐旧版 /files/list） */
  list(rawPath: string): FileListResult {
    const absPath = this.checkReadablePath(rawPath);
    this.assertExists(absPath, false);

    const entries: DirEntry[] = readdirSync(absPath, { withFileTypes: true }).map((e) => {
      try {
        if (e.isDirectory()) return { name: e.name, type: 'dir' as const, size: 0 };
        if (e.isFile()) {
          const st = statSync(path.join(absPath, e.name));
          return { name: e.name, type: 'file' as const, size: st.size };
        }
        return { name: e.name, type: 'unknown' as const, size: 0 };
      } catch {
        return { name: e.name, type: 'unknown' as const, size: 0 };
      }
    });
    return { path: absPath, entries };
  }

  /**
   * 执行 shell 命令（对齐旧版 /exec/command）。
   *
   * 安全：
   *   - 命令必须通过 SecurityManager.isCommandAllowed 校验
   *   - cwd（若提供）必须通过 isPathAllowed 校验
   *   - spawn 使用 [shell, arg, command] 数组参数
   */
  exec(command: string, cwd?: string, timeout?: number): Promise<ExecResult> {
    if (!command || typeof command !== 'string') {
      return Promise.reject(new ForbiddenException('command required'));
    }
    if (!this.security.isCommandAllowed(command)) {
      return Promise.reject(
        new ForbiddenException(`Command blocked by guard: ${command}`),
      );
    }
    if (cwd && cwd.includes('\0')) {
      return Promise.reject(new ForbiddenException('cwd must not contain null bytes'));
    }
    if (cwd && !this.security.isPathAllowed(cwd)) {
      return Promise.reject(new ForbiddenException(`cwd not allowed: ${cwd}`));
    }

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArg = process.platform === 'win32' ? '/c' : '-c';
    const timeoutMs =
      typeof timeout === 'number' && timeout > 0 && timeout <= 600_000
        ? Math.floor(timeout)
        : DEFAULT_EXEC_TIMEOUT;

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(shell, [shellArg, command], {
        cwd: cwd || process.cwd(),
        env: process.env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let outputTooLarge = false;
      let settled = false;

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略
        }
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (outputTooLarge) return;
        stdout += chunk.toString();
        if (stdout.length > MAX_EXEC_BUFFER) {
          outputTooLarge = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // 忽略
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (outputTooLarge) return;
        stderr += chunk.toString();
        if (stderr.length > MAX_EXEC_BUFFER) {
          outputTooLarge = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // 忽略
          }
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (outputTooLarge) {
          reject(new ForbiddenException('Command output exceeded 10MB limit'));
          return;
        }
        resolve({
          exitCode: code ?? 0,
          output: stdout,
          error: stderr,
        });
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(e);
      });
    });
  }

  /**
   * git 变更查询：status --porcelain + diff HEAD --stat + diff HEAD（截断 400KB）。
   * 直接 execFile git（不过 shell，无注入面）；目录须通过路径白名单校验。
   * core.quotepath=false 让中文文件名原样显示。
   */
  async gitChanges(dir: string): Promise<GitChangesResult> {
    if (!dir) throw new ForbiddenException('dir parameter required');
    const absDir = resolve(process.cwd(), dir);
    if (!existsSync(absDir)) throw new NotFoundException('目录不存在');
    if (!this.security.isPathAllowed(absDir)) {
      throw new ForbiddenException(`Path not allowed: ${absDir}`);
    }
    const run = (args: string[]) =>
      new Promise<string>((res) => {
        const child = spawn('git', ['-C', absDir, '-c', 'core.quotepath=false', ...args], {
          windowsHide: true,
        });
        let out = '';
        child.stdout?.on('data', (c: Buffer) => {
          out += c.toString();
        });
        child.on('close', () => res(out));
        child.on('error', () => res(''));
      });
    const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (!branch) {
      return { dir: absDir, isRepo: false, branch: '', files: [], stat: '', diff: '' };
    }
    const statusOut = await run(['status', '--porcelain=v1']);
    const files = statusOut
      .split('\n')
      .filter((l) => l.length > 3)
      .map((line) => ({ status: line.slice(0, 2).trim() || 'M', path: line.slice(3).trim() }));
    const stat = await run(['diff', 'HEAD', '--stat']);
    const diff = (await run(['diff', 'HEAD'])).slice(0, 400_000);
    return { dir: absDir, isRepo: true, branch, files, stat, diff };
  }

  // ─── 设计稿画布帧（design-frame） ──────────────────────────────────────────
  //
  // 工作区"画布"视图的渲染通道：前端把注入标记脚本后的设计稿 HTML POST 进来换取
  // 随机 id，再由 <iframe src="/api/files/design-frame/:id"> 以 URL 方式加载。
  // 相比 srcdoc 的意义：http URL 文档不继承页面 CSP（srcdoc/blob:/data: 会继承，
  // script-src 'self' 时内联标记脚本被拦导致画布功能失效），且响应头显式声明
  // sandbox 隔离（opaque origin，设计稿脚本不可访问应用数据/存储），纵深防御。

  /** 帧缓存（id → html + 过期时间；Map 迭代序 = 插入序，容量超限时丢最旧） */
  private readonly designFrames = new Map<string, { html: string; expires: number }>();

  /** 注册设计稿帧：返回随机 id（供 iframe src 使用） */
  createDesignFrame(html: string): string {
    if (!html || typeof html !== 'string') throw new BadRequestException('html 不能为空');
    const size = Buffer.byteLength(html, 'utf8');
    if (size > MAX_DESIGN_FRAME_SIZE) {
      throw new PayloadTooLargeException(`设计稿过大（${Math.round(size / 1024)}KB，上限 ${MAX_DESIGN_FRAME_SIZE / 1024}KB）`);
    }
    const id = randomUUID();
    this.designFrames.set(id, { html, expires: Date.now() + DESIGN_FRAME_TTL_MS });
    // 注册后清理（含本次）：保证每次注册结束时缓存不超容量
    this.sweepDesignFrames();
    return id;
  }

  /** 取设计稿帧 HTML：不存在/已过期抛 404（iframe 显示错误页，前端重新注册即可恢复） */
  getDesignFrame(id: string): string {
    const hit = this.designFrames.get(id);
    if (!hit) throw new NotFoundException('设计稿帧不存在或已过期');
    if (hit.expires < Date.now()) {
      this.designFrames.delete(id);
      throw new NotFoundException('设计稿帧不存在或已过期');
    }
    return hit.html;
  }

  /** 惰性清理：过期项 + 容量超限丢最旧（Map 迭代序即插入序） */
  private sweepDesignFrames(): void {
    const now = Date.now();
    for (const [k, v] of this.designFrames) {
      if (v.expires < now) this.designFrames.delete(k);
    }
    while (this.designFrames.size > DESIGN_FRAME_MAX) {
      const oldest = this.designFrames.keys().next().value;
      if (oldest === undefined) break;
      this.designFrames.delete(oldest);
    }
  }

  // ─── 内部辅助 ─────────────────────────────────────────────────────────────

  /** 路径校验：resolve 后必须通过 SecurityManager.isPathAllowed */
  private checkReadablePath(rawPath: string): string {
    if (!rawPath) {
      throw new ForbiddenException('path parameter required');
    }
    if (rawPath.includes('\0')) {
      throw new ForbiddenException('path must not contain null bytes');
    }
    const absPath = resolve(process.cwd(), rawPath);
    if (!this.security.isPathAllowed(absPath)) {
      throw new ForbiddenException(`Path not allowed: ${absPath}`);
    }
    return absPath;
  }

  /** 存在性校验 */
  private assertExists(absPath: string, expectFile: boolean): Stats {
    if (!existsSync(absPath)) {
      throw new NotFoundException(expectFile ? '文件不存在' : '目录不存在');
    }
    return statSync(absPath);
  }
}
