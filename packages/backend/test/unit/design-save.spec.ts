import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesService } from '../../src/modules/tools/files/files.service.js';

describe('canvas save conflict protection', () => {
  let dir: string, path: string, service: FilesService;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sky-design-test-'));
    path = join(dir, 'design.html');
    writeFileSync(path, '<h1>original</h1>');
    service = new FilesService({ isPathAllowed: () => true } as any, { get: () => ({}) } as any);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('saves an unchanged base and rejects overwriting a newer AI revision', async () => {
    await service.saveDesign(path, '<h1>edited</h1>', undefined, service.read(path).revision);
    expect(readFileSync(path, 'utf8')).toBe('<h1>edited</h1>');
    await expect(service.saveDesign(path, 'overwrite', '<h1>original</h1>')).rejects.toThrow(
      '文件已被',
    );
    expect(readFileSync(path, 'utf8')).toBe('<h1>edited</h1>');
  });
  it('requires a base revision, HTML extension and authorized path', async () => {
    await expect(service.saveDesign(path, 'x', undefined as any)).rejects.toThrow();
    await expect(service.saveDesign(path + '.txt', 'x', '')).rejects.toThrow();
    const denied = new FilesService(
      { isPathAllowed: () => false } as any,
      { get: () => ({}) } as any,
    );
    await expect(denied.saveDesign(path, 'x', '<h1>original</h1>')).rejects.toThrow(
      '文件没有写入权限',
    );
  });
  it('protects text editor autosaves including empty edits with a revision',async()=>{
    const revision=service.read(path).revision!;
    const saved=await service.saveText(path,'',revision);
    expect(readFileSync(path,'utf8')).toBe('');
    await expect(service.saveText(path,'stale',revision)).rejects.toThrow('修改');
    await service.saveText(path,'new',saved.revision); expect(readFileSync(path,'utf8')).toBe('new');
  });
});
