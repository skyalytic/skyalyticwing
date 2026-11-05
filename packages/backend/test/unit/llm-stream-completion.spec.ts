import { OpenAIAdapter } from '../../src/modules/ai/llm/openai-adapter';
import { AnthropicAdapter } from '../../src/modules/ai/llm/anthropic-adapter';
import { parseSse } from '../../src/modules/ai/llm/stream-parser';

describe('model transport completion contract',()=>{
  const fetcher=global.fetch;
  const params={model:'test',messages:[{role:'user' as const,content:'hello'}]};
  const config={id:'test',apiKey:'fixture',baseUrl:'https://example.com/v1',type:'openai' as const,models:[]};
  afterEach(()=>{global.fetch=fetcher;});
  const response=(text:string)=>new Response(text,{headers:{'Content-Type':'text/event-stream'}});
  async function collect(iterator:AsyncIterable<unknown>){const out=[];for await(const x of iterator)out.push(x);return out;}
  it('does not mark a truncated OpenAI stream as done or dispatch partial tools',async()=>{
    global.fetch=jest.fn(async()=>response('data: {"choices":[{"delta":{"content":"partial","tool_calls":[{"index":0,"id":"a","function":{"name":"write","arguments":"{"}}]}}]}\n\n')) as typeof fetch;
    const out=await collect(new OpenAIAdapter().chat(params,config));
    expect(out).toEqual([{type:'content',content:'partial'},{type:'error',error:expect.stringContaining('中断')}]);
  });
  it.each(['event: error\ndata: {"error":{"message":"failure"}}\n\n','event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"partial"}}\n\n'])('rejects Anthropic error or incomplete stream',async text=>{
    global.fetch=jest.fn(async()=>response(text)) as typeof fetch;
    const out=await collect(new AnthropicAdapter().chat(params,{...config,type:'anthropic'}));
    expect(out.at(-1)).toMatchObject({type:'error'});expect(out).not.toContainEqual({type:'done'});
  });
  it('accepts a completed Anthropic stream and blocks credential redirects',async()=>{
    global.fetch=jest.fn(async()=>response('event: message_stop\ndata: {"type":"message_stop"}\n\n')) as typeof fetch;
    expect(await collect(new AnthropicAdapter().chat(params,{...config,type:'anthropic'}))).toEqual([{type:'done'}]);
    expect(global.fetch).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({redirect:'error'}));
  });
  it.each(['length','tool_calls'])('does not dispatch truncated or malformed tools even with a completion marker (%s)',async reason=>{
    global.fetch=jest.fn(async()=>response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'write',arguments:reason==='length'?'{}':'{'}}]},finish_reason:reason}]})+'\n\ndata: [DONE]\n\n')) as typeof fetch;
    const out=await collect(new OpenAIAdapter().chat(params,config));
    expect(out).toEqual([{type:'error',error:expect.any(String)}]);
  });
  it('cancels the response body on early completion',async()=>{
    const cancel=jest.fn();
    const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: done\n\n'));},cancel});
    for await(const _event of parseSse(body)) break;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects an unbounded stream line',async()=>{
    const body=response('data: '+ 'x'.repeat(4*1024*1024+1)).body!;
    await expect(collect(parseSse(body))).rejects.toThrow('4 MiB');
  });
  it('allows active generation beyond 30 seconds while retaining an idle timeout',async()=>{
    jest.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let signal!: AbortSignal;
      global.fetch=jest.fn(async(_url,options)=>{
        signal=options!.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({start(c){streamController=c;}}));
      }) as typeof fetch;
      const iterator=new OpenAIAdapter().chat(params,config);
      const first=iterator.next();await Promise.resolve();
      await jest.advanceTimersByTimeAsync(20000);
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      expect((await first).value).toEqual({type:'content',content:'a'});
      const second=iterator.next();
      await jest.advanceTimersByTimeAsync(20000);
      expect(signal.aborted).toBe(false);
      streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));streamController.close();
      expect((await second).value).toEqual({type:'done'});
      await iterator.next();
    } finally { jest.useRealTimers(); }
  });
});
