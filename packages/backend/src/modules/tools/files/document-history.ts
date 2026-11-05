import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { createTwoFilesPatch, diffLines } from 'diff';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';

export interface FileVersion { hash: string; size: number }
export interface DocumentChange {
  id: string; path: string; at: number; source: string;
  sessionId?: string;
  before: FileVersion | null; after: FileVersion | null;
  state: 'prepared' | 'applied' | 'undone';
}
const root = () => join(getDefaultDataDir(), 'document-history');
const context = new AsyncLocalStorage<string>();
export const documentSession = () => context.getStore();
export function withDocumentSession<T>(sessionId: string | undefined, run: () => T): T { return context.run(sessionId || '', run); }
let lastAt = 0;
const timestamp = () => (lastAt = Math.max(Date.now(), lastAt + 0.001));
const observers = new Set<(path: string, version: FileVersion | null) => void>();
export function observeDocumentSaves(listener: (path: string, version: FileVersion | null) => void) { observers.add(listener); return () => { observers.delete(listener); }; }
function changed(path: string, version: FileVersion | null) { for (const listener of observers) listener(path, version); }
const recordPath = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadRequestException('变更编号无效');
  return join(root(), 'records', id + '.json');
};
const blobPath = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new BadRequestException('快照校验值无效');
  return join(root(), 'blobs', hash);
};
export function fileVersion(path: string): FileVersion | null {
  let fd: number;
  try { if (!lstatSync(path).isFile()) throw new BadRequestException('仅支持普通文件的版本恢复'); fd = openSync(path, 'r'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try {
    const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let size = 0, n: number;
    while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) { hash.update(chunk.subarray(0, n)); size += n; }
    return { hash: hash.digest('hex'), size };
  } finally { closeSync(fd); }
}
function same(a: FileVersion | null, b: FileVersion | null) { return a?.hash === b?.hash; }
/** Content-addressed snapshots, no age/count eviction; stream hashing avoids loading large files. */
export function snapshotFile(path: string): FileVersion | null {
  const version = fileVersion(path);
  if (!version) return null;
  const dest = blobPath(version.hash);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    const temp = dest + '.' + randomUUID() + '.tmp';
    try {
      copyFileSync(path, temp);
      if (!same(fileVersion(temp), version)) throw new ConflictException('文件正在被其他程序修改，请稍后重试');
      const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, dest);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  return version;
}
export function beginDocumentChange(path: string, source = 'Wing 编辑与工具'): DocumentChange {
  const sessionId = documentSession();
  const change: DocumentChange = { id: randomUUID(), path: resolve(path), at: timestamp(), source: sessionId ? 'AI 对话修改' : source, ...(sessionId ? { sessionId } : {}), before: snapshotFile(path), after: null, state: 'prepared' };
  writeJsonAtomicSync(recordPath(change.id), change);
  return change;
}
export function finishDocumentChange(change: DocumentChange) {
  change.after = snapshotFile(change.path);
  if (same(change.before, change.after)) { unlinkSync(recordPath(change.id)); return; }
  change.state = 'applied';
  writeJsonAtomicSync(recordPath(change.id), change);
  changed(change.path, change.after);
}
export function recordObservedChange(path: string, before: FileVersion | null, after: FileVersion | null, sessionId?: string) {
  if (same(before, after)) return;
  const c: DocumentChange = { id: randomUUID(), path: resolve(path), at: timestamp(), source: sessionId ? 'AI 命令修改' : '终端 / 项目文件变化', ...(sessionId ? { sessionId } : {}), before, after, state: 'applied' };
  writeJsonAtomicSync(recordPath(c.id), c); changed(c.path, after);
}
// Nested save helpers already run inside withFileMutation: only record the outer mutation.
const active = new Set<string>();
const key = (p: string) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
export const recordingDocument = (path: string) => active.has(key(path));
export async function trackDocumentMutation<T>(path: string, run: () => Promise<T>): Promise<T> {
  if (active.has(key(path))) return run();
  const change = beginDocumentChange(path); active.add(key(path));
  try { return await run(); } finally { active.delete(key(path)); finishDocumentChange(change); }
}
export function trackDocumentMutationSync<T>(path: string, run: () => T, source?: string): T {
  if (active.has(key(path))) return run();
  const change = beginDocumentChange(path, source); active.add(key(path));
  try { return run(); } finally { active.delete(key(path)); finishDocumentChange(change); }
}
export function insideProject(dir: string, path: string) {
  const rel = relative(resolve(dir), resolve(path));
  return !!rel && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel);
}
export function readDocumentChange(id: string): DocumentChange {
  const change = readJsonRecover<DocumentChange | null>(recordPath(id), null);
  if (!change || change.id !== id) throw new BadRequestException('变更记录不存在');
  return change;
}
export function listDocumentChanges(dir: string) {
  const folder = join(root(), 'records');
  const changes = existsSync(folder) ? readdirSync(folder).filter(n => n.endsWith('.json')).map(n => readDocumentChange(n.slice(0, -5))).filter(c => insideProject(dir, c.path)) : [];
  return changes.sort((a,b) => b.at - a.at).map(c => ({ ...c, name: relative(dir, c.path), binary: isBinary(c) }));
}
/** Restore a whole conversation suffix in reverse order, validating the complete chain first. */
export async function rollbackDocumentSession(sessionId: string, sinceTs: number, allowed: (path: string) => boolean) {
  const folder = join(root(), 'records');
  const changes = (existsSync(folder) ? readdirSync(folder).filter(n => n.endsWith('.json')).map(n => readDocumentChange(n.slice(0, -5))) : [])
    .filter(c => c.sessionId === sessionId && c.at >= sinceTs && c.state !== 'undone').sort((a, b) => b.at - a.at);
  if (!changes.length) return [];
  const paths = [...new Set(changes.map(c => c.path))].sort();
  const { withFileMutation } = await import('./checkpoint-store.js');
  const lockAll = async (i: number): Promise<string[]> => {
    if (i < paths.length) return withFileMutation(paths[i]!, () => lockAll(i + 1), false);
    const simulated = new Map<string, FileVersion | null>();
    for (const c of changes) {
      if (!allowed(c.path)) throw new ConflictException('部分文件已失去写入权限，未撤销对话');
      const current = simulated.has(c.path) ? simulated.get(c.path)! : fileVersion(c.path);
      if (c.state === 'prepared' || !same(current, c.after)) throw new ConflictException('文件在这些对话之外还有修改，未撤销任何文件；请先合并或撤销其他修改');
      if (c.before && !same(fileVersion(blobPath(c.before.hash)), c.before)) throw new ConflictException('历史快照缺失或损坏，未撤销任何文件');
      simulated.set(c.path, c.before);
    }
    for (const c of changes) restoreDocumentChange(c.id);
    return paths;
  };
  return lockAll(0);
}
function isBinary(c: DocumentChange) {
  if (/\.(docx?|xlsx?|pptx?|pdf|png|jpg|jpeg|gif|zip|db|sqlite)$/i.test(c.path)) return true;
  return [c.before, c.after].some(v => v && (v.size > 1024 * 1024 || readFileSync(blobPath(v.hash)).includes(0)));
}
function compareText(before: string, after: string, left = '修改前', right = '修改后') {
  if (before.length + after.length > 2 * 1024 * 1024) return null;
  const options = { timeout: 200, maxEditLength: 10000 };
  const parts = diffLines(before, after, options);
  if (!parts) return null;
  const diff = createTwoFilesPatch(left, right, before, after, '', '', { context: 4, ...options });
  if (diff === undefined) return null;
  let added = 0, removed = 0;
  for (const part of parts) { if (part.added) added += part.count || 0; if (part.removed) removed += part.count || 0; }
  return { diff, added, removed };
}
export function documentChangeDetail(id: string) {
  const c = readDocumentChange(id);
  let binary = isBinary(c);
  const current = fileVersion(c.path);
  const compatible = c.state !== 'prepared' && same(current, c.state === 'undone' ? c.before : c.after);
  let diff = '', added = 0, removed = 0;
  if (!binary && c.state !== 'prepared') {
    const before = c.before ? readFileSync(blobPath(c.before.hash), 'utf8') : '';
    const after = c.after ? readFileSync(blobPath(c.after.hash), 'utf8') : '';
    const compared = compareText(before, after);
    if (compared) ({ diff, added, removed } = compared); else binary = true;
  }
  return { ...c, binary, compatible, diff, added, removed,
    reason: c.state === 'prepared' ? '操作中断，保留了修改前快照；可下载后人工恢复' : compatible ? '' : '当前文件已有后续修改或被移动；请先撤销较新的变更，或下载快照另行合并' };
}
/** Caller must hold withFileMutation and validate current path authorization. */
export function restoreDocumentChange(id: string) {
  const c = readDocumentChange(id);
  if (c.state === 'prepared') throw new ConflictException('中断的操作不能直接撤销，请下载快照人工恢复');
  const target = c.state === 'undone' ? c.after : c.before;
  const expected = c.state === 'undone' ? c.before : c.after;
  if (!same(fileVersion(c.path), expected)) throw new ConflictException('当前文件已有后续修改，未覆盖；请先撤销较新的变更或下载快照合并');
  if (target) {
    if (!same(fileVersion(blobPath(target.hash)), target)) throw new ConflictException('快照缺失或校验失败，原文件未改动');
    const temp = c.path + '.wing-restore-' + randomUUID();
    try { copyFileSync(blobPath(target.hash), temp); renameSync(temp, c.path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  } else if (existsSync(c.path)) unlinkSync(c.path);
  c.state = c.state === 'undone' ? 'applied' : 'undone';
  writeJsonAtomicSync(recordPath(c.id), c);
  changed(c.path, target);
  return c;
}
export function documentSnapshot(id: string, version: string) {
  const c = readDocumentChange(id), v = version === 'before' ? c.before : version === 'after' ? c.after : null;
  if (!v) throw new BadRequestException('该版本没有文件');
  const path = blobPath(v.hash);
  if (!same(fileVersion(path), v)) throw new ConflictException('快照缺失或校验失败');
  return { path, name: c.path.split(/[\\/]/).pop() || 'snapshot' };
}

export async function documentChangeReview(id: string) {
  const detail = documentChangeDetail(id);
  if (!/\.(docx|xlsx|pptx)$/i.test(detail.path) || detail.state === 'prepared') return { ...detail, officeText: false, reviewNote: '' };
  try {
    const { OfficeService } = await import('./office.service.js');
    // This method parses buffers only; original path authorization is enforced by the controller.
    const office = new OfficeService(undefined as never);
    const format = detail.path.split('.').pop()!.toLowerCase();
    const before = detail.before ? await office.historyText(readFileSync(blobPath(detail.before.hash)), format) : '';
    const after = detail.after ? await office.historyText(readFileSync(blobPath(detail.after.hash)), format) : '';
    const compared = compareText(before, after, '修改前内容', '修改后内容');
    if (!compared) return { ...detail, officeText: false, reviewNote: '内容较多，请下载前后版本对照；完整文件仍可恢复。' };
    return { ...detail, officeText: true, ...compared, reviewNote: '下方比较文档文字、单元格值和公式；图片与版式请下载前后版本查看。撤销恢复完整文件。' };
  } catch { return { ...detail, officeText: false, reviewNote: '该文档无法提取文字差异，完整快照仍可下载和恢复。' }; }
}
