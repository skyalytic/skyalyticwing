// AI 文件更改检查点存储（内存 + 磁盘双写，落盘持久化）。
// file-write 工具每次写入前记录"写入前内容"；前端"回退到本轮对话发起前"时
// 按 会话 + 时间戳范围 倒序恢复：oldContent 为 null（新建文件）→ 删除；否则写回旧内容。
// 持久化：${dataDir}/checkpoints/<safe-sessionId>.json —— 只要对话记录还在
//（checkpoint 文件未被清理），应用重启后同样可以随时回滚。
import { existsSync, mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { documentSession, recordingDocument, trackDocumentMutation } from './document-history.js';

export interface FileCheckpoint {
  path: string;
  /** 写入前内容；null = 该文件是本轮新建的（回滚时应删除） */
  oldContent: string | null;
  ts: number;
  expectedHash?: string;
}

/** sessionId → checkpoints（时间升序） */
const store = new Map<string, FileCheckpoint[]>();

/** 每会话保留上限（超出淘汰最早的），防止单会话 checkpoint 文件无限膨胀 */
const MAX_PER_SESSION = 300;
/** 落盘防抖（ms）：写入后延迟落盘，合并高频写文件 */

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rollbackLocks = new Map<string, Promise<unknown>>();
const fileLocks = new Map<string, Promise<unknown>>();

export async function withFileMutation<T>(path: string, run: () => Promise<T>, track = true): Promise<T> {
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const prior = fileLocks.get(key) ?? Promise.resolve();
  const pending = prior.catch(() => undefined).then(() => track ? trackDocumentMutation(path, run) : run());
  fileLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (fileLocks.get(key) === pending) fileLocks.delete(key);
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class FileRollbackError extends Error {
  constructor(
    readonly restored: string[],
    readonly failed: string[],
  ) {
    super('文件已被其他操作修改、旧检查点缺少版本信息或访问失败；检查点已保留，请核对冲突后重试');
  }
}

/** 会话 id → 安全文件名：encodeURIComponent 防碰撞（'a/b' 与 'a\b' 不再同名），
 *  再替换 Windows 文件名非法/危险字符（含 '.' 防 '..' 路径穿越） */
function safeSessionId(sessionId: string): string {
  return createHash('sha256')
    .update(sessionId || '__global__')
    .digest('hex');
}

function checkpointFile(sessionId: string): string {
  return resolve(getDefaultDataDir(), 'checkpoints', `${safeSessionId(sessionId)}.json`);
}

/** 从磁盘加载该会话的 checkpoint（惰性；文件不存在返回空） */
function loadFromDisk(sessionId: string): FileCheckpoint[] {
  const f = checkpointFile(sessionId);
  try {
    const legacyName = encodeURIComponent(sessionId || '__global__')
      .replace(/[!*'()~.]/g, '_')
      .slice(0, 100);
    const legacy = resolve(getDefaultDataDir(), 'checkpoints', `${legacyName}.json`);
    const raw = readJsonRecover<FileCheckpoint[]>(
      existsSync(f) || existsSync(`${f}.bak`) ? f : legacy,
      [],
    );
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c) =>
        c &&
        typeof c.path === 'string' &&
        typeof c.ts === 'number' &&
        (c.oldContent === null || typeof c.oldContent === 'string'),
    );
  } catch {
    return [];
  }
}

/** 全量落盘（覆盖写；父目录自动创建） */
function flush(sessionId: string): void {
  try {
    const list = store.get(sessionId) ?? [];
    const f = checkpointFile(sessionId);
    const parent = resolve(f, '..');
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeJsonAtomicSync(f, list);
  } catch (error) {
    throw new Error(`检查点持久化失败: ${String(error)}`);
  }
}

/** 立即落盘（回滚前调用，确保磁盘与内存一致） */
function flushNow(sessionId: string): void {
  const t = flushTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    flushTimers.delete(sessionId);
  }
  flush(sessionId);
}

/** 惰性加载：内存无该会话数据时从磁盘载入（应用重启后首次 record/rollback 触发）。
 *  关键正确性保证：rollback 前必须先 ensureLoaded——否则 flushNow 会把空的内存数据
 *  覆盖写到磁盘，毁掉持久化的历史检查点。 */
function ensureLoaded(sessionId: string): FileCheckpoint[] {
  let list = store.get(sessionId);
  if (!list) {
    list = loadFromDisk(sessionId);
    store.set(sessionId, list);
  }
  return list;
}

/** 记录一次 AI 写入前的文件内容（内存 + 防抖落盘） */
export function recordFileCheckpoint(
  sessionId: string,
  path: string,
  oldContent: string | null,
  newContent?: string,
): void {
  if (documentSession() === sessionId && recordingDocument(path)) return;
  const key = sessionId || '__global__';
  const list = ensureLoaded(key);
  list.push({
    path,
    oldContent,
    ts: Date.now(),
    ...(newContent !== undefined ? { expectedHash: hash(newContent) } : {}),
  });
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
  flushNow(key); // Durable before the file is changed.
}

/**
 * 回滚指定会话中 ts >= sinceTs 的全部 AI 文件更改（按时间倒序逐个恢复）。
 * 回滚前惰性加载磁盘历史并强制落盘。失败的文件保留检查点并报告失败。
 * 同会话回滚串行执行；恢复其他文件不会被单个文件的失败阻断。
 */
export async function rollbackFileCheckpoints(
  sessionId: string,
  sinceTs: number,
): Promise<string[]> {
  const key = sessionId || '__global__';
  const previous = rollbackLocks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => rollback(key, sinceTs));
  rollbackLocks.set(key, task);
  try {
    return await task;
  } finally {
    if (rollbackLocks.get(key) === task) rollbackLocks.delete(key);
  }
}

async function rollback(key: string, sinceTs: number): Promise<string[]> {
  // 先确保内存已从磁盘载入历史，再强制落盘合并——否则空内存会把磁盘历史覆盖清空
  const list = [...ensureLoaded(key)];
  flushNow(key);
  const affected = list.filter((c) => c.ts >= sinceTs);
  if (affected.length === 0) return [];
  const restored: string[] = [];
  const completed = new Set<FileCheckpoint>();
  const failed = new Set<string>();
  for (let i = affected.length - 1; i >= 0; i--) {
    const cp = affected[i]!;
    // A failed newer checkpoint must not be skipped to restore an older version.
    if (failed.has(cp.path)) continue;
    try {
      await withFileMutation(cp.path, async () => {
        const current = await readFile(cp.path, 'utf8').catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        // Already restored (e.g. crash between file restore and checkpoint flush).
        if (current === cp.oldContent) return;
        if (
          cp.expectedHash === undefined ||
          current === null ||
          hash(current) !== cp.expectedHash
        ) {
          throw new Error('File version conflict');
        }
        if (cp.oldContent === null) {
          try {
            await unlink(cp.path);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        } else {
          await writeFile(cp.path, cp.oldContent, 'utf-8');
        }
      });
      restored.push(cp.path);
      completed.add(cp);
    } catch {
      failed.add(cp.path);
    }
  }
  // Preserve failed checkpoints and any records added while awaiting file I/O.
  store.set(
    key,
    ensureLoaded(key).filter((cp) => !completed.has(cp)),
  );
  flush(key);
  if (failed.size > 0) throw new FileRollbackError(restored, [...failed]);
  return restored;
}
