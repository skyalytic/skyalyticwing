import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Module, type INestApplication } from '@nestjs/common';
import { RedactInterceptor } from '../../src/modules/core/logger/redact.interceptor.js';
import { AuthGuard } from '../../src/modules/core/security/auth.guard.js';
import { WechatService } from '../../src/modules/channels/wechat/wechat.service.js';
import { WeixinController, WecomController } from '../../src/modules/channels/wechat/wechat.controller.js';
import { ChannelsController } from '../../src/modules/channels/channels.controller.js';
import { ChannelsService } from '../../src/modules/channels/channels.service.js';
import { WeixinProvider } from '../../src/modules/channels/providers/weixin.service.js';

describe('QR credentials through authenticated HTTP and the real response interceptor',()=>{
 let app:INestApplication, base:string, directory:string, previous:string|undefined;
 let wechat:WechatService, channels:ChannelsService, post:jest.Mock;
 const headers={Authorization:'Bearer local-test-auth','Content-Type':'application/json'};
 const providers:any[]=[];
 beforeAll(async()=>{
  directory=mkdtempSync(join(tmpdir(),'wing-qr-http-'));
  previous=process.env['SKYALYTICWING_DATA_DIR'];process.env['SKYALYTICWING_DATA_DIR']=directory;
  const logger:any={info:jest.fn(),warn:jest.fn(),debug:jest.fn(),error:jest.fn()};
  const http:any={get:jest.fn(async(url:string)=>({data:url.includes('get_bot_qrcode')?{ret:0,qrcode:'qr-test',qrcode_img_content:'https://example.invalid/qr'}:url.includes('query_result')?{data:{status:'success',bot_info:{botid:'corp-bot',secret:'fresh-corp-secret'}}}:{status:'confirmed',bot_token:'fresh-qr-token',baseurl:'https://lane.weixin.qq.com',base_url:'https://obsolete.invalid'}}))};
  post=jest.fn(async(url:string,_body:any,options:any)=>({data:url==='https://lane.weixin.qq.com/ilink/bot/getupdates'&&options.headers.Authorization==='Bearer fresh-qr-token'&&options.headers['X-WECHAT-UIN']?{ret:0,msgs:[]}:{ret:-14,errmsg:'session timeout'}}));http.post=post;
  wechat=new WechatService(logger,http,{} as any);
  const wx=new WeixinProvider(logger,{} as any,http);
  for(const type of ['dingtalk','feishu','wechat-work','discord','qq','telegram','slack','wecom']){
   const p:any={type,config:null,status:{connected:false,lastError:null},onMessage:jest.fn(),onStatusChange:jest.fn()};
   p.getStatus=()=>({...p.status});p.disconnect=async()=>{p.status.connected=false;};p.connect=async(config:any)=>{p.config=config;p.status.connected=true;return{success:true};};providers.push(p);
  }
  channels=new (ChannelsService as any)(logger,{broadcast:jest.fn()},{},...providers,wx);
  @Module({controllers:[WeixinController,WecomController,ChannelsController],providers:[{provide:WechatService,useValue:wechat},{provide:ChannelsService,useValue:channels}]})
  class TestModule{}
  app=await NestFactory.create(TestModule,{logger:false});app.setGlobalPrefix('api');
  app.useGlobalGuards(new AuthGuard({get:()=>({auth:{mode:'token',token:'local-test-auth'}})} as any));
  app.useGlobalInterceptors(new RedactInterceptor());
  await app.listen(0,'127.0.0.1');base=await app.getUrl();
 },30000);
 afterAll(async()=>{
  if(app)await app.close();
  if(previous===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=previous;
  if(directory&&resolve(directory).startsWith(resolve(tmpdir())+sep)&&directory.includes('wing-qr-http-'))rmSync(directory,{recursive:true,force:true});
 });
 it('fresh WeChat QR credentials survive redaction, save and the first authenticated provider request',async()=>{
  expect((await fetch(base+'/api/weixin/poll?sessionId=qr-test')).status).toBe(401);
  const qr=await fetch(base+'/api/weixin/qr?bot_type=3',{method:'POST',headers}).then(r=>r.json());
  const response=await fetch(base+'/api/weixin/poll?sessionId='+qr.sessionId,{headers});
  expect(response.headers.get('cache-control')).toBe('no-store');
  const login=await response.json();
  expect(login).toMatchObject({status:'confirmed',botToken:'fresh-qr-token',baseUrl:'https://lane.weixin.qq.com'});
  const saved=await fetch(base+'/api/channels/weixin',{method:'PUT',headers,body:JSON.stringify({enabled:true,credentials:{botToken:login.botToken,baseUrl:login.baseUrl}})}).then(r=>r.json());
  expect(saved.data.channel).toMatchObject({status:'connected',enabled:true});
  expect(post).toHaveBeenCalledTimes(1);
  const disk=JSON.parse(readFileSync(join(directory,'channels.json'),'utf8'));
  expect(disk.weixin.credentials.botToken).toBe('fresh-qr-token');
  const config=await fetch(base+'/api/channels/weixin/config',{headers}).then(r=>r.json());
  expect(config.data.configuredSecrets).toContain('botToken');
  expect(JSON.stringify(config)).not.toContain('fresh-qr-token');
  const listed=await fetch(base+'/api/channels',{headers}).then(r=>r.text());
  expect(listed).not.toContain('fresh-qr-token');
 });
 it('enterprise WeChat QR secret is delivered only by its credential endpoint',async()=>{
  (wechat as any).sessions.set('corp-qr',{createdAt:Date.now(),qrKey:'corp-qr',status:'pending'});
  const response=await fetch(base+'/api/wecom/poll?sessionId=corp-qr',{headers});
  const login=await response.json();expect(login.secret).toBe('fresh-corp-secret');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const saved=await fetch(base+'/api/channels/wechat-work',{method:'PUT',headers,body:JSON.stringify({enabled:true,credentials:{botId:login.botId,secret:login.secret}})}).then(r=>r.json());
  expect(saved.data.channel.status).toBe('connected');
  expect(providers.find(p=>p.type==='wechat-work').config.secret).toBe('fresh-corp-secret');
 });
 it.each([['weixin','botToken'],['wecom','secret']])('protects and preserves %s CLI credentials too',async(variant,field)=>{
  (wechat as any).cliProcesses.set('cli-'+variant,{status:'confirmed',botToken:'cli-wx-token',botId:'cli-corp',secret:'cli-corp-secret',output:[],startedAt:Date.now()});
  expect((await fetch(base+'/api/'+variant+'/cli-status?cliId=cli-'+variant)).status).toBe(401);
  const response=await fetch(base+'/api/'+variant+'/cli-status?cliId=cli-'+variant,{headers});
  const login=await response.json();expect(login[field]).toBe(field==='botToken'?'cli-wx-token':'cli-corp-secret');
  expect(login[field==='botToken'?'secret':'botToken']).toBe('***');
 });
 it('retains legacy base_url compatibility when the upstream omits baseurl',async()=>{
  const local=new WechatService({} as any,{get:async()=>({data:{status:'confirmed',bot_token:'legacy-token',base_url:'https://legacy.weixin.qq.com'}})} as any,{} as any);
  (local as any).sessions.set('legacy',{createdAt:Date.now(),qrKey:'legacy',status:'pending'});
  expect(await local.pollWeixin('legacy')).toMatchObject({baseUrl:'https://legacy.weixin.qq.com'});
 });
});
