import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonical, EcosystemService } from '../../src/modules/ecosystem/ecosystem.service';

describe('official ecosystem install and authorization', () => {
  const keys = generateKeyPairSync('ed25519');
  const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
  let service: EcosystemService, root: string, prior: string | undefined;
  let manifest: Record<string, unknown>, payload: string, corrupt: boolean;
  const http = { get: jest.fn() };
  const servers = new Map<string, Record<string, unknown>>();
  const mcp = {
    listServers: () => [...servers.values()],
    getEnvironmentForConfiguration: (id: string) => ({ ...servers.get(id)?.['env'] as Record<string,string> }),
    addServer: jest.fn((v) => { servers.set(v.id, v); return v; }),
    removeServer: jest.fn((id) => servers.delete(id)),
    stopServer: jest.fn(), startServer: jest.fn(), listTools: jest.fn(),
    updateServer: jest.fn((id, patch) => { servers.set(id, { ...servers.get(id), ...patch }); }),
  };
  const bundle = (paths = ['SKILL.md', 'LICENSE']) => JSON.stringify({ files: paths.map(path => ({ path, content: Buffer.from('verified content').toString('base64'), sha256: digest('verified content') })) });
  beforeEach(() => {
    jest.clearAllMocks(); servers.clear(); corrupt = false;
    mcp.startServer.mockReset().mockResolvedValue(undefined); mcp.listTools.mockResolvedValue([{ name: 'read' }]);
    root = mkdtempSync(join(tmpdir(), 'wing-eco-')); prior = process.env['SKYALYTICWING_DATA_DIR']; process.env['SKYALYTICWING_DATA_DIR'] = root;
    service = new EcosystemService(http as never, mcp as never, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    payload = bundle();
    manifest = { id: 'office-review', name: 'Office review', description: 'review', kind: 'skill', version: '1.0.0', minDesktopVersion: '2.0.0', publisher: 'Fixture', source: 'https://example.com/source', license: 'MIT', permissions: ['read files'], artifactSha256: digest(payload) };
    http.get.mockImplementation(async (url: string) => {
      if (url.includes('/items/')) { const bytes = canonical(manifest); return { status: 200, data: { manifest, keyId: 'skyalytic-2026-preview-1', sha256: digest(bytes), signature: corrupt ? 'bad' : sign(null, Buffer.from(bytes), keys.privateKey).toString('base64') } }; }
      return { status: 200, data: payload };
    });
  });
  afterEach(() => { if (prior === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = prior; rmSync(root, { recursive: true, force: true }); });
  it('installs verified full skill files and supports local uninstall', async () => {
    await service.install('office-review');
    expect(readFileSync(join(root, 'skills/office-review/SKILL.md'), 'utf8')).toBe('verified content');
    expect(service.installed()).toHaveLength(1);
    await expect(service.install('office-review')).rejects.toThrow('已安装');
    service.uninstall('office-review');
    expect(existsSync(join(root, 'skills/office-review'))).toBe(false);
  });
  it('upgrades verified skills, keeps a rollback copy, and restores it offline', async () => {
    await service.install('office-review');
    payload=JSON.stringify({files:['SKILL.md','LICENSE'].map(path=>({path,content:Buffer.from('new version').toString('base64'),sha256:digest('new version')}))});
    manifest['version']='1.1.0';manifest['artifactSha256']=digest(payload);
    await service.upgrade('office-review');expect(readFileSync(join(root,'skills/office-review/SKILL.md'),'utf8')).toBe('new version');
    http.get.mockRejectedValue(new Error('offline'));
    service.rollback('office-review');expect(readFileSync(join(root,'skills/office-review/SKILL.md'),'utf8')).toBe('verified content');
  });
  it('restores the installed version when an upgrade download is corrupt', async () => {
    await service.install('office-review');corrupt=true;
    await expect(service.upgrade('office-review')).rejects.toThrow('签名');
    expect(service.installed()[0].version).toBe('1.0.0');
    expect(readFileSync(join(root,'skills/office-review/SKILL.md'),'utf8')).toBe('verified content');
  });
  it('rejects a forged signature and changed artifact', async () => {
    corrupt = true; await expect(service.install('office-review')).rejects.toThrow('签名');
    corrupt = false; payload += ' '; await expect(service.install('office-review')).rejects.toThrow('校验');
    expect(service.installed()).toEqual([]);
  });
  it.each(['../outside', '/absolute', 'CON.txt', 'nested/../../escape', 'SKILL.md'])('rejects unsafe or duplicate archive path %s', async path => {
    payload = bundle(['SKILL.md', 'LICENSE', path]); manifest['artifactSha256'] = digest(payload);
    await expect(service.install('office-review')).rejects.toThrow('路径');
    expect(service.installed()).toEqual([]);
  });
  it('installs MCP disabled and lists it even without a skills folder', async () => {
    manifest = { ...manifest, kind: 'mcp', install: { spec: '@vendor/office@1.2.3', args: [], defaults: {}, envKeys: ['APP_KEY'] } };
    await service.install('office-review');
    expect(servers.get('skyalytic:office-review')!['enabled']).toBe(false);
    expect(service.installed()).toHaveLength(1);
    expect(existsSync(join(root, 'skills'))).toBe(false);
    const result = await service.configure('office-review', { APP_KEY: 'local-only-secret' });
    expect(result.toolCount).toBe(1);
    expect(JSON.stringify(service.installed())).not.toContain('local-only-secret');
    service.uninstall('office-review'); expect(servers.size).toBe(0);
  });
  it('rejects undeclared credentials and disables a failed connection without leaking its error', async () => {
    manifest = { ...manifest, kind: 'mcp', install: { spec: 'office@1.2.3', args: [], defaults: {}, envKeys: ['APP_KEY'] } };
    await service.install('office-review');
    await expect(service.configure('office-review', { NODE_OPTIONS: '--require something' })).rejects.toThrow('未声明');
    mcp.startServer.mockRejectedValue(new Error('secret in vendor error'));
    await expect(service.configure('office-review', { APP_KEY: 'secret' })).rejects.toThrow('连接验证失败');
    expect(servers.get('skyalytic:office-review')!['enabled']).toBe(false);
  });

  it('edits mail ports and TLS while keeping saved secrets without returning them', async () => {
    manifest = { ...manifest, kind: 'mcp', install: { spec: 'office@1.2.3', args: [], defaults: { SMTP_PORT:'465', SMTP_SECURE:'true', ACTIVE_PROFILES:'mail' }, envKeys: ['EMAIL_PASS','SMTP_HOST'] } };
    await service.install('office-review');
    expect(service.configuration('office-review').fields.map(f=>f.key)).toEqual(['EMAIL_PASS','SMTP_HOST','SMTP_PORT','SMTP_SECURE']);
    await expect(service.configure('office-review', {})).rejects.toThrow('请填写');
    await service.configure('office-review', {EMAIL_PASS:'private-secret',SMTP_HOST:'smtp.example.com'});
    const setup=service.configuration('office-review');
    expect(JSON.stringify(setup)).not.toContain('private-secret');
    expect(setup.fields.find(f=>f.key==='EMAIL_PASS')).toMatchObject({configured:true,value:'',secret:true});
    await service.configure('office-review', {EMAIL_PASS:'',SMTP_PORT:'587',SMTP_SECURE:'false'});
    expect(servers.get('skyalytic:office-review')?.['env']).toEqual({EMAIL_PASS:'private-secret',SMTP_HOST:'smtp.example.com',SMTP_PORT:'587',SMTP_SECURE:'false',ACTIVE_PROFILES:'mail'});
    await expect(service.configure('office-review', {SMTP_PORT:'70000'})).rejects.toThrow('端口');
    await expect(service.configure('office-review', {SMTP_SECURE:'yes'})).rejects.toThrow('TLS');
    await expect(service.configure('office-review', {ACTIVE_PROFILES:'anything'})).rejects.toThrow('未声明');
    await expect(service.configure('office-review', {EMAIL_PASS:'x\r\ny'})).rejects.toThrow('换行');
    const result=await service.configure('office-review',{});
    expect(result.note).toContain('实际任务');
    expect(JSON.stringify(service.connectionStatus())).not.toContain('private-secret');
    await service.revoke('office-review');
    expect(service.configuration('office-review').fields.every(f=>!f.configured)).toBe(true);
    await expect(service.configure('office-review', {})).rejects.toThrow('请填写');
  });
});
