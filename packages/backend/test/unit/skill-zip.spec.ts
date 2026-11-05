import 'reflect-metadata';
import JSZip from 'jszip';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillService } from '../../src/modules/ai/agent/skill.service';
import { readSkillZip } from '../../src/modules/ai/agent/skill-archive';

describe('portable skill ZIP', () => {
  let root: string, service: SkillService;
  const env = { ...process.env };
  const content = '---\nname: report\ndescription: Fixture\n---\n# Work\nUse scripts/run.py';
  const picture = Buffer.from([0, 1, 255, 128, 42]);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-zip-')); process.env['SKYALYTICWING_SKILLS_DIR'] = root;
    service = new SkillService({ info() {}, warn() {} } as any, { addAllowedPath() {}, isPathAllowed: () => true } as any);
    (service as any).skillsRoot = root; service.onModuleInit();
  });
  afterEach(() => { process.env = { ...env }; rmSync(root, { recursive: true, force: true }); });
  async function bundle(prefix = '') {
    const zip = new JSZip(); zip.file(prefix + 'SKILL.md', content); zip.file(prefix + 'scripts/run.py', 'print("hello")', { unixPermissions: 0o100755 });
    zip.folder(prefix + 'output');
    zip.file(prefix + 'assets/binary.png', picture); zip.file(prefix + 'references/说明.txt', '保留中文');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
  }
  it.each(['', 'report/'])('round-trips all script/reference/binary bytes with root %j', async prefix => {
    expect(await service.importZip(await bundle(prefix), 'report.zip')).toMatchObject({ name: 'report' });
    expect(readFileSync(join(root, 'report/assets/binary.png'))).toEqual(picture);
    expect(existsSync(join(root, 'report/output'))).toBe(true);
    const exported = await readSkillZip(await service.exportZip('report'), 'report.zip');
    expect(exported.entries.find(f => f.path === 'assets/binary.png')!.data).toEqual(picture);
    expect(exported.entries.find(f => f.path === 'references/说明.txt')!.data.toString()).toBe('保留中文');
    expect(exported.entries.find(f => f.path === 'scripts/run.py')!.data.toString()).toBe('print("hello")');
  });
  it('does not overwrite an existing skill or run imported scripts', async () => {
    await service.importZip(await bundle(), 'report.zip');
    await expect(service.importZip(await bundle(), 'report.zip')).rejects.toThrow('同名');
    expect(readFileSync(join(root, 'report/SKILL.md'), 'utf8')).toBe(content);
  });
  it.each(['../escape.txt', 'C:/outside.txt', 'report/CON.txt', 'report/script:ads'])('rejects unsafe original ZIP path %s', async path => {
    const zip = new JSZip(); zip.file('report/SKILL.md', content); zip.file(path, 'unsafe');
    await expect(service.importZip(await zip.generateAsync({ type: 'nodebuffer' }), 'report.zip')).rejects.toThrow();
    expect(existsSync(join(root, 'report'))).toBe(false);
  });
  it('rejects case-colliding names, symlinks, and missing definitions', async () => {
    const zip = new JSZip(); zip.file('SKILL.md', content); zip.file('a.txt', 'a'); zip.file('A.txt', 'b');
    await expect(readSkillZip(await zip.generateAsync({ type: 'nodebuffer' }), 'report.zip')).rejects.toThrow('重复');
    const link = new JSZip(); link.file('SKILL.md', content); link.file('secret', '../secret', { unixPermissions: 0o120777 });
    await expect(readSkillZip(await link.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }), 'report.zip')).rejects.toThrow('链接');
    await expect(readSkillZip(await new JSZip().file('readme.txt', 'hello').generateAsync({ type: 'nodebuffer' }), 'report.zip')).rejects.toThrow('SKILL.md');
  });
  it('does not install when enterprise policy denies the imported skill', async () => {
    (service as any).resourcePolicy = { credentialIdentity: () => 'enterprise', assert: async () => { throw Error('not assigned'); } };
    await expect(service.importZip(await bundle(), 'report.zip')).rejects.toThrow('not assigned');
    expect(existsSync(join(root, 'report'))).toBe(false);
  });
  it('rejects damaged CRC data before creating the skill directory', async () => {
    const zip = await new JSZip().file('SKILL.md', content).generateAsync({ type: 'nodebuffer' });
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0, central + 16);
    await expect(service.importZip(zip, 'report.zip')).rejects.toThrow('校验失败');
    expect(existsSync(join(root, 'report'))).toBe(false);
  });
});
