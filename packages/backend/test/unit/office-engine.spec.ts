import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import {
  OfficeEngineService,
  allowsOfficeEngineRequest,
} from '../../src/modules/tools/files/office-engine.service';
describe('Office WOPI storage boundary', () => {
  let dir: string, service: OfficeEngineService;
  const env = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wing-wopi-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
    process.env['WING_OFFICE_URL'] = 'http://localhost:9980';
    process.env['WING_OFFICE_CALLBACK_BASE_URL'] = 'http://localhost:3000';
    service = new OfficeEngineService({ isPathAllowed: () => true } as never);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          '<wopi-discovery><app><action ext="docx" name="edit" urlsrc="http://localhost:9980/browser/test/cool.html?"/></app></wopi-discovery>',
        ),
      );
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    for (const name of [
      'SKYALYTICWING_DATA_DIR',
      'WING_OFFICE_URL',
      'WING_OFFICE_CALLBACK_BASE_URL',
    ])
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    rmSync(dir, { recursive: true, force: true });
  });
  const document = async (text: string) => {
    const zip = new JSZip();
    zip.file('word/document.xml', text);
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  it('grants file-scoped capabilities, saves original bytes and retains external-conflict copies', async () => {
    const path = join(dir, 'report.docx');
    writeFileSync(path, await document('first'));
    const session = await service.open(path);
    const route =
      '/api/office-engine/wopi/files/' + session.id + '?access_token=' + session.credential;
    expect(allowsOfficeEngineRequest(route, 'GET')).toBe(true);
    expect(allowsOfficeEngineRequest(route, 'DELETE')).toBe(false);
    expect(
      allowsOfficeEngineRequest('/api/files/read?access_token=' + session.credential, 'GET'),
    ).toBe(false);
    expect(service.validCapability(session.id, session.credential + 'x')).toBe(false);
    expect(service.info(session.id, session.credential).UserCanWrite).toBe(true);
    const changed = await document('edited');
    await service.save(session.id, session.credential, changed);
    expect(readFileSync(path)).toEqual(changed);
    expect(service.state(session.id).savedAt).toBeTruthy();
    writeFileSync(path, await document('external'));
    expect((await service.save(session.id, session.credential, changed)).conflict).toBe(true);
    expect(service.state(session.id).error).toContain('冲突副本');
    expect(readFileSync(path)).not.toEqual(changed);
  });
  it('restores narrowly scoped capabilities after restart, and refuses corrupt saves', async () => {
    const path = join(dir, 'restart.docx');
    const bytes = await document('persisted');
    writeFileSync(path, bytes);
    const opened = await service.open(path);
    service.onModuleDestroy();
    service = new OfficeEngineService({ isPathAllowed: () => true } as never);
    expect(service.validCapability(opened.id, opened.credential)).toBe(true);
    await expect(
      service.save(opened.id, opened.credential, Buffer.from('not zip')),
    ).rejects.toThrow('损坏');
    expect(service.download(opened.id, opened.credential)).toEqual(bytes);
  });
  it('persists private engine configuration and rejects credential-bearing or non-HTTP addresses', () => {
    delete process.env['WING_OFFICE_URL'];
    delete process.env['WING_OFFICE_CALLBACK_BASE_URL'];
    expect(() =>
      service.configure({
        url: 'file:///secret',
        callback: 'http://localhost:3000',
        frameOrigin: 'http://localhost:3000',
      }),
    ).toThrow('服务地址');
    expect(() =>
      service.configure({
        url: 'http://user:password@localhost:9980',
        callback: 'http://localhost:3000',
        frameOrigin: 'http://localhost:3000',
      }),
    ).toThrow('服务地址');
    service.configure({
      url: 'http://localhost:9980/',
      callback: 'http://localhost:3000',
      frameOrigin: 'http://localhost:3000',
    });
    expect(service.configuration()).toMatchObject({
      url: 'http://localhost:9980',
      internal: 'http://localhost:9980',
      configured: true,
      managed: false,
    });
  });
});
