import type { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Process-wide admission barrier. Existing sessions may finish their own tools. */
export class UpdateMaintenance {
  private phase: 'idle' | 'draining' | 'frozen' = 'idle';
  private owner = '';
  private touched = 0;
  private next = 0;
  private context = new AsyncLocalStorage<number>();
  private activities = new Map<number, { name: string; session?: string }>();
  private probes = new Map<string, () => number>();
  shutdown?: () => Promise<void>;
  register(name: string, count: () => number) { this.probes.set(name, count); return () => { this.probes.delete(name); }; }
  get pending() { this.expire(); return this.phase !== 'idle'; }
  enter(name: string, session?: string, continuation = false) {
    this.expire();
    const existing = this.activities.has(this.context.getStore() ?? -1) || (continuation && session && [...this.activities.values()].some(a => a.session === session));
    if (this.phase === 'frozen' || (this.phase === 'draining' && !existing)) throw Error('正在准备更新，请等待更新完成或取消更新后再试');
    const id = ++this.next; this.activities.set(id, { name, ...(session ? { session } : {}) });
    return () => { this.activities.delete(id); };
  }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    const leave = this.enter(name);
    const id = this.next;
    try { return await this.context.run(id, action); } finally { leave(); }
  }
  private expire() { if (this.phase !== 'idle' && Date.now() - this.touched > 120_000) this.cancel(this.owner); }
  begin(owner: string) {
    this.expire();
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(owner)) throw Error('Invalid update request');
    if (this.pending && this.owner !== owner) throw Error('已有更新正在准备');
    this.owner = owner; this.touched = Date.now(); this.phase = 'draining';
    return this.status(owner);
  }
  status(owner: string) {
    this.expire();
    if (!this.pending || owner !== this.owner) throw Error('更新准备已取消或超时，请重试');
    this.touched = Date.now();
    const blockers = [...new Set([...this.activities.values()].map(a => a.name))];
    for (const [name, count] of this.probes) if (count() > 0) blockers.push(name);
    return { phase: this.phase, blockers };
  }
  freeze(owner: string) {
    const state = this.status(owner);
    if (state.blockers.length) throw Error('仍有任务或文件保存正在进行：' + state.blockers.join('、'));
    this.phase = 'frozen'; return { ready: true };
  }
  stop(owner: string) {
    const status = this.status(owner);
    if (status.phase !== 'frozen' || status.blockers.length || !this.shutdown) throw Error('尚未完成更新准备');
    setTimeout(() => { void this.shutdown?.(); }, 300);
  }
  cancel(owner: string) {
    if (owner === this.owner) { this.phase = 'idle'; this.owner = ''; }
  }
  middleware = (req: Request, res: Response, next: NextFunction) => {
    this.expire();
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/update/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    // Document guards must be able to flush before the final freeze. New work is refused.
    const saving = /^\/api\/(files\/(write|office|design-save|text-draft|text-patch|text-autosave)|office-native\/sessions\/[^/]+\/(command|events)|office-engine\/wopi\/files\/)/.test(req.path);
    const closing = req.path.startsWith("/api/terminal/") && (req.method === 'DELETE' || req.path.endsWith('/close'));
    if (this.phase === 'frozen' || (this.phase === 'draining' && !saving && !closing)) {
      res.status(503).json({ success: false, error: '正在准备更新，当前操作暂缓；取消更新后可继续' }); return;
    }
    const id = ++this.next; this.activities.set(id, {name: '正在保存或处理请求'});
    const done = () => { this.activities.delete(id); };
    res.once('finish', done); res.once('close', done); next();
  };
}
export const updateMaintenance = new UpdateMaintenance();
