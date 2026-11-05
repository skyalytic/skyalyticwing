import 'reflect-metadata';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChannelsService} from '../../src/modules/channels/channels.service.js';
import {ChannelsController} from '../../src/modules/channels/channels.controller.js';

const types=['dingtalk','feishu','wechat-work','discord','qq','telegram','slack','wecom','weixin'];
describe('channel configuration lifecycle',()=>{
 let directory:string,previous:string|undefined;
 const instances:ChannelsService[]=[];
 function make(){
  const providers=types.map(type=>{
   const provider:any={type,config:null,status:{connected:false,lastError:null,lastMessageAt:null,messagesReceived:0,messagesSent:0},onMessage:jest.fn(),onStatusChange:jest.fn()};
   provider.connect=jest.fn(async(config:any)=>{provider.config=config;provider.status.connected=true;provider.status.lastError=null;return{success:true};});
   provider.disconnect=jest.fn(async()=>{provider.status.connected=false;provider.status.lastError=null;});
   provider.getStatus=()=>({...provider.status});return provider;
  });
  const service=new (ChannelsService as any)({info:jest.fn(),warn:jest.fn()},{broadcast:jest.fn()},{},...providers) as ChannelsService;
  service.onModuleInit();instances.push(service);
  return{service,providers:Object.fromEntries(types.map((type,i)=>[type,providers[i]])),controller:new ChannelsController(service)};
 }
 beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'wing-channel-lifecycle-'));previous=process.env['SKYALYTICWING_DATA_DIR'];process.env['SKYALYTICWING_DATA_DIR']=directory;});
 afterEach(async()=>{await Promise.all(instances.splice(0).map(s=>s.onModuleDestroy()));if(previous===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=previous;rmSync(directory,{recursive:true,force:true});});
 it.each(['weixin','wechat-work','dingtalk','feishu'])('first save creates and connects the %s card; disable disconnects and re-enable retains credentials',async(type)=>{
  const {service,providers,controller}=make();
  const response=await controller.update(type,{enabled:true,credentials:{botToken:'test-token',secret:'test-secret'}});
  expect(response.data.channel).toMatchObject({id:type,enabled:true,status:'connected'});
  expect(providers[type].connect).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(join(directory,'channels.json'),'utf8'))[type]).toMatchObject({enabled:true,credentials:{botToken:'test-token'}});
  expect(service.getAllStatus()[type]).toMatchObject({connected:true,status:'connected',enabled:true});
  expect(JSON.stringify(service.listChannels())).not.toContain('test-token');
  await controller.update(type,{enabled:false});
  expect(providers[type].status.connected).toBe(false);
  expect(service.getAllStatus()[type]).toMatchObject({enabled:false,status:'disconnected'});
  await controller.update(type,{enabled:true});
  expect(providers[type].config.botToken).toBe('test-token');
 });
 it('rejects unknown IDs instead of reporting a successful no-op',async()=>{
  const {controller}=make();await expect(controller.update('not-a-channel',{enabled:true})).rejects.toThrow('Channel not found');
 });
 it('returns connecting after persistence without waiting for a long poll, then exposes the result',async()=>{
  const {controller,service,providers}=make();let release!:()=>void;
  providers['weixin'].connect.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});providers['weixin'].status.connected=true;return{success:true};});
  const response=await controller.update('weixin',{enabled:true,credentials:{botToken:'test'}},'true');
  expect(response.data.channel).toMatchObject({enabled:true,status:'connecting'});
  expect(JSON.parse(readFileSync(join(directory,'channels.json'),'utf8')).weixin.credentials.botToken).toBe('test');
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  release();await Promise.all([...(service as any).operations.values()]);
  expect(service.getAllStatus()['weixin']).toMatchObject({status:'connected'});
 });
 it('retains an asynchronous connection error without undoing the saved configuration',async()=>{
  const {controller,service,providers}=make();
  providers['weixin'].connect.mockResolvedValueOnce({success:false,error:'upstream unavailable'});
  const response=await controller.update('weixin',{enabled:true,credentials:{botToken:'test'}},'true');
  expect(response.data.channel.status).toBe('connecting');
  await Promise.allSettled([...(service as any).operations.values()]);
  expect(service.getAllStatus()['weixin']).toMatchObject({enabled:true,status:'error',lastError:'upstream unavailable'});
  expect(JSON.parse(readFileSync(join(directory,'channels.json'),'utf8')).weixin.enabled).toBe(true);
 });
 it('keeps connecting while the provider clears its old connection during validation',async()=>{
  const {controller,service,providers}=make();let release!:()=>void;
  providers['weixin'].connect.mockImplementationOnce(async()=>{
    const callback=providers['weixin'].onStatusChange.mock.calls[0][0];
    callback('weixin',{...providers['weixin'].status,connected:false,lastError:null});
    await new Promise<void>(resolve=>{release=resolve;});
    providers['weixin'].status.connected=true;return{success:true};
  });
  await controller.update('weixin',{enabled:true,credentials:{botToken:'test'}},'true');
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  expect(service.getAllStatus()['weixin']).toMatchObject({status:'connecting'});
  release();await Promise.all([...(service as any).operations.values()]);
  expect(service.getAllStatus()['weixin']).toMatchObject({status:'connected'});
 });
 it('rejects masked credentials without overwriting a previously working account',async()=>{
  const {service}=make();await service.saveChannel('weixin',{enabled:false,credentials:{botToken:'real-token'}});
  await expect(service.saveChannel('weixin',{enabled:true,credentials:{botToken:'***'}})).rejects.toThrow('脱敏占位符');
  expect(JSON.parse(readFileSync(join(directory,'channels.json'),'utf8')).weixin).toMatchObject({enabled:false,credentials:{botToken:'real-token'}});
 });
 it('keeps secrets on a partial edit and never returns their values through the editor endpoint',async()=>{
  const {service,controller}=make();
  await controller.update('weixin',{enabled:true,credentials:{botToken:'test-secret',baseUrl:'https://example.invalid'}});
  expect(service.getConfiguration('weixin')).toEqual({credentials:{baseUrl:'https://example.invalid'},configuredSecrets:['botToken']});
  await controller.update('weixin',{credentials:{baseUrl:'https://other.invalid'}});
  const config=JSON.parse(readFileSync(join(directory,'channels.json'),'utf8')).weixin;
  expect(config.credentials).toEqual({botToken:'test-secret',baseUrl:'https://other.invalid'});
 });
 it('restores enabled channels after restart, leaves disabled channels disconnected, and supports custom IDs',async()=>{
  const {service}=make();await service.saveChannel('weixin',{enabled:true,credentials:{botToken:'test'}});
  await service.saveChannel('feishu',{enabled:false,credentials:{botToken:'test'}});
  service.addChannel({id:'corp-account',type:'wechat-work' as any,name:'Corp',enabled:true,credentials:{botId:'test',secret:'test'}});
  const restored=make();restored.service.onApplicationBootstrap();
  await Promise.all([...(restored.service as any).operations.values()]);
  expect(restored.providers['weixin'].connect).toHaveBeenCalledTimes(1);
  expect(restored.providers['feishu'].connect).not.toHaveBeenCalled();
  expect(restored.service.getAllStatus()['corp-account']).toMatchObject({enabled:true,status:'connected'});
 });
 it('shows only the eight retained channel types and never reconnects removed saved channels',async()=>{
  writeFileSync(join(directory,'channels.json'),JSON.stringify({telegram:{id:'telegram',type:'telegram',name:'Telegram',enabled:true,credentials:{botToken:'preserved'}}}));
  const {service,providers}=make();service.onApplicationBootstrap();await Promise.all([...(service as any).operations.values()]);
  expect(service.listChannels().map(c=>c.type)).toEqual(['weixin','wechat-work','dingtalk','feishu','email','sms','cli','webchat']);
  expect(providers['telegram'].connect).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(directory,'channels.json'),'utf8')).telegram.credentials.botToken).toBe('preserved');
  await expect(service.connectChannel('telegram')).rejects.toThrow('no longer supported');
 });
 it('returns a saved but failed connection distinctly and recovers on retry',async()=>{
  const {controller,service,providers}=make();
  providers['weixin'].connect.mockImplementationOnce(async()=>{providers['weixin'].status.lastError='expired';return{success:false,error:'expired'};});
  expect((await controller.update('weixin',{enabled:true,credentials:{botToken:'test'}})).data.channel).toMatchObject({enabled:true,status:'error',lastError:'expired'});
  expect(service.getAllStatus()['weixin']).toMatchObject({enabled:true,status:'error',connected:false});
  await service.connectChannel('weixin');expect(service.getAllStatus()['weixin']).toMatchObject({status:'connected',lastError:null});
 });
 it('serializes a fast disable after a slow enable so the final state stays disabled',async()=>{
  const {service,providers}=make();let release!:()=>void;
  providers['weixin'].connect.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});providers['weixin'].status.connected=true;return{success:true};});
  const enable=service.saveChannel('weixin',{enabled:true,credentials:{botToken:'test'}});
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const disable=service.saveChannel('weixin',{enabled:false});release();await Promise.all([enable,disable]);
  expect(service.getAllStatus()['weixin']).toMatchObject({enabled:false,status:'disconnected'});
  expect(JSON.parse(readFileSync(join(directory,'channels.json'),'utf8')).weixin.enabled).toBe(false);
 });
 it('does not report successful persistence when the write fails, and restores the in-memory configuration',async()=>{
  const {service}=make();await service.saveChannel('weixin',{enabled:false,credentials:{botToken:'test'}});
  (service as any).channelsPath=directory;
  await expect(service.saveChannel('weixin',{enabled:true})).rejects.toThrow('保存失败');
  expect(service.listChannels().find(c=>c.id==='weixin').enabled).toBe(false);
 });
});
