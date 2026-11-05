import { existsSync, lstatSync, readdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { documentSession, observeDocumentSaves, recordObservedChange, snapshotFile, type FileVersion } from './document-history.js';

const watches = new Map<string, { refs: number; close: () => void; flush: () => void; owners: Map<string, number>; warning: string }>();
const ignored = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.cache', '.rollback', 'document-history']);


/** Watch the authorized command working directory, never follow links or traverse dependencies. */
export function watchProjectChanges(directory: string, allowed: (path: string) => boolean = () => true, sessionId = documentSession() || '') {
  const root = resolve(directory); let entry = watches.get(root);
  if (!entry) {
    const known = new Map<string, FileVersion | null>(); let incompleteBaseline = false;
    let baselinePending = true, baselineTimer: ReturnType<typeof setImmediate> | undefined;
    const baselineQueue = [root];
    const changedBeforeSnapshot = new Set<string>();
    const changedWithoutBaseline = (path: string) => [...changedBeforeSnapshot].some(changed => path === changed || path.startsWith(changed + (process.platform === 'win32' ? '\\' : '/')));
    const owners = new Map<string, number>();
    const owner = () => owners.size === 1 ? [...owners.keys()][0] || undefined : undefined;
    const warnings = new Set<string>(); let watcher: FSWatcher | undefined;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const eligible = (path: string) => !relative(root, path).split(/[\\/]/).some(n => ignored.has(n) || n.startsWith('.rollback') || n.includes('.wing-')) && allowed(path);
    const scan = (path: string, baseline = false) => {
      if (!eligible(path)) return;
      if (baseline && changedWithoutBaseline(path)) return;
      if (!baseline && !known.has(path) && (incompleteBaseline || baselinePending || changedWithoutBaseline(path))) {changedBeforeSnapshot.add(path);warnings.add('部分文件在初始快照完成前已变化，无法还原其旧内容；命令执行不受影响');return;}
      try {
        if (!existsSync(path)) {
          for (const [p, before] of known) if (p === path || p.startsWith(path + (process.platform === 'win32' ? '\\' : '/'))) { if (before) recordObservedChange(p, before, null, owner()); known.set(p, null); }
          return;
        }
        const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) { for (const child of readdirSync(path)) scan(join(path, child), baseline); return; }
        if (!stat.isFile()) return;
        const before = known.get(path) || null, after = snapshotFile(path);
        known.set(path, after);
        if (!baseline) recordObservedChange(path, before, after, owner());
      } catch (e) { if (baseline) incompleteBaseline = true; warnings.add('部分文件未能保存终端快照：' + (e instanceof Error ? e.message : String(e))); }
    };
    // Yield between baseline files so scanning a large workspace cannot stall shell startup.
    // This is scheduling, not a scan cap: all eligible files continue to be visited.
    const baseline = () => {
      const until = Date.now() + 12;
      do {
        const path = baselineQueue.pop(); if (!path) break;
        if (!eligible(path) || changedWithoutBaseline(path)) continue;
        try {
          const stat=lstatSync(path);if(stat.isSymbolicLink())continue;
          if(stat.isDirectory()) {for(const name of readdirSync(path)) baselineQueue.push(join(path,name));}
          else scan(path,true);
        } catch(error) {incompleteBaseline=true;warnings.add('部分文件未能保存初始快照：'+String(error));}
      } while (baselineQueue.length && Date.now()<until);
      baselinePending=baselineQueue.length>0;
      if(baselinePending){baselineTimer=setImmediate(baseline);baselineTimer.unref();}
    };
    baseline();
    const unsubscribe = observeDocumentSaves((path, version) => { if (known.has(path) || (path.startsWith(root + (process.platform === 'win32' ? '\\' : '/')) && eligible(path))) known.set(path, version); });
    try {
      // libuv on Windows can abort the process when watching an 8.3 alias such as ADMINI~1.
      // Resolve the native watch path while retaining caller paths for history records.
      watcher = watch(realpathSync.native(root), { recursive: true }, (_event, name) => {
        if (!name) return;
        const path = join(root, String(name));
        if (!eligible(path)) return;
        if(baselinePending&&!known.has(path))changedBeforeSnapshot.add(path);
        clearTimeout(timers.get(path));
        timers.set(path, setTimeout(() => { timers.delete(path); scan(path); }, 180));
      });
      watcher.on('error', e => warnings.add('终端文件监测失败：' + e.message));
      watcher.unref();
    } catch { warnings.add('当前系统不支持项目文件监测；终端修改无法自动记录'); }
    const flush = () => { for (const [path, timer] of timers) { clearTimeout(timer); scan(path); } timers.clear(); };
    entry = { refs: 0, owners, flush, get warning() { return [...warnings,...(baselinePending?['文件历史初始扫描仍在后台进行，尚未扫描的旧内容暂不可恢复']:[])].join('；'); }, close: () => {
      clearImmediate(baselineTimer); baselineQueue.length=0; watcher?.close(); flush(); unsubscribe();
    } };
    watches.set(root, entry);
  }
  entry.refs++;
  entry.owners.set(sessionId, (entry.owners.get(sessionId) || 0) + 1);
  let closed = false;
  return { get warning() { return entry!.warning; }, close: () => { if (closed) return; closed = true; entry!.flush(); const n = (entry!.owners.get(sessionId) || 1) - 1; if (n) entry!.owners.set(sessionId, n); else entry!.owners.delete(sessionId); if (--entry!.refs === 0) { entry!.close(); watches.delete(root); } } };
}
