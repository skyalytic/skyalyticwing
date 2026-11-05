// 会话级项目文件夹绑定（IDE 工程模式）：
//   - 一个项目文件夹可被多个会话绑定（多会话共用同一工程）
//   - 一个会话同时只能绑定一个项目文件夹（重新选择即换绑）
// 持久化：${dataDir}/session-projects.json（Map<sessionId, dir>），应用重启后保留。
// 优先级：会话绑定 > 全局 projectDir（config general.projectDir）> 智能体工作目录。
import { resolve } from 'node:path';
import { readJsonRecover, writeJsonAtomicSync } from '../utils/atomic-json.util.js';
import { getDefaultDataDir } from '../utils/web-data.util.js';

const store = new Map<string, string>();
let loadedFile = '';

function storeFile(): string {
  return resolve(getDefaultDataDir(), 'session-projects.json');
}

function ensureLoaded(): void {
  const f = storeFile();
  if (loadedFile === f) return;
  const raw = readJsonRecover<Record<string, string>>(f, {});
  store.clear();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') store.set(k, v);
  }
  loadedFile = f;
}

function persist(): void {
  writeJsonAtomicSync(storeFile(), Object.fromEntries(store));
}

/** 读取会话绑定的项目文件夹（未绑定返回空串） */
export function getSessionProjectDir(sessionId?: string): string {
  if (!sessionId) return '';
  ensureLoaded();
  return store.get(sessionId) || '';
}

export function listSessionProjectDirs(): string[] {
  ensureLoaded();
  return [...new Set(store.values())];
}

/** 绑定会话的项目文件夹（重新选择即换绑；一个会话同时只有一个） */
export function setSessionProjectDir(sessionId: string, dir: string): void {
  if (!sessionId || !dir) return;
  ensureLoaded();
  const previous = store.get(sessionId);
  store.set(sessionId, resolve(dir));
  try {
    persist();
  } catch (error) {
    if (previous === undefined) store.delete(sessionId);
    else store.set(sessionId, previous);
    throw error;
  }
}

/** 解绑会话的项目文件夹 */
export function removeSessionProjectDir(sessionId: string): boolean {
  if (!sessionId) return false;
  ensureLoaded();
  const previous = store.get(sessionId);
  const had = store.delete(sessionId);
  if (had)
    try {
      persist();
    } catch (error) {
      store.set(sessionId, previous!);
      throw error;
    }
  return had;
}
