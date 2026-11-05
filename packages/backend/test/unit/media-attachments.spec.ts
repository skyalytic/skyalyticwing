import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deduplicateLocalMedia, deduplicateMessageMedia } from '../../src/modules/core/utils/media-attachments.util.js';

describe('local media copy identity', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wing-media-hash-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const media = (path: string) => ({ type: 'video' as const, path, name: path });
  it('deduplicates copies in old history without mutating persisted messages', async () => {
    const a = join(root, 'original.mp4'), b = join(root, 'copy.mp4');
    writeFileSync(a, 'same bytes'); writeFileSync(b, 'same bytes');
    const message = { id:'m', role:'assistant' as const, content:'video', timestamp:1, attachments: [media(a), media(b)] };
    expect((await deduplicateMessageMedia([message], () => true))[0]!.attachments).toHaveLength(1);
    expect(message.attachments).toHaveLength(2);
  });
  it('keeps different bytes of equal size, denied and missing files', async () => {
    const a = join(root, 'a.mp4'), b = join(root, 'b.mp4');
    writeFileSync(a, '123'); writeFileSync(b, '321');
    expect(await deduplicateLocalMedia([media(a), media(b)], () => true)).toHaveLength(2);
    writeFileSync(b, '123');
    expect(await deduplicateLocalMedia([media(a), media(b)], () => false)).toHaveLength(2);
    expect(await deduplicateLocalMedia([media(a), media(join(root, 'absent.mp4'))], () => true)).toHaveLength(2);
    expect(await deduplicateLocalMedia([media(a), media(b)], () => true)).toHaveLength(1);
    writeFileSync(b, 'longer changed bytes');
    expect(await deduplicateLocalMedia([media(a), media(b)], () => true)).toHaveLength(2);
  });
});
