import { mkdtemp, writeFile, readFile, rm, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LargeTextStore, TEXT_PAGE_READ_BYTES } from '../../src/modules/tools/files/large-text.store';

describe('large text editor streaming and autosave', () => {
  jest.setTimeout(60000);
  let root: string, path: string, store: LargeTextStore;
  const old = process.env['SKYALYTICWING_DATA_DIR'];
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'wing-large-'))); path = join(root, 'text.txt'); process.env['SKYALYTICWING_DATA_DIR'] = root; store = new LargeTextStore(p => p.startsWith(root)); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = old; });
  async function done(id: string) { for (let i = 0; i < 1000; i++) { const job = await store.status(id); if (job.state !== 'saving') return job; await new Promise(r => setTimeout(r, 10)); } throw new Error('save did not finish'); }
  it('reads UTF-8 page boundaries without dropping Chinese, emoji, BOM or CRLF', async () => {
    const original = '\uFEFF' + '中文😀\r\n'.repeat(18000); await writeFile(path, original);
    let offset = 0, result = '';
    do { const p = await store.page(path, offset); result += p.content; offset = p.end; expect(p.end - p.offset).toBeLessThanOrEqual(TEXT_PAGE_READ_BYTES); } while (offset < Buffer.byteLength(original));
    expect(result).toBe(original);
    const jump = await store.page(path, 5); expect(jump.offset).toBe(3); expect(jump.content.startsWith('中文')).toBe(true);
  });
  it('merges a changed-length middle page and preserves prefix and suffix', async () => {
    const original = 'A'.repeat(TEXT_PAGE_READ_BYTES) + '中文\r\n'.repeat(40000); await writeFile(path, original);
    const p = await store.page(path, TEXT_PAGE_READ_BYTES);
    const text = 'new\r\n' + p.content + 'done'; const job = await store.start({ ...p, path, content: text });
    expect((await store.draft(path)).patch?.content).toBe(text);
    expect((await done(job.id)).state).toBe('saved');
    const bytes = Buffer.from(original); expect(await readFile(path)).toEqual(Buffer.concat([bytes.subarray(0, p.offset), Buffer.from(text), bytes.subarray(p.end)]));
    expect((await store.draft(path)).patch).toBeNull();
  });
  it('rejects external modifications and retains the durable draft across store recreation', async () => {
    await writeFile(path, 'original'); const p = await store.page(path); await writeFile(path, 'external');
    const job = await store.start({ ...p, path, content: 'mine' }); expect((await done(job.id)).state).toBe('error');
    expect(await readFile(path, 'utf8')).toBe('external');
    expect((await new LargeTextStore(p => p.startsWith(root)).draft(path)).patch?.content).toBe('mine');
  });
  it.each(Array.from({ length: Math.min(100, Number(process.env['WING_AUTOSAVE_STRESS_RUNS']) || 5) }, (_, i) => i + 1))('coalesces edits during background writing without losing the final edit (run %s)', async () => {
    await writeFile(path, 'x'.repeat(12 * 1024 * 1024)); const p = await store.page(path);
    const first = await store.start({ ...p, path, content: 'first' });
    const second = await store.start({ ...p, path, content: 'latest' }); expect(second.id).toBe(first.id);
    const completion = await done(second.id);
    if (completion.state !== 'saved') throw new Error(`Background save failed: ${JSON.stringify(completion)}`);
    const bytes = await readFile(path); expect(bytes.subarray(0, 6).toString()).toBe('latest'); expect(bytes.length).toBe(12 * 1024 * 1024 - p.end + 6);
  });
  it('rejects invalid offsets and paths before allocating or editing', async () => {
    await writeFile(path, 'abc'); await expect(store.page(path, -1)).rejects.toThrow(); await expect(store.page(path, NaN)).rejects.toThrow();
    await expect(store.page(join(root, '..', 'no-access'))).rejects.toThrow('Path not allowed');
  });
  it('addresses beyond 10 GiB without reading the preceding bytes', async () => {
    const file = await open(path, 'w'); const offset = 11 * 1024 ** 3;
    try {
      if (process.platform === 'win32') execFileSync('fsutil', ['sparse', 'setflag', path], { windowsHide: true });
      await file.write(Buffer.from('tail 中文\r\n'), 0, Buffer.byteLength('tail 中文\r\n'), offset);
    } finally { await file.close(); }
    const p = await store.page(path, offset); expect(p.offset).toBe(offset); expect(p.size).toBeGreaterThan(10 * 1024 ** 3); expect(p.content).toBe('tail 中文\r\n');
  }, 60000);
});
