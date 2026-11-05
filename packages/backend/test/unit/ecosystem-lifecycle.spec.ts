import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpService } from '../../src/modules/tools/mcp/mcp.service';
import { AgentService } from '../../src/modules/ai/agent/agent.service';
import { TemplateInstallerService } from '../../src/modules/ecosystem/template-installer.service';
import { openSecret } from '../../src/modules/core/utils/local-secrets';
import type { CatalogItem } from '../../src/modules/ecosystem/ecosystem.service';
describe('local ecosystem persistence',()=>{
  let root:string;const prior=process.env['SKYALYTICWING_DATA_DIR'];
  beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'wing-ecosystem-'));process.env['SKYALYTICWING_DATA_DIR']=root;});
  afterEach(()=>{if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(root,{recursive:true,force:true});});
  it('preserves encrypted MCP credentials over restart and purges revoked recovery copies',()=>{
    const first=new McpService();first.addServer({id:'skyalytic:test',name:'Test',command:'node',env:{KEY:'do-not-leak'},enabled:false});
    expect(readFileSync(join(root,'mcp.json'),'utf8')).not.toContain('do-not-leak');
    const restarted=new McpService();restarted.onModuleInit();restarted.updateServer('skyalytic:test',{name:'After restart'});
    const stored=JSON.parse(readFileSync(join(root,'mcp.json'),'utf8'));expect(openSecret(stored.servers[0].sealedEnv,'mcp:skyalytic:test')).toEqual({KEY:'do-not-leak'});
    restarted.updateServer('skyalytic:test',{env:{},enabled:false});const backup=JSON.parse(readFileSync(join(root,'mcp.json.bak'),'utf8'));expect(openSecret(backup.servers[0].sealedEnv,'mcp:skyalytic:test')).toEqual({});
  });
  it('installs a template into the existing expert/team registry and preserves user edits on uninstall',()=>{
    const agents=new AgentService();agents.onModuleInit();const installer=new TemplateInstallerService(agents);
    const manifest={id:'office-team',kind:'team'} as CatalogItem;
    const result=installer.install(manifest,JSON.stringify({agents:[{key:'writer',name:'Writer',systemPrompt:'Write grounded reports',tools:['read_file']},{key:'reviewer',name:'Reviewer',systemPrompt:'Check claims',tools:['read_file']}],team:{name:'Office',leadKey:'reviewer'}}));
    expect(agents.getTeam(result.teamId!).leadId).toBe(result.agentIds[1]);
    agents.updateAgent(result.agentIds[0],{name:'My writer'});installer.uninstall('office-team');
    expect(agents.getAgent(result.agentIds[0]).name).toBe('My writer');expect(installer.installed()).toEqual([]);
    agents.setMemory(result.agentIds[0],{agentId:result.agentIds[0],facts:['local fact'],lastUpdated:0});const restarted=new AgentService();restarted.onModuleInit();expect(restarted.getMemory(result.agentIds[0]).facts).toEqual(['local fact']);
  });
  it('does not reuse another employee or company credentials and redacts provider errors', async()=>{
    let identity='alice:company'; const policy={assert:async()=>{},credentialIdentity:()=>identity};
    const service=new McpService(policy as never);
    service.addServer({id:'skyalytic:private',name:'Private',command:'node',env:{API_KEY:'sentinel-api-secret'},enabled:false});
    const result=(service as any).redactResult('skyalytic:private',{success:false,error:'401 sentinel-api-secret'});
    expect(result.error).toBe('401 [redacted]');
    identity='bob:company'; expect(service.getEnvironmentForConfiguration('skyalytic:private')).toEqual({});
    await expect(service.startServer('skyalytic:private')).rejects.toThrow('身份');
    service.updateServer('skyalytic:private',{env:{API_KEY:'bob-only-secret'}});
    expect(service.getEnvironmentForConfiguration('skyalytic:private')).toEqual({API_KEY:'bob-only-secret'});
    identity='alice:company'; expect(service.getEnvironmentForConfiguration('skyalytic:private')).toEqual({});
    service.onModuleDestroy();
  });
});
