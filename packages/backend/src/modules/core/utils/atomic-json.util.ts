import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  // Legacy Windows editors can write JSON with a UTF-8/UTF-16 BOM.
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le')
    : bytes.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

/** Same-directory rename: readers see an entire old or new snapshot. Single writer per file. */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value), 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    backupValidJson(path);
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* renamed or never created */
    }
  }
}

function backupValidJson(path: string): void {
  if (!existsSync(path)) return;
  try {
    readJson(path);
  } catch {
    return;
  }
  const temp = `${path}.bak.${randomUUID()}.tmp`;
  try {
    copyFileSync(path, temp);
    renameSync(temp, `${path}.bak`);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* renamed */
    }
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(json, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // Do not overwrite a usable recovery copy with a corrupt primary.
    let valid = false;
    try {
      readJson(path);
      valid = true;
    } catch {
      /* absent/corrupt */
    }
    if (valid) {
      const backup = `${path}.bak.${randomUUID()}.tmp`;
      try {
        await copyFile(path, backup);
        await rename(backup, `${path}.bak`);
      } finally {
        await unlink(backup).catch(() => undefined);
      }
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Corruption is not silently treated as an empty store. Both copies failing throws. */
export function readJsonRecover<T>(path: string, fallback: T): T {
  if (!existsSync(path) && !existsSync(`${path}.bak`)) return fallback;
  try {
    return readJson(path) as T;
  } catch (primaryError) {
    try {
      return readJson(`${path}.bak`) as T;
    } catch (backupError) {
      throw new AggregateError([primaryError, backupError], 'Neither JSON store nor backup can be read', { cause: primaryError });
    }
  }
}
