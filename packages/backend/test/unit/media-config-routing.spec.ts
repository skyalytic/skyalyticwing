import 'reflect-metadata';
import { MediaService } from '../../src/modules/automation/media.service.js';
import { VideoProviderService, ArkVideoProvider, RunwayVideoProvider } from '../../src/modules/automation/video-provider.service.js';
import { ImageProviderService } from '../../src/modules/automation/image-provider.service.js';
import { ProviderService } from '../../src/modules/ai/llm/provider.service.js';

describe('configured media routing',()=>{
  const logger={info:jest.fn(),warn:jest.fn(),error:jest.fn()} as never;
  function setup() {
    const state:any={providers:{custom_a:{baseProvider:'custom',apiKey:'fixture-a',baseUrl:'https://a.example/v1',videoProtocol:'ark',videoModels:['custom-movie'],imageProtocol:'openai-compatible',imageModels:['custom-picture']},qwen:{apiKey:'fixture-qwen'}},general:{defaultModel:'custom-chat'},automation:{}};
    const config={get:(key:string)=>{if(!(key in state))throw Error('Missing section');return state[key];}} as never;
    const http={post:jest.fn(),get:jest.fn()} as any;
    const images=new ImageProviderService(http,logger), videos=new VideoProviderService(http,logger);
    const media=new MediaService(http,config,logger,{} as never,images,videos);
    return {state,http,media,videos};
  }
  it('keeps the provider directory visible without an account',()=>{
    const service=new ProviderService({get:()=>({})} as never,logger,{} as never,{} as never);
    expect(service.listProviders().providers.some(p=>p.id==='openai')).toBe(true);
  });
  it('keeps the tool directory available on a fresh installation without an automation section',()=>{
    const {state,media}=setup();delete state.automation;
    expect(media.generationCatalog('video').length).toBeGreaterThan(0);
  });
  it('routes custom model IDs through the exact configured endpoint and credential',()=>{
    const {media}=setup();const request={prompt:'fixture',model:'custom_a::custom-movie'};
    const provider=media.resolveVideoProvider(request) as ArkVideoProvider;
    expect(provider.id).toBe('custom_a');expect(provider.baseUrl).toBe('https://a.example/v1');expect(provider.apiKey).toBe('fixture-a');expect(request.model).toBe('custom-movie');
  });
  it('picks the configured video default even when another vendor was registered first',()=>{
    const {state,media}=setup();state.general.defaultVideoModel='custom_a::custom-movie';
    expect(media.resolveVideoProvider({prompt:'fixture'}).id).toBe('custom_a');
  });
  it('refreshes edits and deletions without restarting or falling back to another vendor',()=>{
    const {state,media}=setup();media.resolveVideoProvider({prompt:'fixture',model:'custom-movie'});
    state.providers.custom_a.apiKey='rotated';
    expect((media.resolveVideoProvider({prompt:'fixture',model:'custom-movie'}) as ArkVideoProvider).apiKey).toBe('rotated');
    delete state.providers.custom_a;
    expect(()=>media.resolveVideoProvider({prompt:'fixture',model:'custom-movie'})).toThrow('not configured');
  });
  it('does not advertise unconfigured vendors or pretend arbitrary models are available',()=>{
    const {state,media}=setup();state.providers={};
    expect(media.generationCatalog('video')).toEqual([]);
    expect(()=>media.resolveVideoProvider({prompt:'fixture',model:'invented-video-model'})).toThrow('not configured');
  });
  it('refuses ambiguous duplicate model names across two custom endpoints',()=>{
    const {state,media}=setup();state.providers.custom_b={...state.providers.custom_a};
    expect(()=>media.resolveVideoProvider({prompt:'fixture',model:'custom-movie'})).toThrow('Multiple');
  });
  it('keeps image generation on the custom image route',async()=>{
    const {state,media,http}=setup();state.general.defaultImageModel='custom_a::custom-picture';http.post.mockResolvedValue({status:200,data:{data:[{url:'https://a.example/p.png'}]}});
    await media.generateImage({prompt:'fixture'});
    expect(http.post.mock.calls[0][0]).toBe('https://a.example/v1/images/generations');
    expect(http.post.mock.calls[0][1].model).toBe('custom-picture');
  });
  it('uses native registry media endpoints but preserves a user proxy after edits',async()=>{
    const {state,media,http}=setup(); state.providers={google:{apiKey:'fixture-google',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai'}};
    http.post.mockResolvedValue({status:200,data:{candidates:[{content:{parts:[{inlineData:{data:'aGVsbG8=',mimeType:'image/png'}}]}}]}});
    await media.generateImage({prompt:'fixture',model:'gemini-nano-banana-2.1'});
    expect(http.post.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1/models/gemini-nano-banana-2.1:generateContent');
    expect(media.listImageModels('google')).toContain('gemini-3.1-flash-image');
    state.providers.google.baseUrl='https://proxy.example/native';
    await media.generateImage({prompt:'fixture',model:'gemini-nano-banana-2.1'});
    expect(http.post.mock.calls[1][0]).toBe('https://proxy.example/native/models/gemini-nano-banana-2.1:generateContent');
  });
  it('submits configured image and video models without a Wing account',async()=>{
    const {state,media,http,videos}=setup();
    state.general.defaultImageModel='custom_a::custom-picture';state.general.defaultVideoModel='custom_a::custom-movie';
    http.post.mockResolvedValue({status:200,data:{data:[{url:'https://a.example/p.png'}]}});
    await media.generateImage({prompt:'fixture'});
    expect(http.post.mock.calls[0][0]).toBe('https://a.example/v1/images/generations');
    const submit=jest.spyOn(videos,'generateVideo').mockResolvedValue({} as never);
    await media.generateVideo({prompt:'fixture'});
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({provider:'custom_a',model:'custom-movie'}));
  });
  it('does not reroute a queued job when defaults or the preferred selection change',()=>{
    const {state,media}=setup();
    const request={prompt:'fixture',model:'custom_a::custom-movie',preferredModel:'wan2.7-t2v'};
    expect(media.resolveVideoProvider(request).id).toBe('custom_a');
    state.general.defaultVideoModel='dashscope::wan2.7-t2v';
    expect(media.resolveVideoProvider(request).id).toBe('custom_a');
    expect(request.model).toBe('custom-movie');
  });
  it('polls Ark through the documented task endpoint',async()=>{
    const {http}=setup();http.get.mockResolvedValue({status:200,data:{status:'succeeded',content:{video_url:'https://a.example/video.mp4'}}});
    const p=new ArkVideoProvider({apiKey:'fixture',baseUrl:'https://a.example/v3'},http);
    expect((await p.query('task-1',{prompt:'fixture'})).status).toBe('SUCCEEDED');expect(http.get.mock.calls[0][0]).toBe('https://a.example/v3/contents/generations/tasks/task-1');
  });
  it('persists Runway submission IDs and reads output without submitting twice',async()=>{
    const {http}=setup();http.post.mockResolvedValue({status:200,data:{id:'task-1'}});http.get.mockResolvedValue({status:200,data:{status:'SUCCEEDED',output:['https://a.example/video.mp4']}});
    const p=new RunwayVideoProvider({apiKey:'fixture',model:'gen4.5'},http);
    const id=await p.submit({prompt:'fixture'});const result=await p.query(id,{prompt:'fixture'});
    expect(http.post).toHaveBeenCalledTimes(1);expect(result.result?.videos[0]?.url).toContain('video.mp4');
  });
});
