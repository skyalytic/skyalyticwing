import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalResourcePolicy } from '../../src/modules/core/security/local-resource-policy.service';
import { SkillService } from '../../src/modules/ai/agent/skill.service';
import { PluginService } from '../../src/modules/tools/plugin/plugin.service';
import { PluginLoaderService } from '../../src/modules/tools/plugin/plugin-loader.service';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';

describe('standalone local resources without account services', () => {
  let root: string, plugins: PluginService | undefined;
  const previous = { data: process.env['SKYALYTICWING_DATA_DIR'], skills: process.env['SKYALYTICWING_SKILLS_DIR'] };
  const policy = new LocalResourcePolicy();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-local-baseline-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    process.env['SKYALYTICWING_SKILLS_DIR'] = join(root, 'skills');
  });
  afterEach(async () => {
    await plugins?.onModuleDestroy(); plugins = undefined;
    if (previous.data === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = previous.data;
    if (previous.skills === undefined) delete process.env['SKYALYTICWING_SKILLS_DIR']; else process.env['SKYALYTICWING_SKILLS_DIR'] = previous.skills;
    rmSync(root, { recursive: true, force: true });
  });
  it('discovers shipped skills and persists local edits across service restart', async () => {
    const create = () => new SkillService({ info() {}, warn() {} } as never, { addAllowedPath() {}, isPathAllowed: () => true } as never, policy);
    const first = create(); first.onModuleInit();
    expect((await first.listAvailableSkills()).skills.length).toBeGreaterThan(40);
    first.createSkill({ name: 'local-report', steps: 'local procedure' });
    const restarted = create(); restarted.onModuleInit();
    expect((await restarted.getSkillContent('local-report'))?.content).toContain('local procedure');
    expect(policy.localResourceRoot(root)).toBe(root);
  });
  it('loads bundled plugins and preserves local configuration without an account identity', async () => {
    const loader = new PluginLoaderService(policy), registry = new ToolRegistryService();
    plugins = new PluginService(loader, registry, {} as never, policy); plugins.onModuleInit();
    expect(plugins.listPlugins().map(plugin => plugin.id)).toEqual(expect.arrayContaining(['smart-notifier','security-audit','operation-logger']));
    plugins.setPluginConfig('smart-notifier', { webhookUrl: 'https://example.invalid/local-fixture' });
    await plugins.loadPlugin('security-audit');
    expect(registry.get('sec_stats')).toBeDefined();
    expect(plugins.getPluginConfig('smart-notifier')['webhookUrl']).toBe('https://example.invalid/local-fixture');
  });
});
