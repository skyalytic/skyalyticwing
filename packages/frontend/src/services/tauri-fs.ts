import { wt } from '@/i18n/workbench-text';
// TauriFs 服务：Tauri 文件系统访问工具
// 对齐旧版 modules/tauri-fs.js，并增强路径归一化、统一返回结构与超时控制
// 双通道兼容：优先使用 window.__TAURI__.fs，回退到 window.__TAURI_INTERNALS__.invoke('fs:*')

/** 默认操作超时（ms） */
const DEFAULT_TIMEOUT_MS = 15000;

/** Tauri fs 模块的最小类型描述 */
interface TauriFsLike {
  readDir?: (path: string, options?: unknown) => Promise<unknown>;
  readTextFile?: (path: string, options?: unknown) => Promise<string>;
  writeTextFile?: (path: string, contents: string, options?: unknown) => Promise<void>;
}

interface TauriGlobal {
  fs?: TauriFsLike;
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface TauriInternals {
  fs?: TauriFsLike;
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface WindowWithTauri extends Window {
  __TAURI__?: TauriGlobal;
  __TAURI_INTERNALS__?: TauriInternals;
}

/** 统一的目录条目结构 */
export interface FsDirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime?: number;
}

function getTauriWindow(): WindowWithTauri {
  return typeof window === 'undefined' ? ({} as WindowWithTauri) : (window as WindowWithTauri);
}

/** 检测 Tauri 运行环境是否可用 */
export function isTauriAvailable(): boolean {
  const w = getTauriWindow();
  return !!(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** 获取 fs 模块（优先 __TAURI__.fs，其次 __TAURI_INTERNALS__.fs） */
function getTauriFs(): TauriFsLike | null {
  const w = getTauriWindow();
  if (w.__TAURI__?.fs) return w.__TAURI__.fs;
  if (w.__TAURI_INTERNALS__?.fs) return w.__TAURI_INTERNALS__.fs;
  return null;
}

/** 获取 invoke 函数（优先 __TAURI__.invoke，其次 __TAURI_INTERNALS__.invoke） */
function getTauriInvoke():
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const w = getTauriWindow();
  if (w.__TAURI__?.invoke) return w.__TAURI__.invoke;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__.invoke;
  return null;
}

/**
 * 路径归一化：
 * - 反斜杠 -> 正斜杠（Windows 兼容）
 * - 解析 `.` 与 `..` 段
 * - 合并连续斜杠、去除末尾斜杠
 * - 保留驱动器前缀（如 C:）与开头的 /
 */
export function normalizePath(p: string | null | undefined): string {
  if (!p) return '';
  // Windows 驱动器前缀保留小写盘符后的冒号
  let path = String(p).replace(/\\/g, '/');

  // 拆分时保留开头根标记
  const isAbsPosix = path.startsWith('/');
  let drivePrefix = '';
  const driveMatch = path.match(/^([a-zA-Z]:)(\/?.*)$/);
  if (driveMatch) {
    drivePrefix = driveMatch[1];
    path = driveMatch[2];
  }

  const segments = path.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // 不越过根
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      }
      continue;
    }
    out.push(seg);
  }

  let normalized = out.join('/');
  if (drivePrefix) {
    normalized = `${drivePrefix}/${normalized}`;
  } else if (isAbsPosix) {
    normalized = `/${normalized}`;
  }
  return normalized;
}

/** 为任意 Promise 增加超时保护，超时后抛出带 TIMEOUT 标记的错误 */
function withTimeout<T>(task: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (timeoutMs <= 0) return task;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(wt('Tauri FS 操作超时 ({{v0}}ms)', { v0: timeoutMs })));
    }, timeoutMs);
    task.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** 从后端/invoke 返回的未知结构中提取统一目录条目 */
function toDirEntries(raw: unknown): FsDirEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): FsDirEntry | null => {
      if (!item || typeof item !== 'object') return null;
      const obj = item as Record<string, unknown>;
      const nameVal = obj['name'];
      const pathVal = obj['path'];
      const name = typeof nameVal === 'string' ? nameVal : '';
      const path = typeof pathVal === 'string' ? pathVal : '';
      const isDir = Boolean(obj['isDir'] ?? obj['isDirectory'] ?? obj['is_directory'] ?? false);
      const sizeRaw = obj['size'];
      const size = typeof sizeRaw === 'number' ? sizeRaw : Number(sizeRaw ?? 0) || 0;
      const mtimeRaw =
        obj['mtime'] ?? obj['modifiedAt'] ?? obj['last_modified'] ?? obj['modified_at'];
      const mtime = typeof mtimeRaw === 'number' ? mtimeRaw : undefined;
      if (!name && !path) return null;
      return {
        name: name || path.split(/[/\\]/).pop() || '',
        path: normalizePath(path),
        isDir,
        size,
        mtime,
      };
    })
    .filter((x): x is FsDirEntry => x !== null);
}

/**
 * 读取目录，返回统一结构的条目列表。
 * 优先调用 __TAURI__.fs.readDir，回退 invoke('fs:read_dir')。
 */
export async function readDir(
  dirPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FsDirEntry[]> {
  if (!isTauriAvailable()) {
    throw new Error('Tauri FS not available');
  }
  const normalized = normalizePath(dirPath);
  const fs = getTauriFs();
  try {
    let raw: unknown;
    if (fs?.readDir) {
      raw = await withTimeout(fs.readDir(normalized), timeoutMs);
    } else {
      const invoke = getTauriInvoke();
      if (!invoke) throw new Error('No Tauri FS API available');
      raw = await withTimeout(invoke('fs:read_dir', { path: normalized }), timeoutMs);
    }
    return toDirEntries(raw);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * 读取文本文件内容。
 * 优先调用 __TAURI__.fs.readTextFile，回退 invoke('fs:read_text_file')。
 */
export async function readTextFile(
  filePath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (!isTauriAvailable()) {
    throw new Error('Tauri FS not available');
  }
  const normalized = normalizePath(filePath);
  const fs = getTauriFs();
  try {
    if (fs?.readTextFile) {
      const content = await withTimeout(fs.readTextFile(normalized), timeoutMs);
      return typeof content === 'string' ? content : String(content ?? '');
    }
    const invoke = getTauriInvoke();
    if (!invoke) throw new Error('No Tauri FS API available');
    const content = await withTimeout(invoke('fs:read_text_file', { path: normalized }), timeoutMs);
    return typeof content === 'string' ? content : String(content ?? '');
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * 写入文本文件，成功返回 true。
 * 优先调用 __TAURI__.fs.writeTextFile，回退 invoke('fs:write_text_file')。
 */
export async function writeTextFile(
  filePath: string,
  content: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (!isTauriAvailable()) {
    throw new Error('Tauri FS not available');
  }
  const normalized = normalizePath(filePath);
  const fs = getTauriFs();
  try {
    if (fs?.writeTextFile) {
      await withTimeout(fs.writeTextFile(normalized, content), timeoutMs);
      return true;
    }
    const invoke = getTauriInvoke();
    if (!invoke) throw new Error('No Tauri FS API available');
    await withTimeout(invoke('fs:write_text_file', { path: normalized, content }), timeoutMs);
    return true;
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export const tauriFs = {
  isTauriAvailable,
  normalizePath,
  readDir,
  readTextFile,
  writeTextFile,
};

export default tauriFs;
