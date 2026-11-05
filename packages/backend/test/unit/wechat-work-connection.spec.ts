import 'reflect-metadata';
jest.mock('../../src/modules/channels/channel-network.js',()=>({channelWebSocketAgent:jest.fn(()=>({proxy:true})),channelDispatcher:jest.fn()}));
jest.mock('ws',()=>{
 const {EventEmitter}=jest.requireActual<typeof import('node:events')>('node:events');
 class Socket extends EventEmitter {
  static OPEN=1;static instances:any[]=[];readyState=0;options:any;sent:any[]=[];
  constructor(_url:string,options:any){super();this.options=options;Socket.instances.push(this);}
  send(s:string){this.sent.push(JSON.parse(s));}
  close(){this.readyState=3;this.emit('close',1000,Buffer.alloc(0));}
  terminate(){this.close();}
 }
 return {WebSocket:Socket};
});
import {WebSocket} from 'ws';
import {WeChatWorkProvider} from '../../src/modules/channels/providers/wechat-work.service.js';
const sockets=()=> (WebSocket as unknown as {instances:any[]}).instances;
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
const authenticate=(s:any,error=0)=>{s.readyState=1;s.emit('open');const req=s.sent.find((m:any)=>m.cmd==='aibot_subscribe');s.emit('message',JSON.stringify({headers:req.headers,body:{errcode:error,errmsg:'bad credentials'}}));};
describe('WeCom connection recovery',()=>{
 let provider:WeChatWorkProvider;
 beforeEach(()=>{jest.useFakeTimers();sockets().length=0;provider=new WeChatWorkProvider({info:jest.fn(),warn:jest.fn(),error:jest.fn()} as any,{} as any);});
 afterEach(async()=>{await provider.disconnect();jest.clearAllTimers();jest.useRealTimers();});
 it('uses a proxy agent and retries initial and repeated network failures until subscribed',async()=>{
  const pending=provider.connect({botId:'fixturebot',secret:'fixture'});await flush();
  expect(sockets()[0].options.agent).toEqual({proxy:true});sockets()[0].emit('error',new Error('TLS reset'));
  expect((await pending).success).toBe(false);await jest.advanceTimersByTimeAsync(2000);
  expect(sockets()).toHaveLength(2);sockets()[1].emit('error',new Error('TLS reset'));await flush();
  await jest.advanceTimersByTimeAsync(5000);expect(sockets()).toHaveLength(3);authenticate(sockets()[2]);await flush();
  expect((await provider.sendMessage('fixture','hello')).success).toBe(true);
 });
 it('does not reconnect on authentication rejection',async()=>{
  const pending=provider.connect({botId:'fixturebot',secret:'wrong'});await flush();authenticate(sockets()[0],40001);
  expect((await pending).success).toBe(false);await jest.advanceTimersByTimeAsync(65000);expect(sockets()).toHaveLength(1);
 });
 it('settles a cancelled connection and stops pending retries without sending messages',async()=>{
  const pending=provider.connect({botId:'fixturebot',secret:'fixture'});await flush();await provider.disconnect();
  expect((await pending).success).toBe(false);await jest.advanceTimersByTimeAsync(65000);
  expect(sockets()).toHaveLength(1);expect((await provider.sendMessage('fixture','hello')).success).toBe(false);
 });
});
