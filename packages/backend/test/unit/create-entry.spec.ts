import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createEntry } from '../../src/modules/tools/files/create-entry';

describe('project tree creation', () => {
  let dir: string;
  const allowed = (p: string) => resolve(p) === dir || resolve(p).startsWith(dir + sep);
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wing-tree-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it('creates Chinese nested folders and files, including extensionless files', () => {
    const folder = createEntry(dir, '中文 文件夹', 'dir', allowed);
    expect(statSync(folder.path).isDirectory()).toBe(true);
    const file = createEntry(folder.path, 'README', 'file', allowed);
    expect(readFileSync(file.path, 'utf8')).toBe('');
  });
  it('never overwrites existing files or accepts duplicate folders', () => {
    const f = createEntry(dir, 'same.txt', 'file', allowed);
    writeFileSync(f.path, 'keep me');
    expect(() => createEntry(dir, 'same.txt', 'file', allowed)).toThrow('已存在');
    expect(() => createEntry(dir, 'same.txt', 'dir', allowed)).toThrow('已存在');
    expect(readFileSync(f.path, 'utf8')).toBe('keep me');
  });
  it.each(['../escape', '..', 'a/b', 'a\\b', 'NUL', 'COM1.txt', 'bad:', 'a.', ' a', 'a\0b'])('rejects invalid name %s', name => {
    expect(() => createEntry(dir, name, 'file', allowed)).toThrow();
  });
  it('requires write permission and revalidates a junction target', () => {
    expect(() => createEntry(dir, 'no.txt', 'file', () => false)).toThrow('权限');
    const outside = mkdtempSync(join(tmpdir(), 'wing-outside-'));
    try {
      symlinkSync(outside, join(dir, 'link'), 'junction');
      expect(() => createEntry(join(dir, 'link'), 'no.txt', 'file', allowed)).toThrow('权限');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
