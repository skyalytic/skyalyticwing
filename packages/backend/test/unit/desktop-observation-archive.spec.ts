import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { DesktopObservationArchive } from '../../src/extensions/bundled/computer-use/runtime/desktop-observation-archive';
import { visualObservation } from '../../src/modules/ai/agent/visual-observation';

describe('local desktop screenshot evidence', () => {
  let directory: string, png: Buffer;
  const limits = { maxBytes: 128 * 1024 * 1024, maxImages: 200, maxAgeMs: 7 * 86400_000 };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wing-evidence-test-'));
    png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#8a12c0' } }).png().toBuffer();
  });
  afterEach(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('wing-evidence-test-')) throw new Error('Unexpected test cleanup path');
    await rm(directory, { recursive: true, force: true });
  });
  const result = (bytes: Buffer, id: string = randomUUID()) => ({ success: true, data: { desktopWorkflow: true, lookId: id,
    visualObservation: { kind: 'desktop', screenshotId: id, base64: bytes.toString('base64'), mimeType: 'image/png',
      width: 40, height: 20, capturedAt: 1234, detail: 'high', coordinateSpace: 'image' } } });
  it('stores the same bytes sent to vision and keeps a verifiable path after stripping inline pixels', async () => {
    const archive = new DesktopObservationArchive(directory), input = result(png);
    const saved = await archive.record(input, 'session-A');
    const receipt = saved.data as any;
    const delivered = visualObservation(saved, 'gpt-4o', 'openai');
    const url = (delivered.message!.content as any[])[1].image_url.url;
    expect(await readFile(receipt.screenshotFile)).toEqual(Buffer.from(url.split(',')[1], 'base64'));
    expect(receipt.screenshotSha256).toBe(createHash('sha256').update(png).digest('hex'));
    const metadata = JSON.parse(await readFile(receipt.screenshotFile.replace(/\.png$/, '.json'), 'utf8'));
    expect(metadata).toMatchObject({ sessionId: 'session-A', screenshotId: input.data.lookId, capturedAt: 1234, stage: 'tool_observation' });
    expect((delivered.result as any).data).toMatchObject({ screenshotFile: receipt.screenshotFile, visualEvidence: { screenshotId: input.data.lookId } });
    expect((delivered.result as any).data).not.toHaveProperty('visualObservation');
  });
  it('isolates session filenames and prunes its oldest pairs without deleting unrelated files', async () => {
    const archive = new DesktopObservationArchive(directory, { ...limits, maxImages: 2 });
    const first = await archive.record(result(png), '../session-A');
    const second = await archive.record(result(png), 'session-B');
    const firstPath = (first.data as any).screenshotFile;
    await utimes(firstPath, new Date(0), new Date(0)); await utimes(firstPath.replace(/\.png$/, '.json'), new Date(0), new Date(0));
    await writeFile(join(directory, 'keep.png'), png);
    const third = await archive.record(result(png), 'session-C');
    expect(dirname(firstPath)).toBe(directory);
    await expect(stat(firstPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(firstPath.replace(/\.png$/, '.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, 'keep.png'))).toEqual(png);
    expect((await readdir(directory)).length).toBe(5);
    expect((second.data as any).screenshotFile).not.toBe((third.data as any).screenshotFile);
  });
  it('enforces the byte budget, not only the image count', async () => {
    const large = Buffer.alloc(2200, 9);
    const archive = new DesktopObservationArchive(directory, { ...limits, maxBytes: 5000 });
    const first = await archive.record(result(large), 'one');
    const second = await archive.record(result(large), 'two');
    expect((second.data as any).screenshotFile).toBeDefined();
    await expect(stat((first.data as any).screenshotFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const files = await readdir(directory);
    const bytes = await Promise.all(files.map(f => stat(join(directory, f)).then(s => s.size)));
    expect(bytes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000);
  });
  it('keeps input success and inline image when saving is unavailable or the image identity is unsafe', async () => {
    const file = join(directory, 'file'); await writeFile(file, 'fixture');
    const input = { ...result(png), data: { ...result(png).data, inputReceipts: [{ outcome: 'delivered' }] } };
    const saved = await new DesktopObservationArchive(file).record(input, 'one');
    expect(saved).toMatchObject({ success: true, data: { screenshotArchive: 'unavailable', inputReceipts: [{ outcome: 'delivered' }], visualObservation: input.data.visualObservation } });
    const invalid = await new DesktopObservationArchive(directory).record(result(png, '../../outside'), 'one');
    expect(invalid.data).toMatchObject({ screenshotArchive: 'unavailable' });
    expect(await readdir(directory)).toEqual(['file']);
  });
  it('never archives an ordinary tool result or overwrites a previous image', async () => {
    const archive = new DesktopObservationArchive(directory), ordinary = { success: true, output: 'text' };
    expect(await archive.record(ordinary, 'one')).toBe(ordinary);
    const input = result(png), first = await archive.record(input, 'one');
    const again = await archive.record(result(Buffer.from('different'), input.data.lookId), 'one');
    expect(again.data).toMatchObject({ screenshotArchive: 'unavailable' });
    expect(await readFile((first.data as any).screenshotFile)).toEqual(png);
  });
});
