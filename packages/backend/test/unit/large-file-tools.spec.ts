import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrepTool } from '../../src/modules/tools/executor/built-in/grep';
import { createFileReadTool } from '../../src/modules/tools/executor/built-in/file-read';
describe('large file tool completeness', () => {
 let root: string;
 beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'wing-tools-large-'))); });
 afterEach(async () => { await rm(root, { recursive: true, force: true }); });
 it('finds matches after the old 5 MiB cutoff and exposes continuation', async () => {
  await writeFile(join(root, 'large.txt'), 'ordinary line\n'.repeat(450000) + 'TARGET\n'.repeat(501));
  const tool = createGrepTool({ isPathAllowed: () => true } as never);
  const first = await tool.execute({ path: root, pattern: 'TARGET' }, { workspace: root } as never);
  expect(first.success).toBe(true); expect((first.data as any).nextOffset).toBe(500);
  const rest = await tool.execute({ path: root, pattern: 'TARGET', offset: 500 }, { workspace: root } as never);
  expect(rest.output?.split('\n')).toHaveLength(1); expect((rest.data as any).truncated).toBe(false);
 }, 60000);
 it('reads a large file in bounded pages with an explicit next byte offset', async () => {
  await writeFile(join(root, 'large.txt'), 'content\n'.repeat(800000));
  const tool = createFileReadTool({ isPathAllowed: () => true } as never);
  const first = await tool.execute({ path: 'large.txt' }, { workspace: root, sessionId: 'test' } as never);
  expect(first.success).toBe(true); expect(first.output!.length).toBeLessThanOrEqual(128 * 1024);
  expect((first.data as any).nextByteOffset).toBeGreaterThan(0);
 }, 60000);
 it('searches oversized regex lines including matches beyond the old line cutoff', async () => {
  await writeFile(join(root, 'long.txt'), 'x'.repeat(2 * 1024 * 1024) + 'TARGET\nTARGET');
  const tool = createGrepTool({ isPathAllowed: () => true } as never);
  const result = await tool.execute({ path: root, pattern: 'TARGET' }, {} as never);
  expect(result.success).toBe(true);expect(result.output).toContain('TARGET');expect(result.output?.split('\n')).toHaveLength(2);expect(result.output).toContain('匹配行预览已截短');expect((result.data as any).incomplete).toBe(false);
 });
});
