import 'reflect-metadata';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { parseSkillDocument } from '../../src/modules/ai/agent/skill-document';
import { SkillService } from '../../src/modules/ai/agent/skill.service';
import { LocalResourcePolicy } from '../../src/modules/core/security/local-resource-policy.service';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service';

describe('installed skill discovery and execution context', () => {
  let root: string;
  let service: SkillService;
  const oldRoot = process.env['SKYALYTICWING_SKILLS_DIR'];
  const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-skills-'));
    process.env['SKYALYTICWING_SKILLS_DIR'] = root;
    service = new SkillService(logger as any, { isPathAllowed: () => true, addAllowedPath() {} } as any);
    // This suite isolates parser fixtures; standalone-local-baseline covers the shipped library.
    (service as any).skillsRoot = root;
    service.onModuleInit();
  });
  afterEach(() => {
    if (oldRoot === undefined) delete process.env['SKYALYTICWING_SKILLS_DIR'];
    else process.env['SKYALYTICWING_SKILLS_DIR'] = oldRoot;
    rmSync(root, { recursive: true, force: true });
  });
  function install(name: string, content: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), content);
  }
  it.each(['\n', '\r\n'])('reads BOM, quoted and folded descriptions with %j line endings', (eol) => {
    install('report', '\uFEFF' + ['---', 'description: >-', '  Produce a report:', '  check all totals.', 'emoji: "📋"', '---', '# Guide', '', 'Run the script.'].join(eol));
    expect(service.listSkills().skills[0]).toMatchObject({ name: 'report', description: 'Produce a report: check all totals.', emoji: '📋' });
    expect(parseSkillDocument(readFileSync(join(root, 'report/SKILL.md'), 'utf8')).body).toBe('# Guide\n\nRun the script.');
  });
  it('supports literal multiline metadata and delimiters inside the skill body', () => {
    const doc = parseSkillDocument('---\ndescription: |\n  First line\n  Second line\n---\nStep 1\n---\nStep 2');
    expect(doc.metadata['description']).toContain('First line\nSecond line');
    expect(doc.body).toBe('Step 1\n---\nStep 2');
  });
  it('preserves punctuation and newlines when creating a skill', () => {
    const description = 'Reports: "quoted"\nnext line';
    service.createSkill({ name: 'report', description, steps: 'Use file-write.' });
    expect(service.listSkills().skills[0].description).toBe(description);
  });
  it('rejects malformed updates before overwriting the usable guide', () => {
    service.createSkill({ name: 'report', description: 'reports', steps: 'Original' });
    expect(() => service.updateSkill({ name: 'report', content: '---\ndescription: [\n---\ninvalid' })).toThrow();
    expect(readFileSync(join(root, 'report/SKILL.md'), 'utf8')).toContain('Original');
  });
  it('discovers a newly installed skill without restarting and stops listing it after uninstall', async () => {
    expect(await service.buildPrompt([{ name: 'skill_execute' }])).toBe('');
    install('invoice', '---\ndescription: Verify invoice totals\n---\nRead the csv and calculate totals.');
    const prompt = await service.buildPrompt([{ name: 'skill_execute' }]);
    expect(prompt).toContain('Verify invoice totals');
    expect(prompt).toContain('不代表任务完成');
    service.deleteSkill('invoice');
    expect(await service.buildPrompt([{ name: 'skill_execute' }])).toBe('');
  });
  it('does not advertise skills to an agent without the skill tool', async () => {
    install('invoice', '---\ndescription: invoices\n---\nSteps');
    expect(await service.buildPrompt([{ name: 'file-read' }])).toBe('');
  });
  it('filters incompatible platforms and carries dependency requirements into the model context', async () => {
    install('local', `---\ndescription: local reports\nrequires:\n  platform: ${platform()}\n  bins: [python]\n  env: [REPORT_TOKEN]\n---\nSteps`);
    install('foreign', `---\ndescription: foreign reports\nrequires:\n  platform: ${platform() === 'win32' ? 'darwin' : 'win32'}\n---\nSteps`);
    expect((await service.listAvailableSkills()).skills.map(s => s.name)).toEqual(['local']);
    const prompt = await service.buildPrompt([{ name: 'skill_execute' }]);
    expect(prompt).toContain('python');
    expect(prompt).toContain('REPORT_TOKEN');
    expect(prompt).not.toContain('foreign reports');
  });
  it('does not expose other enterprise skills in either the API list or model prompt', async () => {
    install('enterprise-private', '---\ndescription: Confidential procedure\n---\nSecret');
    install('personal', '---\ndescription: personal reports\n---\nSteps');
    const policy = new LocalResourcePolicy();
    service = new SkillService(logger as any, { isPathAllowed: () => true, addAllowedPath() {} } as any, policy);
    // This suite isolates parser fixtures; standalone-local-baseline covers the shipped library.
    (service as any).skillsRoot = root;
    expect((await service.listAvailableSkills()).skills.map(s => s.name)).toEqual(['personal']);
    expect(await service.buildPrompt([{ name: 'skill_execute' }])).not.toContain('Confidential procedure');
    await expect(service.getSkillContent('enterprise-private')).rejects.toThrow('Account-private');
  });
  it('fails closed on policy outage without preventing ordinary chat', async () => {
    install('report', '---\ndescription: confidential\n---\nSteps');
    service = new SkillService(logger as any, { isPathAllowed: () => true, addAllowedPath() {} } as any, { filterAvailable: async () => { throw new Error('offline'); } } as any);
    // This suite isolates parser fixtures; standalone-local-baseline covers the shipped library.
    (service as any).skillsRoot = root;
    await expect(service.listAvailableSkills()).rejects.toThrow('offline');
    const prompt = await service.buildPrompt([{ name: 'skill_execute' }]);
    expect(prompt).toContain('暂不可用');
    expect(prompt).not.toContain('confidential');
  });
  it('every bundled skill has a meaningful description after parsing', () => {
    const bundled = resolve(__dirname, '../../../web/skills');
    const skills = readdirSync(bundled).filter(name => existsSync(join(bundled, name, 'SKILL.md')));
    expect(skills.length).toBeGreaterThan(50);
    for (const name of skills) {
      const { metadata } = parseSkillDocument(readFileSync(join(bundled, name, 'SKILL.md'), 'utf8'));
      expect(typeof metadata['description']).toBe('string');
      expect(String(metadata['description']).trim().length).toBeGreaterThan(5);
    }
  });
  it('provides skill choices before the first model call and refreshes on the next conversation turn', async () => {
    install('invoice', '---\ndescription: Verify invoice totals\n---\nCalculate');
    const loop = new (AgentLoopService as any)({}, { getAgent: () => ({ systemPrompt: '', tools: [] }) }, {}, logger, {}, {}, {}, {}, { listPolicyNames: () => [] }, {}, {}, { getToolDefinitions: () => [{ name: 'skill_execute' }] }, { getMessages: () => [{ role: 'user', content: 'Check this invoice' }] }, service);
    jest.spyOn(loop, 'getToolPermission').mockReturnValue('auto');
    let context = await loop.buildContext('fixture', 'agent');
    expect(context.find((m: any) => typeof m.content === 'string' && m.content.includes('Verify invoice totals'))?.role).toBe('system');
    service.deleteSkill('invoice');
    context = await loop.buildContext('fixture', 'agent');
    expect(JSON.stringify(context)).not.toContain('Verify invoice totals');
  });
});
