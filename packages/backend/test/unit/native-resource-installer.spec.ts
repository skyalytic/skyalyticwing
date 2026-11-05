import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeResourceInstaller } from '../../src/modules/ecosystem/native-resource-installer.service';
import { PluginService } from '../../src/modules/tools/plugin/plugin.service';
import { PluginLoaderService } from '../../src/modules/tools/plugin/plugin-loader.service';
import type { CatalogItem } from '../../src/modules/ecosystem/ecosystem.service';
describe('enterprise native plugin installation',()=>{
  const id='enterprise-11111111-1111-4111-8111-111111111111';
  const manifest={id,kind:'plugin',entry:'index.cjs',name:'Company tool',version:'1.0.0'} as CatalogItem;
  let root:string,old:string|undefined,installer:NativeResourceInstaller,plugins:PluginService;
  const registry={registerOwned:jest.fn(),unregisterOwner:jest.fn(),has:jest.fn(()=>false)},guard={assert:jest.fn()};
  const files=(body='module.exports={id:"company-tool",name:"Tool",tools:[{name:"ping",description:"Ping",parameters:{type:"object",properties:{}},execute:async()=>({success:true,data:"pong"})}]}')=>[
    {path:'plugin.json',data:Buffer.from(JSON.stringify({id:'company-tool',main:'index.cjs'}))},
    {path:'index.cjs',data:Buffer.from(body)},{path:'LICENSE',data:Buffer.from('Internal only')}
  ];
  beforeEach(()=>{jest.clearAllMocks();guard.assert.mockResolvedValue(undefined);old=process.env['SKYALYTICWING_DATA_DIR'];root=mkdtempSync(join(tmpdir(),'wing-private-plugin-'));process.env['SKYALYTICWING_DATA_DIR']=root;
    const loader=new PluginLoaderService();plugins=new PluginService(loader,registry as any,{} as any,guard as any);plugins.init();installer=new NativeResourceInstaller(plugins,loader);
  });
  afterEach(async()=>{await plugins.unloadPluginEntry(id);if(old===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=old;rmSync(root,{recursive:true,force:true});});
  it('installs and registers a real plugin under the assigned enterprise resource ID',async()=>{
    await installer.install(manifest,files());expect(installer.installed()[0].id).toBe(id);expect(guard.assert).toHaveBeenCalledWith('plugin',id);
    expect(registry.registerOwned).toHaveBeenCalled();const tool=registry.registerOwned.mock.calls[0]![1][0];await expect(tool.execute({},{})).resolves.toMatchObject({success:true});
    guard.assert.mockRejectedValueOnce(Error('revoked'));await expect(tool.execute({},{})).rejects.toThrow('revoked');
    plugins.setPluginConfig(id,{apiKey:'enterprise-fixture-key'});
    await installer.uninstall(id);expect(installer.installed()).toHaveLength(0);expect(registry.unregisterOwner).toHaveBeenCalled();expect(plugins.getPluginConfig(id)['apiKey']).toBeUndefined();
  });
  it('retains the old installation if replacement staging or loading fails',async()=>{
    await installer.install(manifest,files());
    // Jest has a separate module cache; the production loader clears Node's cache.
    jest.resetModules();
    await expect(installer.install({...manifest,version:'2.0.0'},files('throw Error("broken upgrade")'),true)).rejects.toThrow('加载失败');
    expect(installer.installed()[0].version).toBe('1.0.0');
    const content=readFileSync(join(root,'plugin-data/plugins/enterprise-resources',id,'index.cjs'),'utf8');expect(content).toContain('pong');
  });
  it('installs disk-staged files without requiring in-memory package buffers',async()=>{
    const staged=files().map(f=>{const source=join(root,f.path);writeFileSync(source,f.data);return {path:f.path,source};});
    await installer.install(manifest,staged);expect(installer.installed()[0].id).toBe(id);
    expect(readFileSync(join(root,'plugin-data/plugins/enterprise-resources',id,'index.cjs'),'utf8')).toContain('pong');
    expect(registry.registerOwned).toHaveBeenCalled();
  });
  it('updates with a rollback copy and can restore it without downloading',async()=>{
    await installer.install(manifest,files());await installer.install({...manifest,version:'1.1.0'},files(),true);expect(installer.installed()[0].version).toBe('1.1.0');
    await installer.rollback(id);expect(installer.installed()[0].version).toBe('1.0.0');
  });
});
