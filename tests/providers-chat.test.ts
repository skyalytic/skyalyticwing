import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { z } from 'zod';
import * as providers from '../packages/providers/src/index';
import { signBedrock } from '../packages/providers/src/bedrock-chat';
import { sparkChat } from '../packages/providers/src/spark-chat';
import { sse } from '../packages/providers/src/http-chat';
import type { ChatChunk, ChatParams } from '../packages/providers/src/types';

const params: ChatParams = {model:'test-model', messages:[{role:'user',content:'你好'}]};
async function collect(stream: AsyncGenerator<ChatChunk>) { const result: ChatChunk[] = []; for await (const c of stream) result.push(c); return result; }
function stream(...events: unknown[]) { return new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\r\n\r\n').join(''), {headers:{'Content-Type':'text/event-stream'}}); }
const answer = () => stream({choices:[{delta:{content:'你好'},finish_reason:'stop'}]}, '[DONE]');
afterEach(()=>vi.unstubAllGlobals());

describe('public provider implementations', () => {
  it.each(['line', 'multiline'])('bounds oversized SSE %s and releases the reader', async mode => {
    const cancel = vi.fn();
    const part = 'x'.repeat(1024 * 1024);
    const body = mode === 'line' ? `data: ${part.repeat(5)}\n\n` : Array.from({length: 5}, () => `data: ${part}\n`).join('') + '\n';
    const response = new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode(body)); }, cancel}));
    await expect((async () => { for await (const event of sse(response)) void event; })()).rejects.toThrow('frame too large');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });
  it.each(['answer', 'error', 'truncated', 'cancel'])('handles Spark WebSocket %s with signed authentication and cleanup', async mode=>{
    let socket!: FixtureSocket;
    class FixtureSocket extends EventTarget {
      closed = false;
      constructor(public url: URL) { super(); socket=this; queueMicrotask(()=>this.dispatchEvent(new Event('open'))); }
      send(body: string) {
        expect(JSON.parse(body).header.app_id).toBe('app');
        const packet = mode === 'error' ? {header:{code:10001}} : {header:{code:0},payload:{choices:{status:2,text:[{content:'中文'}]}}};
        if(mode==='cancel') return;
        queueMicrotask(()=>this.dispatchEvent(mode==='truncated' ? new Event('close') : new MessageEvent('message',{data:JSON.stringify(packet)})));
      }
      close() { this.closed=true; }
    }
    vi.stubGlobal('WebSocket',FixtureSocket);
    const abort=new AbortController();
    const run=collect(sparkChat({...params,signal:abort.signal},{url:'wss://spark-api.xf-yun.com/v4.0/chat',appId:'app',apiKey:'key',apiSecret:'secret',domain:'4.0Ultra'}));
    if(mode==='cancel') abort.abort();
    if(mode==='answer') expect(await run).toEqual([{type:'content',content:'中文'},{type:'done'}]);
    else await expect(run).rejects.toThrow();
    expect(socket.closed).toBe(true);
    expect(Buffer.from(socket.url.searchParams.get('authorization')!,'base64').toString()).toContain('algorithm="hmac-sha256"');
  });
  it.each(['https://[::ffff:a00:1]', 'https://[fe90::1]', 'https://[febf::1]', 'https://[::]', 'https://user:secret@example.com'])('rejects sensitive endpoint %s',url=>{
    expect(()=>new providers.OpenAIProvider().configure({apiKey:'fixture',apiBase:url})).toThrow();
  });
  const compatible = [providers.OpenAIProvider, providers.DeepSeekProvider, providers.QwenProvider, providers.KimiProvider, providers.ZhipuProvider, providers.XAIProvider, providers.MistralProvider, providers.MinimaxProvider, providers.VolcengineProvider, providers.OllamaProvider, providers.GoogleProvider, providers.AzureProvider, providers.WenxinProvider, providers.SparkProvider];
  it.each(compatible)('sends authenticated requests and returns actual content: %s', async Provider => {
    const fetcher = vi.fn(async()=>answer()); vi.stubGlobal('fetch', fetcher);
    const provider = new Provider();
    provider.configure({apiKey:'fixture-key', apiPassword:'fixture-password', endpoint:'https://fixture.openai.azure.com', deploymentName:'deployment', endpointId:'endpoint'});
    expect(await collect(provider.chat(params))).toEqual([{type:'content',content:'你好'},{type:'done'}]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string,string>;
    expect(headers.Authorization || headers['api-key']).toBeTruthy();
    if(provider.id==='azure') {expect(url).toContain('/deployments/deployment/');expect(headers.Authorization).toBeUndefined();}
    if(provider.id==='google')expect(url).toContain('generativelanguage.googleapis.com/v1beta/openai');
    if(provider.id==='wenxin')expect(url).toContain('qianfan.baidubce.com/v2');
  });
  it('accumulates interleaved tool arguments and converts Zod to JSON schema', async()=>{
    const fetcher=vi.fn(async()=>stream(
      {choices:[{delta:{tool_calls:[{index:1,id:'b',function:{name:'lookup',arguments:'{"id":'}},{index:0,id:'a',function:{name:'lookup',arguments:'{"id":1}'}}]}}]},
      {choices:[{delta:{tool_calls:[{index:1,function:{arguments:'2}'}}]},finish_reason:'tool_calls'}]}, '[DONE]'));
    vi.stubGlobal('fetch',fetcher);const provider=new providers.OpenAIProvider();provider.configure({apiKey:'fixture'});
    const output=await collect(provider.chat({...params,tools:[{name:'lookup',description:'read',parameters:z.object({id:z.number()})}]}));
    expect(output).toEqual([{type:'tool_call',toolCall:{id:'a',name:'lookup',input:{id:1}}},{type:'tool_call',toolCall:{id:'b',name:'lookup',input:{id:2}}},{type:'done'}]);
    const body=JSON.parse((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body as string);
    expect(body.tools[0].function.parameters.properties.id.type).toBe('number');
  });
  it.each([
    ()=>new Response('secret server response',{status:401}),
    ()=>stream({choices:[{delta:{content:'partial'}}]}),
    ()=>stream({error:{message:'secret'}}),
    ()=>stream({choices:[{delta:{},finish_reason:'length'}]}),
    ()=>stream({choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'bad',arguments:'broken'}}]},finish_reason:'tool_calls'}]},'[DONE]'),
  ])('rejects failed or incomplete replies without pretending success',async response=>{
    vi.stubGlobal('fetch',vi.fn(async()=>response()));const p=new providers.OpenAIProvider();p.configure({apiKey:'fixture'});
    await expect(collect(p.chat(params))).rejects.toThrow();
  });
  it('preserves tool results and propagates caller cancellation', async()=>{
    const controller=new AbortController();controller.abort();
    const fetcher=vi.fn(async(_url,init)=>{expect(init.signal.aborted).toBe(true);init.signal.throwIfAborted();return answer();});vi.stubGlobal('fetch',fetcher);
    const p=new providers.OpenAIProvider();p.configure({apiKey:'fixture'});
    await expect(collect(p.chat({...params,signal:controller.signal,messages:[{role:'tool',toolCallId:'call1',content:'result'}]}))).rejects.toThrow();
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[0].tool_call_id).toBe('call1');
  });
  it('handles Anthropic system, images, tool results and streamed tool calls',async()=>{
    const fetcher=vi.fn(async()=>stream(
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'a',name:'lookup',input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"id":1}'}},
      {type:'message_delta',delta:{stop_reason:'tool_use'}},{type:'message_stop'}));vi.stubGlobal('fetch',fetcher);
    const p=new providers.AnthropicProvider();p.configure({apiKey:'fixture'});
    const result=await collect(p.chat({...params,messages:[{role:'system',content:'rules'},{role:'assistant',content:'',toolCalls:[{id:'old',name:'lookup',input:{}}]},{role:'tool',content:'ok',toolCallId:'old'},{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}]}));
    expect(result[0]).toEqual({type:'tool_call',toolCall:{id:'a',name:'lookup',input:{id:1}}});
    const request=(fetcher.mock.calls[0] as unknown as [string,RequestInit])[1],body=JSON.parse(request.body as string);
    expect(body.system).toBe('rules');expect(body.messages[1].content[0].type).toBe('tool_result');
    expect(body.messages[1].content[1].source.type).toBe('base64');
  });
  it('uses Bedrock Converse with credentials, session token, tools and accurate capability metadata',async()=>{
    const fetcher=vi.fn(async()=>Response.json({stopReason:'tool_use',output:{message:{content:[{toolUse:{toolUseId:'a',name:'lookup',input:{id:3}}}]}}}));vi.stubGlobal('fetch',fetcher);
    const p=new providers.BedrockProvider();p.configure({accessKeyId:'fixture',secretAccessKey:'fixture-secret',sessionToken:'fixture-session',awsRegion:'us-east-1'});
    const result=await collect(p.chat({...params,model:'anthropic.model:0'}));expect(result[0].type).toBe('tool_call');
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toContain('/model/anthropic.model%3A0/converse');
    expect((init.headers as Record<string,string>).Authorization).toContain('AWS4-HMAC-SHA256');
    expect((init.headers as Record<string,string>)['x-amz-security-token']).toBe('fixture-session');
    expect(p.listModels()[0].supportsStreaming).toBe(false);
    const config={region:'us-east-1',accessKeyId:'key',secretAccessKey:'secret',sessionToken:'',apiKey:''};
    expect(signBedrock(new URL(url),'{}',config,new Date('2026-01-01T00:00:00Z'))).toEqual(signBedrock(new URL(url),'{}',config,new Date('2026-01-01T00:00:00Z')));
  });
  it('does not mistake legacy Baidu keys for a modern Bearer key',()=>{
    expect(()=>new providers.WenxinProvider().configure({apiKey:'legacy',secretKey:'legacy-secret'})).toThrow('Qianfan v2');
  });
  it('speaks to a real local OpenAI-compatible HTTP endpoint with fragmented UTF-8 SSE',async()=>{
    const bytes=Buffer.from('data: {"choices":[{"delta":{"content":"中文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const server=createServer((req,res)=>{expect(req.url).toBe('/v1/chat/completions');req.resume();res.setHeader('Content-Type','text/event-stream');res.write(bytes.subarray(0,55));res.end(bytes.subarray(55));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {const address=server.address() as {port:number};const p=new providers.OllamaProvider();p.configure({baseUrl:`http://127.0.0.1:${address.port}`});expect(await collect(p.chat(params))).toEqual([{type:'content',content:'中文'},{type:'done'}]);}
    finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
});
