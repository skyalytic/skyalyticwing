import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeService } from '../../src/modules/tools/files/office.service';
import { NativeOfficeService } from '../../src/modules/tools/files/native-office.service';
import { createWorkfile } from '../../src/modules/tools/files/create-workfile';
import JSZip from 'jszip';
import { CFB } from 'xlsx';
describe('local full Office persistence', () => {
  let dir: string, service: NativeOfficeService, office: OfficeService;
  const env = process.env['SKYALYTICWING_DATA_DIR'];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wing-native-office-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
    const security = { isPathAllowed: (p: string) => p.startsWith(dir) };
    service = new NativeOfficeService(security as never);
    (service as unknown as { assets: () => string }).assets = () => dir;
    office = new OfficeService(security as never);
  });
  afterEach(() => {
    service.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    if (env === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = env;
  });
  it.each(['docx', 'xlsx', 'pptx'])(
    'creates a real blank %s without overwriting existing files',
    async (format) => {
      const a = await office.create(dir, '测试', format),
        b = await office.create(dir, '测试', format);
      expect(a.path).not.toBe(b.path);
      const zip = await JSZip.loadAsync(readFileSync(a.path));
      expect(zip.file('[Content_Types].xml')).not.toBeNull();
      expect((await office.read(a.path)).format).toBe(format);
    },
  );
  it('rejects traversing names and unauthorized folders before writing', () => {
    expect(() => createWorkfile(dir, '../outside', 'html', 'text', () => true)).toThrow();
    expect(() => createWorkfile(dir, 'test', 'html', 'text', () => false)).toThrow();
    expect(() => createWorkfile(dir, 'NUL', 'html', 'text', () => true)).toThrow();
  });
  it('creates unique design files while preserving existing content', () => {
    const a = createWorkfile(dir, '画布', 'html', 'first', () => true),
      b = createWorkfile(dir, '画布', 'html', 'second', () => true);
    expect(readFileSync(a.path, 'utf8')).toBe('first');
    expect(readFileSync(b.path, 'utf8')).toBe('second');
  });
  it('requires the file capability and keeps the runtime origin isolated', async () => {
    const f = await office.create(dir, '文档', 'docx'),
      s = await service.open(f.path),
      u = new URL(s.url);
    const r = await fetch(u.origin + '/documents/' + s.id + '/file');
    expect(r.status).toBe(403);
    const ok = await fetch(u.origin + '/documents/' + s.id + '/file', {
      headers: { 'X-Wing-Capability': u.hash.slice(1) },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    const foreign = await fetch(u.origin + '/documents/' + s.id + '/file', {
      headers: { 'X-Wing-Capability': u.hash.slice(1), Origin: 'https://foreign.example' },
    });
    expect(foreign.status).toBe(403);
  });
  it('saves whole Office documents and refuses to overwrite external changes', async () => {
    const f = await office.create(dir, '文档', 'docx'),
      s = await service.open(f.path);
    const zip = await JSZip.loadAsync(readFileSync(f.path));
    zip.file('custom/marker.txt', 'edited');
    const edited = await zip.generateAsync({ type: 'nodebuffer' });
    await service.save(s.id, edited);
    expect(readFileSync(f.path).equals(edited)).toBe(true);
    const external = Buffer.from('outside edit');
    writeFileSync(f.path, external);
    await expect(service.save(s.id, edited)).rejects.toThrow('原文件');
    expect(readFileSync(f.path).equals(external)).toBe(true);
  });
  it('revalidates editor assets while document bytes remain uncached', async () => {
    writeFileSync(join(dir, 'input.js'), '/* input bridge */');
    const file = await office.create(dir, '缓存检查', 'docx');
    const session = await service.open(file.path),
      url = new URL(session.url);
    const first = await fetch(url.origin + '/input.js');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const cached = await fetch(url.origin + '/input.js', { headers: { 'If-None-Match': etag } });
    expect(cached.status).toBe(304);
    writeFileSync(join(dir, 'input.js'), '/* updated input bridge */');
    const updated = await fetch(url.origin + '/input.js', { headers: { 'If-None-Match': etag } });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).not.toBe(etag);
    const document = await fetch(url.origin + '/documents/' + session.id + '/file', {
      headers: { 'X-Wing-Capability': url.hash.slice(1) },
    });
    expect(document.headers.get('cache-control')).toBe('no-store');
  });
  it('releases closed documents and rejects invalid live cell coordinates', async () => {
    const f = await office.create(dir, 'Sheet', 'xlsx'),
      s = await service.open(f.path);
    expect(() => service.command(s.id, 'set_cell', { row: 0, column: 0, sheet: -1 })).toThrow();
    service.release(s.id);
    expect(() => service.state(s.id)).toThrow();
    const reopened = await service.open(f.path);
    expect(reopened.id).not.toBe(s.id);
  });
  it('reuses the local cache origin and falls back when its port is occupied', async () => {
    const file = await office.create(dir, '端口检查', 'docx');
    const first = new URL((await service.open(file.path)).url);
    service.onModuleDestroy();
    // Wait for Node to release the listener before creating a fresh app instance.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacement = new NativeOfficeService({ isPathAllowed: () => true } as never);
    (replacement as unknown as { assets: () => string }).assets = () => dir;
    const concurrent = new NativeOfficeService({ isPathAllowed: () => true } as never);
    (concurrent as unknown as { assets: () => string }).assets = () => dir;
    try {
      const reused = new URL((await replacement.open(file.path)).url);
      expect(reused.origin).toBe(first.origin);
      const fallback = new URL((await concurrent.open(file.path)).url);
      expect(fallback.origin).not.toBe(reused.origin);
      expect((await fetch(fallback.origin + '/documents/no-capability/file')).status).not.toBe(200);
    } finally {
      replacement.onModuleDestroy();
      concurrent.onModuleDestroy();
    }
  });
  it('imports Office files as a project copy without overwriting the existing document', async () => {
    const f = await office.create(dir, 'Original', 'docx'),
      s = await service.open(f.path),
      u = new URL(s.url);
    const bytes = readFileSync(f.path);
    const response = await fetch(u.origin + '/documents/' + s.id + '/import?name=Original.docx', {
      method: 'POST',
      headers: { 'X-Wing-Capability': u.hash.slice(1) },
      body: bytes,
    });
    expect(response.status).toBe(200);
    const copy = (await response.json()) as { path: string };
    expect(copy.path).not.toBe(f.path);
    expect(service.state(s.id).navigation).toBe(copy.path);
    expect(readFileSync(f.path).equals(bytes)).toBe(true);
  });
  it.each(['doc', 'xls', 'ppt'])(
    'accepts and saves a legacy %s container, and rejects a renamed text file',
    async (ext) => {
      const file = join(dir, '旧版.' + ext);
      const cfb = CFB.utils.cfb_new();
      CFB.utils.cfb_add(
        cfb,
        ext === 'doc' ? 'WordDocument' : ext === 'xls' ? 'Workbook' : 'PowerPoint Document',
        Buffer.alloc(200),
      );
      const bytes = Buffer.from(CFB.write(cfb, { type: 'buffer' }));
      writeFileSync(file, bytes);
      const session = await service.open(file);
      await service.save(session.id, bytes);
      expect(readFileSync(file).equals(bytes)).toBe(true);
      writeFileSync(file, Buffer.alloc(100, 'x'));
      await expect(service.open(file)).rejects.toThrow('扩展名');
    },
  );
  it('allows empty shell-created documents to open without mutating the original on read', async () => {
    const file = join(dir, '新建.docx');
    writeFileSync(file, '');
    await expect(service.open(file)).resolves.toHaveProperty('id');
    expect(readFileSync(file).length).toBe(0);
  });
});
