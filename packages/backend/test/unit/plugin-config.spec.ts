import 'reflect-metadata';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginService} from '../../src/modules/tools/plugin/plugin.service';
import {ToolRegistryService} from '../../src/modules/tools/executor/tool-registry.service';
import {openSecret} from '../../src/modules/core/utils/local-secrets';
describe('native plugin configuration',()=>{
  let root:string,service:PluginService,identity:string;const before=process.env['SKYALYTICWING_DATA_DIR'];
  const schema={type:'object',properties:{accessCode:{type:'string',writeOnly:true},apiKey:{type:'string'},region:{type:'string'}}};
  const create=()=>{const p=new PluginService({unload(){}} as never,new ToolRegistryService(),{} as never,{assert:async()=>{},credentialIdentity:()=>identity} as never);p.init();p.register({id:'private-config',configSchema:schema});return p;};
  beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'wing-plugin-config-'));process.env['SKYALYTICWING_DATA_DIR']=root;identity='alice:org';service=create();});
  afterEach(()=>{service.onModuleDestroy();if(before===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=before;rmSync(root,{recursive:true,force:true});});
  it('encrypts, masks schema secrets, preserves masked edits, isolates identity and clears recovery secrets',()=>{
    service.setPluginConfig('private-config',{accessCode:'schema-secret',apiKey:'api-secret',region:'east'});
    const file=join(root,'plugin-data/plugin-config.json');expect(readFileSync(file,'utf8')).not.toContain('api-secret');
    expect(service.getPluginConfigForController('private-config')).toEqual({accessCode:'***',apiKey:'***',region:'east'});
    service.setPluginConfig('private-config',{accessCode:'***',apiKey:'***',region:'west'});expect(service.getPluginConfig('private-config')['apiKey']).toBe('api-secret');
    service=create();expect(service.getPluginConfig('private-config')['accessCode']).toBe('schema-secret');
    identity='bob:org';expect(service.getPluginConfigForController('private-config')).toEqual({});expect(()=>service.getPluginConfig('private-config')).toThrow('身份');
    service.setPluginConfig('private-config',{apiKey:'bob-key'});expect(service.getPluginConfig('private-config')['accessCode']).toBeUndefined();
    service.clearPluginConfig('private-config');for(const p of [file,file+'.bak']){const data=JSON.parse(readFileSync(p,'utf8'));expect(JSON.stringify(openSecret(data.sealed,'plugin-config'))).not.toContain('bob-key');}
  });
  it('migrates legacy plaintext without leaving a plaintext recovery file',()=>{
    identity='local';const dir=join(root,'plugin-data');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'plugin-config.json'),JSON.stringify({'private-config':{apiKey:'legacy-secret'}}));
    service=create();expect(service.getPluginConfig('private-config')['apiKey']).toBe('legacy-secret');
    for(const p of ['plugin-config.json','plugin-config.json.bak'])expect(readFileSync(join(dir,p),'utf8')).not.toContain('legacy-secret');
  });
});
