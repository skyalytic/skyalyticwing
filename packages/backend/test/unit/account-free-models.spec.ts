import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LlmModule } from '../../src/modules/ai/llm/llm.module.js';
import { LLMClientService } from '../../src/modules/ai/llm/llm-client.service.js';
import { ConfigService } from '../../src/modules/core/config/config.service.js';
import { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import { AuthGuard } from '../../src/modules/core/security/auth.guard.js';

describe('standalone model calls without a Wing account', () => {
  let upstream: Server;
  const requests: Array<{url?: string; authorization?: string; body: any}> = [];
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string;
  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', d => {raw += d;});
      req.on('end', () => {
        requests.push({url:req.url,authorization:req.headers.authorization,body:JSON.parse(raw)});
        res.writeHead(200, {'Content-Type':'text/event-stream'});
        res.end('data: '+JSON.stringify({choices:[{delta:{content:'fixture reply'}}]})+'\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(r => upstream.listen(0,'127.0.0.1',r));
    const address=upstream.address() as {port:number};
    const url=`http://127.0.0.1:${address.port}/v1`;
    const values: Record<string,any> = {
      providers:{custom_fixture:{apiKey:'fixture-user-key',baseUrl:url,models:['custom-test']},ollama:{baseUrl:url,models:['local-test']}},
      general:{defaultModel:'custom_fixture::custom-test'},
      security:{auth:{mode:'token',token:'fixture-local-auth'}},
    };
    const config={get:(k:string)=>values[k]||{},getAll:()=>values,set:(k:string,v:any)=>{values[k]=v;},save:()=>{}};
    const logger={info:jest.fn(),warn:jest.fn(),debug:jest.fn(),error:jest.fn()};
    @Global()
    @Module({providers:[{provide:ConfigService,useValue:config},{provide:LoggerService,useValue:logger},{provide:SecurityManagerService,useValue:{checkUrl:async()=>({safe:true})}}],exports:[ConfigService,LoggerService,SecurityManagerService]})
    class Infrastructure {}
    @Module({imports:[Infrastructure,LlmModule]}) class Fixture {}
    app=await NestFactory.create(Fixture,{logger:false});
    app.setGlobalPrefix('api');
    app.useGlobalGuards(new AuthGuard(config as any));
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    if(upstream)await new Promise<void>((resolve,reject)=>upstream.close(e=>e?reject(e):resolve()));
  });
  it.each(['custom_fixture::custom-test','ollama::local-test'])('actually receives a streamed response for %s without an account service', async model => {
    const result=await app.get(LLMClientService).chatSync({model,messages:[{role:'user',content:'fixture'}]});
    expect(result.content).toBe('fixture reply');
    const request=requests.at(-1)!;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.body.model).toBe(model.split('::')[1]);
    if(model.startsWith('custom_'))expect(request.authorization).toBe('Bearer fixture-user-key');
    else expect(request.authorization).not.toContain('fixture-user-key');
  });
  it('keeps local API authentication and exposes no account endpoints or official provider', async () => {
    expect((await fetch(base+'/api/models')).status).toBe(401);
    const headers={Authorization:'Bearer fixture-local-auth'};
    for(const endpoint of ['/api/official-account','/api/official-account/login','/api/official-account/orders'])
      expect((await fetch(base+endpoint,{headers})).status).toBe(404);
    const response=await fetch(base+'/api/providers',{headers});
    expect(response.status).toBe(200);
    const value=await response.json();
    expect(JSON.stringify(value)).not.toContain('wing-cloud');
    expect(JSON.stringify(value)).not.toContain('官方模型');
  });
});
