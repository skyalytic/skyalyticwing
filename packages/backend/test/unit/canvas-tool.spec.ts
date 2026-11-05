import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaTools } from '../../src/modules/tools/executor/built-in/media';
jest.mock('../../src/modules/tools/files/design-export', () => ({ renderDesignFile: jest.fn(async (_html, _w, _h, format) => Buffer.from(format === 'png' ? 'PNG fixture' : '%PDF fixture')) }));
describe('canvas tool output contracts', () => {
  let root: string;
  const originalDataDir = process.env['SKYALYTICWING_DATA_DIR'];
  const security = { isPathAllowed: jest.fn(() => true) };
  const tool = createMediaTools(security as never, {} as never, (() => undefined) as never).find(x => x.name === 'canvas')!;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wing-canvas-')); process.env['SKYALYTICWING_DATA_DIR'] = join(root, 'data'); security.isPathAllowed.mockReturnValue(true); });
  afterEach(() => { if (originalDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = originalDataDir; rmSync(root, { recursive: true, force: true }); });
  const run = (args: unknown) => tool.execute(args, { sessionId: 'test', workspace: root } as never);
  it('creates an actual editable HTML design in the workspace', async () => {
    expect((await run({ action: 'create', content: '<svg><text>Editable</text></svg>', filename: 'poster.html' })).success).toBe(true);
    const html = readFileSync(join(root, 'poster.html'), 'utf8');
    expect(html).toContain('<!doctype html>'); expect(html).toContain('Editable');
  });
  it('requires a real target to clear and actually clears its content', async () => {
    expect((await run({ action: 'clear' })).success).toBe(false);
    expect((await run({ action: 'clear', filename: 'missing.html' })).success).toBe(false);
    await run({ action: 'create', content: '<p>Old drawing</p>', filename: 'poster.html' });
    expect((await run({ action: 'clear', filename: 'poster.html' })).success).toBe(true);
    expect(readFileSync(join(root, 'poster.html'), 'utf8')).not.toContain('Old drawing');
  });
  it('rejects mismatched file formats and unapproved paths', async () => {
    expect((await run({ action: 'export', format: 'png', filename: 'wrong.pdf', content: '<svg/>' })).success).toBe(false);
    security.isPathAllowed.mockReturnValue(false);
    expect((await run({ action: 'create', filename: 'poster.html' })).success).toBe(false);
  });
  it.each(['png', 'pdf'])('uses the renderer output for %s, never writes SVG under a binary extension', async format => {
    expect((await run({ action: 'export', format, filename: 'poster.' + format, content: '<svg/>' })).success).toBe(true);
    expect(readFileSync(join(root, 'poster.' + format), 'utf8')).not.toContain('<svg');
  });
});
