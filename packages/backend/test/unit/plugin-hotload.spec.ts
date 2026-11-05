import 'reflect-metadata';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/modules/tools/plugin/plugin.service';
import { PluginLoaderService } from '../../src/modules/tools/plugin/plugin-loader.service';
import { ToolRegistryService } from '../../src/modules/tools/executor/tool-registry.service';

describe('local folder hot plug', () => {
  let root: string, service: PluginService, loader: PluginLoaderService, registry: ToolRegistryService;
  const before = process.env['SKYALYTICWING_DATA_DIR'];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-hotload-')); process.env['SKYALYTICWING_DATA_DIR'] = root;
    loader = new PluginLoaderService(); registry = new ToolRegistryService();
    service = new PluginService(loader, registry, {} as never); service.init();
  });
  afterEach(() => { service.onModuleDestroy(); if (before === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = before; rmSync(root, { recursive: true, force: true }); });
  function plugin(id: string, value: string, tool = 'local_fixture') {
    const dir = join(root, 'plugins', id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, main: 'index.cjs', name: id }));
    writeFileSync(join(dir, 'value.cjs'), `module.exports=${JSON.stringify(value)}`);
    writeFileSync(join(dir, 'index.cjs'), `module.exports={id:${JSON.stringify(id)},type:'tool',tools:[{name:${JSON.stringify(tool)},execute:async()=>({success:true,output:require('./value.cjs')})}]}`);
    return dir;
  }
  async function scan() { await service.refreshLocalPlugins(); await service.refreshLocalPlugins(); }
  it('discovers a copied folder, invokes it, reloads a dependency and removes tools after deletion', async () => {
    const dir = plugin('local-fixture', 'one'); await scan();
    expect(registry.has('local_fixture')).toBe(true);
    expect((await registry.get('local_fixture')!.execute({}, {} as never)).output).toBe('one');
    writeFileSync(join(dir, 'value.cjs'), "module.exports='two'"); await scan();
    expect((await registry.get('local_fixture')!.execute({}, {} as never)).output).toBe('two');
    rmSync(dir, { recursive: true }); await scan(); expect(registry.has('local_fixture')).toBe(false);
    plugin('local-fixture', 'three'); await scan(); expect(registry.has('local_fixture')).toBe(true);
    service.setEnabled('local-fixture', false);
    writeFileSync(join(dir, 'value.cjs'), "module.exports='four'"); await scan();
    expect(registry.has('local_fixture')).toBe(false);
    await service.uninstallPlugin('local-fixture'); await scan();
    expect(service.listPlugins()).toHaveLength(0);
  });
  it('rejects junction escapes and collisions without replacing another plugin tool', async () => {
    const dir = plugin('first', 'original'); await scan();
    plugin('second', 'replacement'); await scan();
    expect((await registry.get('local_fixture')!.execute({}, {} as never)).output).toBe('original');
    expect(service.listPlugins().some(p => p.id === 'second')).toBe(false);
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(dir, 'escape'), 'junction');
    writeFileSync(join(outside, 'evil.cjs'), 'module.exports={}');
    expect(loader.isPathTrustedPluginDir(join(dir, 'escape', 'evil.cjs'))).toBe(false);
  });
  it('passes saved configuration to tool calls and clears it on explicit uninstall', async()=>{
    const dir=plugin('configured','unused');
    writeFileSync(join(dir,'index.cjs'),"module.exports={id:'configured',type:'tool',tools:[{name:'local_fixture',execute:async(_,ctx)=>({success:true,output:ctx.config.apiKey==='fixture-key'?'configured':'missing'})}]}");
    await scan();service.setPluginConfig('configured',{apiKey:'fixture-key'});
    expect((await registry.get('local_fixture')!.execute({},{} as never)).output).toBe('configured');
    await service.uninstallPlugin('configured');expect(service.getPluginConfig('configured')['apiKey']).toBeUndefined();
  });
});
