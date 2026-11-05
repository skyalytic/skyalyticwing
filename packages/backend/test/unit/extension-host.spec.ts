import 'reflect-metadata';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionHostService } from '../../src/extensions/extension-host.service';
import { ExtensionSelectionService, prepareExtensionSelection } from '../../src/extensions/extension-selection.service';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';
import { SkillService } from '../../src/modules/ai/agent/skill.service';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service';

const tool = (name: string, execute = jest.fn(async () => ({ success: true }))) => ({ name, execute, description: name, category: 'system', parameters: { type: 'object', properties: {} } } as any);
describe('extension ownership and installation', () => {
  let root: string, old: string | undefined, registry: ToolRegistryService, selection: ExtensionSelectionService, host: ExtensionHostService;
  let dispose: jest.Mock;
  beforeEach(() => {
    old = process.env['SKYALYTICWING_DATA_DIR'];
    root = mkdtempSync(join(tmpdir(), 'wing-extension-test-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    // Most ownership tests explicitly select an empty installation.
    writeFileSync(join(root, 'extension-selection.json'), JSON.stringify({version:1,legacy:false,tools:[]}));
    registry = new ToolRegistryService(); selection = new ExtensionSelectionService();
    host = new ExtensionHostService(registry, selection); dispose = jest.fn();
    jest.spyOn(host as any, 'create').mockImplementation(async (id: string) => ({ tools: [tool(id === 'wing-computer-use' ? 'computer_use' : id)], dispose }));
  });
  afterEach(async () => {
    await host.onModuleDestroy();
    if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = old;
    rmSync(root, { recursive: true, force: true });
  });
  it('preserves an explicitly empty tool selection across initialization', async () => {
    prepareExtensionSelection(); await host.initialize({} as any);
    expect(registry.getAll()).toEqual([]);
    expect((host as any).create).not.toHaveBeenCalled();
    expect((await host.list()).every(e => !e.installed && !e.loaded)).toBe(true);
    expect(await host.guidance(new Set(['computer_use']))).toBe('');
  });
  it('migrates once and respects removal across a host restart', async () => {
    unlinkSync(join(root, 'extension-selection.json'));
    writeFileSync(join(root, 'config.json'), '{}'); prepareExtensionSelection();
    await host.initialize({} as any); expect(registry.has('computer_use')).toBe(true);
    await host.uninstall('wing-computer-use');
    await host.onModuleDestroy();
    host = new ExtensionHostService(registry, new ExtensionSelectionService());
    jest.spyOn(host as any, 'create').mockImplementation(async (id: string) => ({ tools: [tool(id)], dispose }));
    await host.initialize({} as any);
    expect((await host.list()).find(e => e.id === 'wing-computer-use')?.installed).toBe(false);
  });
  it('installs bundled tools for a fresh profile once and preserves later removals', async () => {
    unlinkSync(join(root, 'extension-selection.json'));
    prepareExtensionSelection(); await host.initialize({} as any);
    expect((await host.list()).every(e => e.installed && e.loaded)).toBe(true);
    expect(registry.has('computer_use')).toBe(true);
    await host.uninstall('wing-computer-use');
    await host.refresh();
    expect(selection.has('tools', 'wing-computer-use')).toBe(false);
    expect(registry.has('computer_use')).toBe(false);
    expect(await host.guidance(new Set(['computer_use']))).toBe('');
    expect(selection.list('skills')).toEqual([]);
  });
  it('installs and removes the guide together with its tool, leaving user skills untouched', async () => {
    prepareExtensionSelection(); await host.initialize({} as any);
    await host.install('wing-computer-use');
    expect(await host.guidance(new Set(['computer_use']))).toContain('node_repl');
    expect(await host.guidance(new Set())).toBe('');
    expect(selection.list('skills')).toEqual([]);
    const stale = registry.get('computer_use')!;
    await host.uninstall('wing-computer-use');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.has('computer_use')).toBe(false);
    expect(await host.guidance(new Set(['computer_use']))).toBe('');
    expect((await stale.execute({}, {} as any)).success).toBe(false);
  });
  it('does not partially register a conflicting package or persist a failed install', async () => {
    await host.initialize({} as any); registry.register(tool('collision'));
    (host as any).create.mockResolvedValue({ tools: [tool('first'), tool('collision')], dispose });
    await expect(host.install('wing-files')).rejects.toThrow('conflict');
    expect(registry.has('first')).toBe(false); expect(selection.has('tools', 'wing-files')).toBe(false);
  });
  it('keeps the previous generation usable if an update fails validation', async () => {
    await host.initialize({} as any); await host.install('wing-files');
    const prior = registry.get('wing-files'); registry.register(tool('collision'));
    (host as any).create.mockResolvedValue({ tools: [tool('collision')], dispose: jest.fn() });
    await expect(host.reload('wing-files')).rejects.toThrow('conflict');
    expect(registry.get('wing-files')).toBe(prior); expect(dispose).not.toHaveBeenCalled();
  });
  it('aborts active calls and revokes saved handles when their owner is removed', async () => {
    let signal: AbortSignal | undefined;
    registry.registerOwned('example', [tool('long', jest.fn((_args, ctx) => {
      signal = ctx.signal; return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ success: false }), { once: true }));
    }) as any)], true);
    const stale = registry.get('long')!, result = stale.execute({}, {} as any);
    registry.unregisterOwner('example'); expect(signal!.aborted).toBe(true);
    expect((await result).success).toBe(false);
    expect(registry.isReserved('long')).toBe(false);
    expect((await stale.execute({}, {} as any)).success).toBe(false);
  });
  it('does not resurrect a loader that completed after unregister', async () => {
    let finish!: (t: any) => void;
    const pending = registry.ensureLoaded('slow', () => new Promise(resolve => { finish = resolve; }));
    registry.unregister('slow'); finish(tool('slow')); await pending;
    expect(registry.has('slow')).toBe(false);
  });
  it('keeps account scopes isolated and revokes an old identity before installing another', async () => {
    let scope = join(root, 'identity-a');
    mkdirSync(scope, {recursive:true});
    writeFileSync(join(scope, 'extension-selection.json'), JSON.stringify({version:1,legacy:false,tools:[]}));
    selection = new ExtensionSelectionService({ localResourceRoot: () => scope } as any);
    host = new ExtensionHostService(registry, selection);
    jest.spyOn(host as any, 'create').mockResolvedValue({ tools: [tool('computer_use')], dispose });
    await host.initialize({} as any); await host.install('wing-computer-use');
    const prior = registry.get('computer_use')!;
    scope = join(root, 'identity-b');
    mkdirSync(scope, {recursive:true});
    writeFileSync(join(scope, 'extension-selection.json'), JSON.stringify({version:1,legacy:false,tools:[]}));
    expect((await prior.execute({}, {} as any)).success).toBe(false);
    await host.refresh(); expect(registry.getAll()).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('only exposes installed baseline skills and never reappears after deletion', async () => {
    const baseline = join(root, 'baseline'), custom = join(root, 'custom');
    mkdirSync(join(baseline, 'report'), { recursive: true });
    writeFileSync(join(baseline, 'report/SKILL.md'), '---\nname: report\ndescription: Report\n---\nRead totals.');
    const service = new SkillService({ info() {}, warn() {} } as any, { isPathAllowed: () => true, addAllowedPath() {} } as any, undefined, selection);
    Object.assign(service, { skillsRoot: baseline, localRoot: custom }); service.onModuleInit();
    expect(service.listSkills().skills).toEqual([]);
    await service.installBaseline('report'); expect(service.listSkills().skills.map(s => s.name)).toEqual(['report']);
    service.deleteSkill('report'); expect(service.listSkills().skills).toEqual([]);
    expect(readFileSync(join(baseline, 'report/SKILL.md'), 'utf8')).toContain('Read totals.');
  });
  it('an explicit empty agent selection does not inherit every installed tool', () => {
    const loop = Object.create(AgentLoopService.prototype);
    Object.assign(loop, { toolExecutor: { getToolDefinitions: () => [tool('bash')] }, toolPolicy: { listPolicyNames: () => [] } });
    loop.getToolPermission = () => 'allowed'; loop.tryGetAgent = () => ({ tools: [], toolsMode: 'selected' });
    expect(loop.getToolDefinitions('a')).toEqual([]);
    loop.tryGetAgent = () => ({ tools: [], toolsMode: 'none' }); expect(loop.getToolDefinitions('a')).toBeUndefined();
    loop.tryGetAgent = () => ({ tools: [] }); expect(loop.getToolDefinitions('a')).toHaveLength(1);
  });
});

