import { describe, it, expect, vi } from 'vitest';
import { BrowserRecovery } from '../src/services/browser-recovery';
function store() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, v: string) => {
      value = v;
    },
  };
}
describe('browser recovery', () => {
  it('restores several tabs once, with new native page IDs, and restores the active tab', async () => {
    const storage = store(),
      recovery = new BrowserRecovery(storage);
    recovery.save(
      's',
      [
        { id: 'a', url: 'https://example.test/a' },
        { id: 'b', url: 'https://example.test/b' },
      ],
      'a',
    );
    const invoke = vi.fn(async (op: string) => (op === 'state' ? { tabs: [] } : undefined));
    await Promise.all([recovery.restore('s', invoke), recovery.restore('s', invoke)]);
    expect(invoke.mock.calls.filter((c) => c[0] === 'navigate')).toHaveLength(2);
    const calls = invoke.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(calls.filter((c) => c[0] === 'navigate')[0][1].pageId).not.toBe(
      calls.filter((c) => c[0] === 'navigate')[1][1].pageId,
    );
    expect(calls.at(-1)?.[0]).toBe('activate');
    await recovery.restore('s', invoke);
    expect(invoke.mock.calls).toHaveLength(4);
  });
  it('omits credential URLs and fragments, does not replay any input actions', async () => {
    const storage = store(),
      recovery = new BrowserRecovery(storage);
    recovery.save(
      's',
      [
        { id: 'a', url: 'https://example.test/a#secret' },
        { id: 'b', url: 'https://example.test/?access_token=secret' },
        { id: 'c', url: 'https://u:p@example.test/' },
        { id: 'd', url: 'file:///secret' },
      ],
      'a',
    );
    expect(storage.getItem()).not.toContain('secret');
    expect(storage.getItem()).not.toContain('file:');
    const invoke = vi.fn(async (op: string) => (op === 'state' ? { tabs: [] } : undefined));
    await recovery.restore('s', invoke);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['state', 'navigate', 'activate']);
  });
  it('preserves a live native window and retries failed observation without duplicating tabs', async () => {
    const storage = store(),
      recovery = new BrowserRecovery(storage);
    recovery.save('s', [{ id: 'a', url: 'https://example.test/' }], 'a');
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(Error('offline'))
      .mockResolvedValue({ tabs: [{ id: 'native' }] });
    await expect(recovery.restore('s', invoke)).rejects.toThrow('offline');
    await recovery.restore('s', invoke);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
