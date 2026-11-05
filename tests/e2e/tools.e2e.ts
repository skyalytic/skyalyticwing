import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('File Tools E2E', () => {
  const testDir = join(tmpdir(), 'skyalyticwing-e2e-test');

  it('should read and write files', async () => {
    await mkdir(testDir, { recursive: true });
    const testFile = join(testDir, 'test.txt');
    const content = 'Hello, SkyalyticWing E2E Test!';

    await writeFile(testFile, content, 'utf-8');
    const readContent = await readFile(testFile, 'utf-8');

    expect(readContent).toBe(content);
    await rm(testDir, { recursive: true, force: true });
  });

  it('should list directory contents', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'file1.txt'), 'content1');
    await writeFile(join(testDir, 'file2.txt'), 'content2');

    const { readdir } = await import('fs/promises');
    const entries = await readdir(testDir);

    expect(entries).toContain('file1.txt');
    expect(entries).toContain('file2.txt');
    await rm(testDir, { recursive: true, force: true });
  });
});
