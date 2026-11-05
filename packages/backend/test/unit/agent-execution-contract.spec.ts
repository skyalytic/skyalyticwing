import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry.js';
import 'reflect-metadata';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service.js';

describe('agent execution contracts', () => {
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  function create(chatSync: jest.Mock) {
    const session = { addMessage: jest.fn(), flush: jest.fn().mockResolvedValue(undefined) };
    const llm = {
      getDefaultModel: () => 'test',
      getDefaultProviderId: () => 'test',
      getMaxContextTokens: () => 10000,
      usesOfficialContext: (model:string) => model.startsWith('wing/'),
      chatSync,
    };
    const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const service = new (AgentLoopService as any)(
      llm,
      {},
      { validateString: jest.fn() },
      logger,
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      session,
    ) as AgentLoopService;
    jest.spyOn(service as any, 'buildContext').mockResolvedValue([]);
    jest.spyOn(service as any, 'getToolDefinitions').mockImplementation((agentId: unknown) =>
      (agentId === 'expert' ? ['calendar_read'] : ['file-read', 'file-write', 'builtin_browser']).map(name => ({name, description: 'fixture', parameters: {type: 'object', properties: {}}})));
    jest.spyOn(service as any, 'emitHook').mockImplementation(() => undefined);
    jest.spyOn(service as any, 'checkToolGate').mockReturnValue({ action: 'pass' });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue({ success: true, output: 'ok' });
    return { service, session, llm };
  }
  const first = {
    content: '',
    toolCalls: [{ id: 'call', name: 'file-read', arguments: '{}' }],
    usage,
  };

  it('sends an explicit capability notice when all tools are uninstalled', async () => {
    const {service,llm}=create(jest.fn().mockResolvedValue({content:'需要先安装文件工具',usage}));
    jest.spyOn(service as any,'getToolDefinitions').mockReturnValue(undefined);
    for await(const _event of service.run('empty-tools','帮我创建游戏')) {}
    const request=llm.chatSync.mock.calls[0][0];
    expect(request.tools?.length || 0).toBe(0);
    expect(request.messages.some((m:any)=>m.role==='system' && m.content.includes('本轮没有可调用的操作工具'))).toBe(true);
    expect((service as any).executeTool).not.toHaveBeenCalled();
  });

  it('streams commentary before tool execution and reuses IDs in durable history', async () => {
    const {service, session, llm} = create(jest.fn());
    let iteration = 0;
    const stream = jest.fn().mockImplementation(async function* () {
      iteration++;
      yield {type: 'content', content: iteration === 1 ? '先读取文件' : '读取完成'};
      if (iteration === 1) yield {type: 'tool_call', toolCall: {id: 'read-live', name: 'file-read', arguments: '{}'}};
      yield {type: 'done', usage};
    });
    Object.assign(llm, {chat: stream});
    const events: any[] = [];
    for await (const event of service.run('live-session', 'hello', {stream: true, turnId: 'turn-live'})) events.push(event);
    expect(llm.chatSync).not.toHaveBeenCalled();
    expect(stream.mock.calls[0][0].stream).toBe(true);
    const progress = events.find(e => e.type === 'assistant_message' && e.message.phase === 'progress');
    const delta = events.find(e => e.type === 'assistant_delta');
    expect(delta.message.id).toBe(progress.message.id);
    expect(events.indexOf(delta)).toBeLessThan(events.findIndex(e => e.type === 'tool_call'));
    const saved = session.addMessage.mock.calls.map(c => c[1]);
    expect(saved.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['先读取文件', '读取完成']);
    expect(saved.every(m => m.turnId === 'turn-live')).toBe(true);
    expect(saved.map(m => m.turnSequence)).toEqual([...saved.map(m => m.turnSequence)].sort((a,b) => a-b));
    expect(events.at(-1).type).toBe('done');
  });

  it('persists cancelled partial text and a turn-owned status without feeding the status to the model', async () => {
    const {service, session, llm} = create(jest.fn());
    Object.assign(llm, {chat: async function* () {
      yield {type: 'content', content: '执行中的文字'};
      ChatControlRegistry.requestAbort('partial-cancel');
      throw new Error('Request cancelled');
    }});
    for await (const _ of service.run('partial-cancel', 'hello', {stream: true, turnId: 'turn-cancel'})) { /* drain */ }
    const saved = session.addMessage.mock.calls.map(c => c[1]);
    expect(saved.find(m => m.phase === 'status')).toMatchObject({id: 'turn-cancel:status', content: '已停止', turnStatus: 'cancelled'});
    expect(saved.find(m => m.role === 'assistant')).toMatchObject({content: '执行中的文字', streaming: false});
    (service as any).buildContext.mockRestore();
    jest.spyOn(service as any, 'buildWorkspaceNotice').mockReturnValue('fixture');
    Object.assign(session, {getMessages: () => saved});
    const context = await (service as any).buildContext('partial-cancel');
    expect(context.some((m: any) => m.content === '已停止')).toBe(false);
  });

  it('cancels an in-flight model request only for the selected session and releases its lock', async () => {
    const pending: Array<{signal: AbortSignal; finish: (value: unknown) => void}> = [];
    const call = jest.fn().mockImplementation((params) => new Promise((resolve, reject) => {
      pending.push({signal: params.signal, finish: resolve});
      params.signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
    }));
    const {service} = create(call);
    const collect = async (id: string) => {const events = []; for await (const e of service.run(id, 'hello')) events.push(e); return events;};
    const a = collect('cancel-a');
    const b = collect('cancel-b');
    while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
    expect(service.isSessionRunning('cancel-a')).toBe(true);
    ChatControlRegistry.requestAbort('cancel-a');
    await a;
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);
    expect(service.isSessionRunning('cancel-a')).toBe(false);
    expect(service.isSessionRunning('cancel-b')).toBe(true);
    pending[1].finish({content: 'done', usage});
    await b;
    call.mockResolvedValue({content: 'again', usage});
    const resumed = await collect('cancel-a');
    expect(resumed.some(e => e.type === 'assistant_message')).toBe(true);
  });

  it('delivers a webpage annotation attachment to the model while retaining a clean user message', async () => {
    const context = '网址：https://example.com/\npageId: p1\n选择器：#buy\nHTML: <button id="buy">立即购买</button>';
    const attachment = {type:'file' as const,name:'网页批注 · 立即购买',mimeType:'text/x-wing-browser-annotation',url:`data:text/x-wing-browser-annotation;base64,${Buffer.from(context).toString('base64')}`};
    const call = jest.fn().mockResolvedValue({ content: 'done', usage });
    const { service, session } = create(call);
    (service as any).buildContext.mockRestore();
    jest.spyOn(service as any, 'buildWorkspaceNotice').mockReturnValue('测试工作区');
    Object.assign(session, {getMessages: () => session.addMessage.mock.calls.map((entry) => entry[1])});
    for await (const _event of service.run('s', '把它改成蓝色', {attachments:[attachment]})) { /* drain */ }
    const sent = JSON.stringify(call.mock.calls[0][0]);
    expect(sent).toContain('#buy');
    expect(sent).toContain('https://example.com/');
    expect(sent).toContain('把它改成蓝色');
    expect(JSON.stringify(session.addMessage.mock.calls)).toContain('网页批注 · 立即购买');
  });


  it('delivers selection text and direct-answer guidance without requiring a tool call', async () => {
    const ref = {version:1,kind:'selection',label:'日志.txt 3–6',path:'E:/日志.txt',startLine:3,endLine:6,content:'未保存的选区内容'};
    const attachment = {type:'file' as const,name:ref.label,mimeType:'text/x-wing-context-reference',url:`data:text/x-wing-context-reference;base64,${Buffer.from(JSON.stringify(ref)).toString('base64')}`};
    const call = jest.fn().mockResolvedValue({content:'这是选区的说明',usage});
    const {service,session} = create(call);
    (service as any).buildContext.mockRestore();
    jest.spyOn(service as any,'buildWorkspaceNotice').mockReturnValue('测试工作区');
    Object.assign(session,{getMessages:()=>session.addMessage.mock.calls.map(entry=>entry[1])});
    for await (const _event of service.run('s','这些写了什么',{attachments:[attachment]})) { /* drain */ }
    const sent = JSON.stringify(call.mock.calls[0][0]);
    expect(sent).toContain('未保存的选区内容');
    expect(sent).toContain('选区行号：3–6');
    expect(sent).toContain('不为了查看同一内容再次调用 file-read');
    expect((service as any).executeTool).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('inherits the default model when an expert model is blank', async () => {
    const call = jest.fn().mockResolvedValue({ content: 'done', usage });
    const { service } = create(call);
    jest.spyOn(service as any, 'tryGetAgent').mockReturnValue({ model: '', tools: [], systemPrompt: '' });
    for await (const _event of service.run('s', 'goal', { agentId: 'expert', model: ' ' })) { /* drain */ }
    expect(call.mock.calls[0][0].model).toBe('test');
  });

  it('blocks an invented tool outside the single expert allowlist at execution time', async () => {
    const { service } = create(jest.fn().mockResolvedValueOnce(first).mockResolvedValue({ content: 'done', usage }));
    jest.spyOn(service as any, 'tryGetAgent').mockReturnValue({ model: 'test', tools: ['calendar_read'], systemPrompt: '' });
    const events = [];
    for await (const event of service.run('s', 'goal', { agentId: 'expert' })) events.push(event);
    expect((service as any).executeTool).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ blocked: true }) }));
  });

  it('aggregates every model iteration and flushes tool results before publishing', async () => {
    const { service, session } = create(
      jest.fn().mockResolvedValueOnce(first).mockResolvedValue({ content: 'done', usage }),
    );
    const events = [];
    for await (const event of service.run('s', 'goal')) {
      if (event.type === 'tool_result')
        expect(session.addMessage).toHaveBeenCalledWith(
          's',
          expect.objectContaining({ role: 'tool', toolCallId: 'call' }),
        );
      events.push(event);
    }
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    });
    expect(session.flush).toHaveBeenCalled();
  });

  it.each(['gpt-4o','deepseek-chat'])('browser screenshot reaches only a vision model (%s), after all tool results, without persistence',async(model)=>{
    const captured:any[]=[];
    const call=jest.fn().mockImplementation(async(params)=>{captured.push(structuredClone(params));return captured.length===1?{content:'',toolCalls:[{id:'browser',name:'builtin_browser',arguments:'{"action":"snapshot"}'},{id:'other',name:'file-read',arguments:'{}'}],usage}:{content:'done',usage};});
    const {service,session,llm}=create(call);
    (llm as any).resolveProviderForModel=()=>({id:model==='gpt-4o'?'openai':'deepseek',model});
    (service as any).executeTool.mockImplementation(async(name:string)=>name==='builtin_browser'?{success:true,output:'page text',data:{browserScreenshot:'c2NyZWVuc2hvdA=='}}:{success:true,output:'file text'});
    const events=[];for await(const event of service.run('vision-test','observe',{model}))events.push(event);
    const messages=captured[1].messages;
    expect(messages.map((m:any)=>m.role)).toEqual(['system','assistant','tool','tool','user']);
    expect(messages[0].content).toContain('本轮可调用工具');
    const observation=messages.at(-1).content;
    if(model==='gpt-4o')expect(observation[1]).toMatchObject({type:'image_url',image_url:{url:'data:image/jpeg;base64,c2NyZWVuc2hvdA=='}});
    else expect(observation).toContain('未声明视觉能力');
    expect(JSON.stringify(session.addMessage.mock.calls)).not.toContain('c2NyZWVuc2hvdA==');
    expect(JSON.stringify(events)).not.toContain('c2NyZWVuc2hvdA==');
  });

  it('stops at a token budget boundary without making the next model call', async () => {
    const call = jest.fn().mockResolvedValue(first);
    const { service } = create(call);
    const events = [];
    for await (const event of service.run('s', 'goal', { maxTotalTokens: 15 })) events.push(event);
    expect(call).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: expect.stringContaining('budget'),
    });
  });

  it('rejects concurrent runs before mutating the same conversation', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((r) => {
      release = r;
    });
    const { service, session } = create(jest.fn().mockReturnValue(pending));
    const firstRun = service.run('same', 'one');
    const start = firstRun.next();
    const second = service.run('same', 'two');
    expect((await second.next()).value).toMatchObject({ type: 'error' });
    expect(session.addMessage).toHaveBeenCalledTimes(1);
    release({ content: 'done', usage });
    await start;
    await firstRun.return(undefined);
    const third = service.run('same', 'three');
    expect((await third.next()).value).toMatchObject({ type: 'assistant_message' });
    await third.return(undefined);
  });

  it('continues ordinary progressing work beyond both former round ceilings', async () => {
    let round = 0;
    const call = jest.fn().mockImplementation(async () => ++round <= 501
      ? {content:'',toolCalls:[{id:`c${round}`,name:'file-read',arguments:JSON.stringify({path:`file${round}`})}],usage}
      : {content:'完成',usage});
    const {service} = create(call);
    const events = [];
    for await (const event of service.run('long-running','查看全部资料')) events.push(event);
    expect(call).toHaveBeenCalledTimes(502);
    expect(events.some(e=>e.type==='error')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('honors explicit round budgets and preserves an honest continuation message', async () => {
    const {service,session} = create(jest.fn().mockResolvedValue(first));
    const events = [];
    for await (const event of service.run('budget','查看资料',{maxIterations:2})) events.push(event);
    expect(events.at(-1)).toMatchObject({type:'error',error:expect.stringContaining('执行上限（2）')});
    expect(session.addMessage).toHaveBeenCalledWith('budget',expect.objectContaining({role:'assistant',content:expect.stringContaining('任务尚未完成')}));
    expect(events.some(e=>e.type==='done')).toBe(false);
  });

  it('still stops a repeated-call loop instead of spending indefinitely', async () => {
    const call = jest.fn().mockResolvedValue(first);
    const {service} = create(call);
    const events = [];
    for await (const event of service.run('stuck','查看资料')) events.push(event);
    expect(call).toHaveBeenCalledTimes(10);
    expect(events.at(-1)).toMatchObject({type:'error',error:expect.stringContaining('Doom loop detected')});
  });

  it('does not retry an identical oversized request when no history can be reduced', async () => {
    const call = jest.fn().mockRejectedValue(new Error('context_length_exceeded'));
    const {service} = create(call);
    const events = [];
    for await (const event of service.run('overflow','查看资料')) events.push(event);
    expect(call).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({type:'error',error:expect.stringContaining('无法通过压缩历史继续')});
  });

  it('uses the model checkpoint while preserving explicit user preferences from earlier history', async () => {
    const call = jest.fn().mockResolvedValue({content:'done',usage});
    const {service,session} = create(call);
    (service as any).buildContext.mockRestore();
    jest.spyOn(service as any,'buildWorkspaceNotice').mockReturnValue('工作区');
    Object.assign(session,{
      getMessages:jest.fn(()=>[{role:'user',content:'FULL OLD HISTORY；不要用视频模型'}]),
      getContextMessages:()=>[{role:'user',contextSummary:true,content:'SAVED CHECKPOINT'}],
    });
    (service as any).getToolDefinitions.mockReturnValue([
      {name:'generate_video',description:'model',parameters:{type:'object',properties:{}}},
      {name:'render_code_video',description:'code',parameters:{type:'object',properties:{}}},
    ]);
    for await(const _event of service.run('checkpoint','继续')) { /* drain */ }
    expect(JSON.stringify(call.mock.calls[0][0].messages)).toContain('SAVED CHECKPOINT');
    expect(JSON.stringify(call.mock.calls[0][0].messages)).not.toContain('FULL OLD HISTORY');
    expect(call.mock.calls[0][0].tools.map((tool:any)=>tool.name)).not.toContain('generate_video');
    expect(call.mock.calls[0][0].tools.map((tool:any)=>tool.name)).toContain('render_code_video');
  });

  it('loads saved memory as reference data without rewriting stored user messages', async () => {
    const call=jest.fn().mockResolvedValue({content:'answer',usage});
    const {service,session}=create(call);
    (service as any).buildContext.mockRestore();
    jest.spyOn(service as any,'buildWorkspaceNotice').mockReturnValue('workspace');
    (service as any).memory={getContextForPrompt:()=> '旧偏好：长篇回复'};
    (service as any).agentService={getMemory:()=>({facts:['已保存的事实']})};
    Object.assign(session,{getMessages:()=>session.addMessage.mock.calls.map(entry=>entry[1])});
    for await(const _event of service.run('memory','这次只说一句')) { /* drain */ }
    const messages=call.mock.calls[0][0].messages;
    expect(messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('')).not.toContain('旧偏好');
    expect(messages.at(-1).content).toContain('冲突时以当前要求为准');
    expect(messages.at(-1).content).toContain('已保存的事实');
    expect(messages.at(-1).content).toMatch(/这次只说一句$/);
    expect(session.addMessage.mock.calls.find(entry=>entry[1].role==='user')?.[1].content).toBe('这次只说一句');
  });

  it('stops old-account tool execution when the identity changes during model generation', async () => {
    let identity='enterprise';
    const call=jest.fn().mockImplementation(async()=>{identity='personal';return first;});
    const {service}=create(call);
    (service as any).memoryPolicy={credentialIdentity:()=>identity};
    const events=[];
    for await(const event of service.run('identity','查看资料'))events.push(event);
    expect((service as any).executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({type:'error',error:expect.stringContaining('身份已切换')});
  });
});
