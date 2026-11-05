import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalOfficeService, LocalOfficeController } from '../../src/modules/tools/files/local-office.service';

describe('Local Office installer boundary',()=>{
 let dir:string,service:LocalOfficeService;const prior=process.env['SKYALYTICWING_DATA_DIR'];
 beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'wing-local-office-'));process.env['SKYALYTICWING_DATA_DIR']=dir;service=new LocalOfficeService({configuration:()=>({managed:false}),validCapability:()=>false} as never);});
 afterEach(()=>{service.onModuleDestroy();if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(dir,{recursive:true,force:true});});
 it('rejects remote UI origins before spawning any installer',async()=>{
  for(const origin of ['https://example.com','http://127.0.0.1:910/path','http://u:p@localhost:910','http://localhost:910/?x=1'])await expect(service.start(origin,true)).rejects.toThrow();
  expect(service.status().running).toBe(false);
 });
 it('accepts only local socket callers for system mutations',()=>{
  const c=new LocalOfficeController(service);expect(()=>c.cancel({socket:{remoteAddress:'192.168.1.2'}} as never)).toThrow('本机');
  expect(c.cancel({socket:{remoteAddress:'::ffff:127.0.0.1'}} as never).running).toBe(false);
 });
 it('WOPI bridge exposes only a random health path or valid file capability',async()=>{
  await (service as any).ensureBridge();const port=service.status().bridgePort;
  for(const route of ['/health','/api/identity/me','/api/office-engine/wopi/files/'+'a'.repeat(48)+'?access_token=wrong']){
   const response=await fetch('http://127.0.0.1:'+port+route);expect(response.status).toBe(403);
  }
  expect(await (await fetch('http://127.0.0.1:'+port+'/health/'+(service as any).healthToken)).text()).toBe('wing-office');
 });
 it('does not override a managed enterprise engine',async()=>{
  const managed=new LocalOfficeService({configuration:()=>({managed:true})} as never);
  await expect(managed.start('http://localhost:910',true)).rejects.toThrow('企业');
 });
});
