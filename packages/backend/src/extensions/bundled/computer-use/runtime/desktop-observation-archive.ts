import { createHash } from 'node:crypto';
import { mkdir, readdir, lstat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import type { ToolResult } from '@skyalyticwing/shared';
import { getDefaultDataDir } from '../../../../modules/core/utils/web-data.util.js';

type Limits = { maxBytes: number; maxImages: number; maxAgeMs: number };
const defaults: Limits = { maxBytes: 128 * 1024 * 1024, maxImages: 200, maxAgeMs: 7 * 24 * 60 * 60 * 1000 };
const owned = /^[a-f0-9]{32}-[a-f0-9-]{36}\.(png|jpg|json)$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Local, bounded diagnostic copies of the exact encoded tool images, never re-encoded or uploaded. */
export class DesktopObservationArchive {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly limits: Limits = defaults) {}
  record(result: ToolResult, sessionId: string): Promise<ToolResult> {
    const run = this.queue.then(() => this.save(result, sessionId));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async save(result: ToolResult, sessionId: string): Promise<ToolResult> {
    const data = result.data as Record<string, any> | undefined;
    const shot = data?.['visualObservation'];
    if (!shot || shot.kind !== 'desktop') return result;
    try {
      if (!sessionId || !uuid.test(shot.screenshotId) || !['image/png', 'image/jpeg'].includes(shot.mimeType)
        || typeof shot.base64 !== 'string' || !shot.base64.length || shot.base64.length > 4_000_000) throw new Error('Invalid diagnostic image');
      const bytes = Buffer.from(shot.base64, 'base64');
      if (!bytes.length || bytes.toString('base64') !== shot.base64) throw new Error('Invalid image encoding');
      const directory = resolve(this.directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked diagnostic directory');
      const base = createHash('sha256').update(sessionId).digest('hex').slice(0, 32) + '-' + shot.screenshotId.toLowerCase();
      const path = join(directory, base + (shot.mimeType === 'image/png' ? '.png' : '.jpg'));
      const metadataPath = join(directory, base + '.json');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const metadata = Buffer.from(JSON.stringify({ sessionId, screenshotId: shot.screenshotId, sha256, mimeType: shot.mimeType,
        width: shot.width, height: shot.height, capturedAt: shot.capturedAt, storedAt: Date.now(),
        derivedFrom: shot.derivedFrom, region: shot.region, stage: 'tool_observation', imageFile: path }, null, 2));
      if (bytes.length + metadata.length > this.limits.maxBytes) throw new Error('Image exceeds archive quota');
      await this.prune(directory, bytes.length + metadata.length);
      // Exclusive writes cannot follow a file link or replace an earlier diagnostic image.
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      try { await writeFile(metadataPath, metadata, { flag: 'wx', mode: 0o600 }); }
      catch (error) { await unlink(path); throw error; }
      return { ...result, data: { ...data, screenshotFile: path, screenshotSha256: sha256 } };
    } catch {
      // A disk failure never changes the outcome of an input or invites replay.
      return { ...result, data: { ...data, screenshotArchive: 'unavailable' } };
    }
  }
  private async prune(directory: string, reservedBytes: number) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !owned.test(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (dirname(path) !== directory) throw new Error('Invalid diagnostic path');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      files.push({ path, base: entry.name.replace(/\.(png|jpg|json)$/, ''), size: stat.size, at: stat.mtimeMs });
    }
    const groups = new Map<string, typeof files>();
    for (const file of files) groups.set(file.base, [...(groups.get(file.base) || []), file]);
    let bytes = files.reduce((sum, f) => sum + f.size, 0), count = groups.size;
    const ordered = [...groups.values()].sort((a, b) => Math.max(...a.map(f => f.at)) - Math.max(...b.map(f => f.at)));
    for (const group of ordered) {
      const expired = Math.max(...group.map(f => f.at)) < Date.now() - this.limits.maxAgeMs;
      if (!expired && bytes + reservedBytes <= this.limits.maxBytes && count < this.limits.maxImages) break;
      for (const file of group) { await unlink(file.path); bytes -= file.size; }
      count--;
    }
  }
}

let archive: DesktopObservationArchive | undefined;
export function archiveDesktopObservation(result: ToolResult, sessionId: string): Promise<ToolResult> {
  archive ||= new DesktopObservationArchive(join(getDefaultDataDir(), 'diagnostics', 'computer-use'));
  return archive.record(result, sessionId);
}
