import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, rename, stat, statfs, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withFileMutation } from './checkpoint-store.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { updateMaintenance } from '../../core/system/update-maintenance.js';

export const TEXT_PAGE_BYTES = 256 * 1024;
export const TEXT_PAGE_READ_BYTES = 128 * 1024;
export const FULL_TEXT_BYTES = 5 * 1024 * 1024;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const revisionOf = (s: Awaited<ReturnType<FileHandle['stat']>>) => hash([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'));
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const continuation = (b: number) => (b & 0xc0) === 0x80;
export interface TextPage { offset: number; end: number; size: number; content: string; revision: string; segmentHash: string }
export interface TextPatch { path: string; offset: number; end: number; revision: string; segmentHash: string; content: string }
type SaveJob = { id: string; path: string; state: 'saving' | 'saved' | 'error'; copied: number; total: number; error?: string; finished?: number; pending?: TextPatch; result?: TextPage; bases: Set<string> };

/** Bounded-memory text pages and atomic streamed replacement. No whole-file decoding or hashing. */
export class LargeTextStore {
  private jobs = new Map<string, SaveJob>();
  constructor(private readonly allowed: (path: string, write: boolean) => boolean) {
    updateMaintenance.register('大文件写入', () => [...this.jobs.values()].filter(j => j.state === 'saving').length);
  }
  private draftPath(path: string) { return resolve(getDefaultDataDir(), 'editor-drafts', `${hash(path)}.json`); }
  private base(patch: TextPatch) { return `${patch.revision}:${patch.offset}:${patch.end}:${patch.segmentHash}`; }
  async draft(raw: string) {
    const path = await this.checked(raw);
    const patch = readJsonRecover<TextPatch | null>(this.draftPath(path), null);
    const job = [...this.jobs.values()].find(j => j.path === path && j.state === 'saving');
    return { patch, jobId: job?.id };
  }
  private async checked(raw: string, write = false) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new BadRequestException('文件路径无效');
    const absolute = resolve(raw);
    if (!this.allowed(absolute, write)) throw new ForbiddenException('Path not allowed');
    const canonical = await realpath(absolute);
    if (!this.allowed(canonical, write)) throw new ForbiddenException('Path not allowed');
    return canonical;
  }
  async info(raw: string) {
    const path = await this.checked(raw), s = await stat(path);
    if (!s.isFile() || !Number.isSafeInteger(s.size)) throw new BadRequestException('不是支持的普通文件');
    return { size: s.size, segmented: s.size > FULL_TEXT_BYTES };
  }
  async page(raw: string, requested = 0): Promise<TextPage> {
    if (!integer(requested)) throw new BadRequestException('文件位置无效');
    const path = await this.checked(raw), file = await open(path, 'r');
    try {
      const before = await file.stat();
      if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new BadRequestException('不是支持的普通文件');
      const target = Math.min(requested, before.size);
      const start = Math.max(0, target - 3);
      const bytes = Buffer.alloc(Math.min(TEXT_PAGE_READ_BYTES + 7, before.size - start));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      let from = target - start;
      while (from > 0 && from < bytesRead && continuation(bytes[from]!)) from--;
      if (from > 0 && bytes[from] === 10 && bytes[from - 1] === 13) from--;
      let to = Math.min(bytesRead, from + TEXT_PAGE_READ_BYTES);
      while (to > from && to < bytesRead && continuation(bytes[to]!)) to--;
      if (to > from && to < bytesRead && bytes[to - 1] === 13 && bytes[to] === 10) to--;
      const segment = bytes.subarray(from, to);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(segment); }
      catch { throw new BadRequestException('当前分段不是有效 UTF-8 文本，请使用对应编码的外部编辑器'); }
      if (segment.includes(0)) throw new BadRequestException('当前分段包含二进制内容，不能作为文本编辑');
      if (revisionOf(before) !== revisionOf(await file.stat())) throw new ConflictException('读取期间文件已改变，请重新加载');
      return { offset: start + from, end: start + to, size: before.size, content, revision: revisionOf(before), segmentHash: hash(segment) };
    } finally { await file.close(); }
  }
  async start(patch: TextPatch) {
    if (!patch || !integer(patch.offset) || !integer(patch.end) || patch.end < patch.offset || patch.end - patch.offset > TEXT_PAGE_BYTES ||
        typeof patch.content !== 'string' || Buffer.byteLength(patch.content) > TEXT_PAGE_BYTES || patch.content.includes('\0') ||
        !/^[a-f0-9]{64}$/.test(patch.revision || '') || !/^[a-f0-9]{64}$/.test(patch.segmentHash || '')) throw new BadRequestException('分段保存参数无效，单段最多 256 KiB');
    const path = await this.checked(patch.path, true);
    for (const [id, job] of this.jobs) if (job.finished && Date.now() - job.finished > 3600_000) this.jobs.delete(id);
    const existing = [...this.jobs.values()].reverse().find(j => j.path === path);
    if (existing?.bases.has(this.base(patch)) && existing.result) {
      patch = { ...patch, revision: existing.result.revision, end: existing.result.end, segmentHash: existing.result.segmentHash };
    }
    if (existing?.state === 'saving') {
      if (!existing.bases.has(this.base(patch))) throw new ConflictException('另一个分段正在保存，请等待完成');
      writeJsonAtomicSync(this.draftPath(path), { ...patch, path });
      existing.pending = { ...patch, path };
      return { id: existing.id };
    }
    if ([...this.jobs.values()].filter(j => j.state === 'saving').length >= 2) throw new ConflictException('已有两个大文件正在保存，请稍后重试');
    writeJsonAtomicSync(this.draftPath(path), { ...patch, path });
    if (this.jobs.size >= 100) this.jobs.delete(this.jobs.keys().next().value!);
    const job: SaveJob = { id: randomUUID(), path, state: 'saving', copied: 0, total: 0, pending: { ...patch, path }, bases: new Set([this.base(patch)]) };
    this.jobs.set(job.id, job);
    void withFileMutation(path, async () => {
      while (job.pending) {
        const batch = job.pending; delete job.pending; job.copied = 0;
        await this.replace(path, batch, job);
        const updated = await stat(path);
        job.result = { content: batch.content, offset: batch.offset, end: batch.offset + Buffer.byteLength(batch.content), size: updated.size, revision: revisionOf(updated), segmentHash: hash(batch.content) };
        job.bases.add(this.base({ ...batch, ...job.result }));
        if (job.pending) {
          const queued = job.pending as TextPatch;
          job.pending = { ...queued, revision: job.result.revision, end: job.result.end, segmentHash: job.result.segmentHash };
          writeJsonAtomicSync(this.draftPath(path), job.pending);
        } else writeJsonAtomicSync(this.draftPath(path), null);
      }
      job.state = 'saved';
    }).then(() => {}, error => {
      job.state = 'error'; job.error = error instanceof Error ? error.message : String(error);
    }).finally(() => { job.finished = Date.now(); });
    return { id: job.id };
  }
  async status(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('保存任务不存在，请重新读取文件核对保存结果');
    await this.checked(job.path);
    const { path: _path, pending: _pending, bases: _bases, ...publicJob } = job;
    return publicJob;
  }
  private async replace(path: string, patch: TextPatch, job: SaveJob) {
    let input: FileHandle | undefined, output: FileHandle | undefined;
    const temporary = `${path}.wing-save-${job.id}.tmp`;
    try {
      input = await open(path, 'r');
      const initial = await input.stat();
      if (!initial.isFile() || initial.nlink > 1) throw new BadRequestException('不支持分段替换此文件或硬链接文件');
      if (revisionOf(initial) !== patch.revision || patch.end > initial.size) throw new ConflictException('文件已被外部修改，请保留草稿并重新加载');
      const original = Buffer.alloc(patch.end - patch.offset);
      const old = await input.read(original, 0, original.length, patch.offset);
      if (old.bytesRead !== original.length || hash(original) !== patch.segmentHash) throw new ConflictException('当前分段已改变');
      // Reject cuts inside UTF-8 code points even for crafted API requests.
      try { new TextDecoder('utf-8', { fatal: true }).decode(original); } catch { throw new BadRequestException('不能在 UTF-8 字符内部切分'); }
      if (patch.end < initial.size) {
        const next = Buffer.alloc(1); await input.read(next, 0, 1, patch.end);
        if (continuation(next[0]!)) throw new BadRequestException('不能在 UTF-8 字符内部切分');
      }
      const replacement = Buffer.from(patch.content);
      job.total = initial.size - original.length + replacement.length;
      const space = await statfs(dirname(path));
      if (space.bavail * space.bsize < job.total + 16 * 1024 * 1024) throw new BadRequestException('磁盘空间不足，安全保存需要额外容纳一份文件');
      output = await open(temporary, 'wx', initial.mode);
      const buffer = Buffer.alloc(1024 * 1024);
      const writeAll = async (bytes: Buffer) => {
        let done = 0;
        while (done < bytes.length) { const r = await output!.write(bytes, done, bytes.length - done); if (!r.bytesWritten) throw new Error('写入失败'); done += r.bytesWritten; job.copied += r.bytesWritten; }
      };
      const copy = async (from: number, end: number) => {
        while (from < end) {
          const { bytesRead } = await input!.read(buffer, 0, Math.min(buffer.length, end - from), from);
          if (!bytesRead) throw new ConflictException('保存期间文件已改变');
          await writeAll(buffer.subarray(0, bytesRead)); from += bytesRead;
        }
      };
      await copy(0, patch.offset); await writeAll(replacement); await copy(patch.end, initial.size);
      await output.sync(); await output.close(); output = undefined;
      if (revisionOf(await input.stat()) !== patch.revision || revisionOf(await stat(path)) !== patch.revision) throw new ConflictException('保存期间文件已被外部修改，未覆盖原文件');
      await input.close(); input = undefined;
      await rename(temporary, path);
    } finally {
      await output?.close(); await input?.close(); await unlink(temporary).catch(() => {});
    }
  }
}
