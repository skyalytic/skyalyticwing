export type RecoveryTab = { id: string; url: string };
type Manifest = { tabs: string[]; active: number };
const key = 'wing-browser-recovery-v1';
function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (
      [...url.searchParams.keys()].some((k) =>
        /token|key|auth|code|secret|password|signature|session|ticket|credential/i.test(k),
      )
    )
      return null;
    url.hash = '';
    return url.href.length < 4096 ? url.href : null;
  } catch {
    return null;
  }
}
export class BrowserRecovery {
  private restoring = new Map<string, Promise<void>>();
  private ready = new Set<string>();
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>) {}
  private read(): Record<string, Manifest> {
    try {
      const v = JSON.parse(this.storage.getItem(key) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  save(session: string, tabs: RecoveryTab[], activeId: string | null): void {
    if (this.restoring.has(session)) return;
    const safe = tabs
      .slice(0, 12)
      .map((t) => ({ ...t, url: safeUrl(t.url) }))
      .filter((t) => t.url);
    const manifest = this.read();
    delete manifest[session];
    manifest[session] = {
      tabs: safe.map((t) => t.url!),
      active: Math.max(
        0,
        safe.findIndex((t) => t.id === activeId),
      ),
    };
    try {
      this.storage.setItem(
        key,
        JSON.stringify(Object.fromEntries(Object.entries(manifest).slice(-25))),
      );
    } catch {
      /* storage may be disabled */
    }
  }
  async restore(
    session: string,
    invoke: (op: string, args: Record<string, unknown>) => Promise<any>,
  ): Promise<void> {
    if (this.ready.has(session)) return;
    const pending = this.restoring.get(session);
    if (pending) return pending;
    const promise = (async () => {
      const state = await invoke('state', {});
      if (!state || !Array.isArray(state.tabs)) throw Error('Invalid browser state');
      if (!state.tabs.length) {
        const manifest = this.read()[session];
        const urls = Array.isArray(manifest?.tabs)
          ? manifest.tabs.slice(0, 12).map(safeUrl).filter(Boolean)
          : [];
        const ids: string[] = [];
        for (const url of urls) {
          const pageId = crypto.randomUUID();
          await invoke('navigate', { url, pageId });
          ids.push(pageId);
        }
        const active = ids[manifest?.active ?? 0];
        if (active) await invoke('activate', { pageId: active });
      }
      this.ready.add(session);
    })();
    this.restoring.set(session, promise);
    try {
      await promise;
    } finally {
      this.restoring.delete(session);
    }
  }
}
