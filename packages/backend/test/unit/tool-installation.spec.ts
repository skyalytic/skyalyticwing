import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionSelectionService } from '../../src/extensions/extension-selection.service';
import { ExtensionHostService } from '../../src/extensions/extension-host.service';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';

const makeTool = (name: string, execute = jest.fn(async () => ({ success: true }))) => ({ name, description: name, category: 'system', dangerous: false, parameters: { type: 'object', properties: {} }, execute } as any);
describe('individual tool installation', () => {
  let root: string, old: string | undefined, selection: ExtensionSelectionService, registry: ToolRegistryService, host: ExtensionHostService;
  let dispose: jest.Mock, tools: any[];
  function createHost() {
    registry = new ToolRegistryService(selection); host = new ExtensionHostService(registry, selection);
    const manifest = (host as any).catalog.get('wing-files');
    (host as any).catalog = new Map([['wing-files', { ...manifest, tools: tools.map(({ execute, parameters, ...t }) => t) }]]);
    jest.spyOn(host as any, 'create').mockImplementation(async () => ({ tools, dispose }));
  }
  beforeEach(async () => {
    old = process.env['SKYALYTICWING_DATA_DIR']; root = mkdtempSync(join(tmpdir(), 'wing-tool-install-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    writeFileSync(join(root,'extension-selection.json'),JSON.stringify({version:1,legacy:false,tools:[],skills:[],plugins:[]}));
    selection = new ExtensionSelectionService(); tools = [makeTool('read'), makeTool('write')]; dispose = jest.fn();
    createHost(); await host.initialize({} as any);
  });
  afterEach(async () => {
    await host.onModuleDestroy();
    if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = old;
    rmSync(root, { recursive: true, force: true });
  });
  it('lists every available tool without loading uninstalled code, and installs only the requested member', async () => {
    const catalog = await host.toolCatalog();
    expect(catalog.map(t => [t.name, t.installed, t.loaded])).toEqual([['read', false, false], ['write', false, false]]);
    expect((host as any).create).not.toHaveBeenCalled();
    await host.setToolInstalled('read', true);
    expect(registry.getAll().map(t => t.name)).toEqual(['read']);
    expect((await host.toolCatalog()).find(t => t.name === 'write')?.installed).toBe(false);
  });
  it('cancels only the removed tool and revokes saved handles without affecting its sibling', async () => {
    let signal: AbortSignal | undefined;
    tools[0] = makeTool('read', jest.fn((_a, ctx) => { signal = ctx.signal; return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ success: false }), { once: true })); }) as any);
    await host.install('wing-files');
    const stale = registry.get('read')!, sibling = registry.get('write'), pending = stale.execute({}, {} as any);
    await host.setToolInstalled('read', false);
    expect(signal!.aborted).toBe(true); expect((await pending).success).toBe(false);
    expect(registry.get('write')).toBe(sibling); expect(dispose).not.toHaveBeenCalled();
    expect(registry.get('read')).toBeUndefined(); expect((await stale.execute({}, {} as any)).success).toBe(false);
    expect(await host.guidance(new Set(['read']))).toBe('');
    await host.setToolInstalled('read', true);
    expect(registry.get('read')).toBeDefined(); expect((await stale.execute({}, {} as any)).success).toBe(false);
  });
  it('retains individual removal after reload and restart, and disposes the package after its last tool is removed', async () => {
    await host.install('wing-files'); await host.setToolInstalled('read', false); await host.reload('wing-files');
    expect(registry.has('read')).toBe(false); expect(registry.has('write')).toBe(true);
    await host.onModuleDestroy(); createHost(); await host.initialize({} as any);
    expect(registry.has('read')).toBe(false); expect(registry.has('write')).toBe(true);
    dispose.mockClear(); await host.setToolInstalled('write', false);
    expect(dispose).toHaveBeenCalledTimes(1); expect(registry.getAll()).toEqual([]);
    expect((await host.toolCatalog()).every(t => !t.installed)).toBe(true);
    expect(await host.guidance(new Set(['read', 'write']))).toBe('');
    await host.setToolInstalled('write', true);
    expect(registry.getAll().map(t => t.name)).toEqual(['write']);
  });
  it('keeps plugin/MCP tools removed through provider reload and aborts them without removing their owner', async () => {
    registry.registerOwned('plugin:test', [makeTool('external'), makeTool('peer')]);
    const oldHandle = registry.get('external')!;
    await host.setToolInstalled('external', false);
    expect(registry.has('external')).toBe(false); expect(registry.has('peer')).toBe(true);
    registry.unregisterOwner('plugin:test'); registry.registerOwned('plugin:test', [makeTool('external'), makeTool('peer')]);
    expect(registry.has('external')).toBe(false);
    await host.setToolInstalled('external', true);
    expect(registry.has('external')).toBe(true); expect((await oldHandle.execute({}, {} as any)).success).toBe(false);
  });
  it('rolls back a failed install and rejects unknown tools without changing persisted selection', async () => {
    const before = readFileSync(join(root, 'extension-selection.json'), 'utf8');
    (host as any).create.mockRejectedValueOnce(new Error('broken package'));
    await expect(host.setToolInstalled('read', true)).rejects.toThrow('broken package');
    await expect(host.setToolInstalled('unknown', true)).rejects.toThrow('Unknown tool');
    expect(readFileSync(join(root, 'extension-selection.json'), 'utf8')).toBe(before);
    expect(registry.getAll()).toEqual([]);
  });
  it('does not carry removal or saved invocation handles into another local profile', async () => {
    let scope = join(root, 'a'); selection = new ExtensionSelectionService({ localResourceRoot: () => scope } as any);
    createHost(); await host.initialize({} as any); await host.install('wing-files');
    const stale = registry.get('write')!; await host.setToolInstalled('read', false);
    scope = join(root, 'b'); expect((await stale.execute({}, {} as any)).success).toBe(false);
    await host.refresh(); expect(registry.getAll().map(t=>t.name).sort()).toEqual(['read','write']);
    await host.install('wing-files'); expect(registry.getAll()).toHaveLength(2);
    scope = join(root, 'a'); await host.refresh(); expect(registry.getAll().map(t => t.name)).toEqual(['write']);
  });
});
