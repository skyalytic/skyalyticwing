import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSwarmService, type SubAgent } from '../../src/modules/ai/agent/agent-swarm.service';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';

describe('expert team execution', () => {
  let service: AgentSwarmService;
  let root: string;
  let previous: string | undefined;
  const llm = { getDefaultModel: jest.fn(() => 'default'), chatSync: jest.fn(), resolveProviderForModel: (model: string) => ({id:'qwen',model}) };
  const executor = { getToolDefinitions: jest.fn(), execute: jest.fn() };
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const ws = { broadcast: jest.fn() };
  const create = (config = {}) => service.createSubAgent('session', { task: 'task', autoDestroy: false, ...config }) as SubAgent;
  beforeEach(() => {
    jest.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'wing-swarm-'));
    previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    service = new AgentSwarmService(logger as never, ws as never, llm as never, executor as never);
    llm.chatSync.mockReset().mockResolvedValue({ content: 'done' });
    executor.getToolDefinitions.mockReturnValue([{ name: 'read_file', description: '', parameters: {} }, { name: 'write_file', description: '', parameters: {} }, { name: 'subagent_execute', description: '', parameters: {} }]);
    executor.execute.mockResolvedValue({ success: true, output: 'read' });
  });
  afterEach(() => {
    service.onModuleDestroy();
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  it('cannot redispatch a running or completed task and overwrite its instructions', async () => {
    const agent = create();
    const running = service.executeSync(agent.id);
    expect(service.dispatchTask(agent.id, 'replacement').success).toBe(false);
    expect(service.getAgentStatus(agent.id)?.task).toBe('task');
    await running;
    expect(service.dispatchTask(agent.id, 'replay').success).toBe(false);
    expect(llm.chatSync).toHaveBeenCalledTimes(1);
  });
  it('marks persistence failures as errors and releases the execution slot', async () => {
    const agent = create();
    const checkpoint = jest.spyOn(service as unknown as {checkpoint(agent: SubAgent): void}, 'checkpoint').mockImplementation(() => { throw new Error('disk full'); });
    try {
      const result = await service.executeSync(agent.id);
      expect(result.success).toBe(false);
      expect(result.error).toContain('disk full');
      expect(service.getAgentStatus(agent.id)?.status).toBe('error');
      expect(service.getRunningCount()).toBe(0);
      expect(llm.chatSync).not.toHaveBeenCalled();
    } finally { checkpoint.mockRestore(); }
    expect((await service.executeSync(create().id)).success).toBe(true);
  });
  it('releases cancelled model slots even when a provider ignores abort', async () => {
    let started!: () => void, count = 0;
    const fiveStarted = new Promise<void>(resolve => { started = resolve; });
    llm.chatSync.mockImplementation(() => { if (++count === 5) started(); return new Promise(() => {}); });
    const agents = Array.from({length: 6}, () => create());
    const running = agents.map(a => service.executeSync(a.id));
    await fiveStarted;
    service.terminateAgent(agents[0].id);
    expect((await running[0]).status).toBe('destroyed');
    await new Promise(resolve => setImmediate(resolve));
    expect(llm.chatSync).toHaveBeenCalledTimes(6);
    for (const a of agents.slice(1)) service.terminateAgent(a.id);
    await Promise.all(running);
    expect(service.getRunningCount()).toBe(0);
  });
  it('cancels active and queued tasks even when history storage fails', async () => {
    llm.chatSync.mockImplementation(() => new Promise(() => {}));
    const agents = Array.from({length: 6}, () => create());
    const running = agents.map(a => service.executeSync(a.id));
    const checkpoint = jest.spyOn(service as unknown as {checkpoint(agent: SubAgent): void}, 'checkpoint').mockImplementation(() => { throw new Error('disk full'); });
    try {
      for (const agent of agents) expect(service.terminateAgent(agent.id).success).toBe(true);
      expect((await Promise.all(running)).every(r => !r.success)).toBe(true);
      expect(service.getRunningCount()).toBe(0);
    } finally { checkpoint.mockRestore(); }
  });
  it('cancels the child swarm when its parent conversation is stopped', async () => {
    service.onModuleInit();
    llm.chatSync.mockImplementation(() => new Promise(() => {}));
    const run = service.spawnSwarm('parent', Array.from({length: 8}, () => 'task'));
    ChatControlRegistry.requestAbort('parent');
    const result = await run;
    expect(result.failed).toBe(8);
    expect(service.getRunningCount()).toBe(0);
    ChatControlRegistry.clearAbort('parent');
  });
  it('hides and protects other identities and persists results into the original workspace', async () => {
    let identity = 'enterprise';
    const policy = {credentialIdentity: () => identity, localMemoryRoot: () => join(root, identity)};
    service = new AgentSwarmService(logger as never, ws as never, llm as never, executor as never, undefined, policy as never);
    service.onModuleInit();
    const agent = create();
    identity = 'personal';
    expect(service.listActiveAgents()).toEqual([]);
    expect(service.listHistory()).toEqual([]);
    expect(service.getAgentStatus(agent.id)).toBeNull();
    expect(service.communicate('parent', agent.id, 'leak').success).toBe(false);
    expect(service.destroyAgent(agent.id).success).toBe(false);
    expect((await service.executeSync(agent.id)).success).toBe(false);
    expect(service.createSubAgent(agent.id, {task:'child'}).id).toBeNull();
    identity = 'enterprise';
    expect((await service.executeSync(agent.id)).success).toBe(true);
    expect(service.getAgentStatus(agent.id)?.dataRoot).toBe(join(root, 'enterprise'));
  });
  it('forks preserve the selected model and explicit budget', () => {
    const parent = create({model: 'expert-model'});
    const fork = service.createFork(parent.id, {maxIterations: 7, autoDestroy: false}) as SubAgent;
    expect(fork.model).toBe('expert-model');
    expect(fork.maxIterations).toBe(7);
    expect(fork.autoDestroy).toBe(false);
  });
  it('forks inherit the actual conversation before the new task and persist that context', async()=>{
    const sessions={getSession:()=>({model:'conversation-model',messages:[{role:'user',content:'仅分析项目甲'}]}),getContextMessages:()=>[{role:'user',content:'仅分析项目甲'},{role:'assistant',content:'已读取需求'}]};
    service=new AgentSwarmService(logger as never,ws as never,llm as never,executor as never,undefined,undefined,sessions as never);
    service.onModuleInit();
    const fork=service.createFork('conversation',{task:'检查边界',autoDestroy:false}) as SubAgent;
    expect(service.listHistory().find(a=>a.id===fork.id)?.messages).toHaveLength(2);
    await service.executeSync(fork.id);
    const request=llm.chatSync.mock.calls[0][0];
    expect(request.model).toBe('conversation-model');
    expect(request.messages.slice(1)).toEqual([{role:'user',content:'仅分析项目甲'},{role:'assistant',content:'已读取需求'},{role:'user',content:'检查边界'}]);
  });
  it('does not expand a parent tool allowlist when forking',()=>{
    const parent=create({tools:['read_file'],allowDelegation:false});
    const fork=service.createFork(parent.id,{tools:['write_file'],allowDelegation:true}) as SubAgent;
    expect(fork.tools).toEqual(['read_file']);expect(fork.allowDelegation).toBe(false);
    expect(fork.workspace).toContain(parent.id);
  });
  it('cancels an in-flight tool and frees the slot without accepting its late result',async()=>{
    let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});
    let toolSignal:AbortSignal|undefined;
    executor.execute.mockImplementation((_name,_args,ctx)=>{toolSignal=ctx.signal;started();return new Promise(()=>{});});
    llm.chatSync.mockResolvedValue({content:'',toolCalls:[{id:'call',name:'read_file',arguments:'{}'}]});
    const agent=create({inheritTools:true}),run=service.executeSync(agent.id);await entered;
    service.terminateAgent(agent.id);
    expect((await run).status).toBe('destroyed');expect(toolSignal?.aborted).toBe(true);expect(service.getRunningCount()).toBe(0);
  });
  it('preserves interrupted work across graceful shutdown without replaying it',async()=>{
    service.onModuleInit();llm.chatSync.mockImplementation(()=>new Promise(()=>{}));
    const agent=create(),run=service.executeSync(agent.id);service.onModuleDestroy();await run;
    const restarted=new AgentSwarmService(logger as never,ws as never,llm as never,executor as never);restarted.onModuleInit();
    expect(restarted.listHistory().find(r=>r.id===agent.id)?.recovery).toBe('interrupted');
    expect(restarted.listActiveAgents()).toEqual([]);restarted.onModuleDestroy();
  });
  it('queues every task in both swarms and enforces a global limit of five', async () => {
    let active = 0;
    let peak = 0;
    llm.chatSync.mockImplementation(async (params) => {
      active++; peak = Math.max(peak, active);
      await new Promise((done) => setTimeout(done, 5));
      active--;
      return { content: params.messages[1].content };
    });
    const tasks = Array.from({ length: 8 }, (_, i) => `task-${i}`);
    const results = await Promise.all([service.spawnSwarm('one', tasks), service.spawnSwarm('two', tasks)]);
    expect(peak).toBe(5);
    expect(service.getRunningCount()).toBe(0);
    for (const result of results) {
      expect(result.totalTasks).toBe(8);
      expect(result.completed).toBe(8);
      expect(result.results.map((x) => x.result)).toEqual(tasks);
    }
  });
  it('persists completed and interrupted expert runs without automatically replaying tools',async()=>{
    service.onModuleInit();const completed=create({autoDestroy:true});await service.executeSync(completed.id);
    const interrupted=create();
    const restarted=new AgentSwarmService(logger as never,ws as never,llm as never,executor as never);restarted.onModuleInit();
    expect(restarted.listHistory().find(r=>r.id===completed.id)?.status).toBe('completed');
    expect(restarted.listHistory().find(r=>r.id===interrupted.id)?.recovery).toBe('interrupted');
    expect(restarted.retryInterrupted(interrupted.id,false).success).toBe(false);
    const retry=restarted.retryInterrupted(interrupted.id,true);expect(retry.success).toBe(true);
    await restarted.executeSync(retry.agentId!);expect(restarted.listHistory().find(r=>r.id===retry.agentId)?.retryOf).toBe(interrupted.id);
    restarted.onModuleDestroy();
  });
  it('uses the expert role/model and enforces its tool allowlist even for invented calls', async () => {
    const agent = create({ systemPrompt: '我是审校专家', model: 'expert-model', tools: ['read_file'] });
    llm.chatSync.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'x', name: 'write_file', arguments: '{}' }] }).mockResolvedValueOnce({ content: 'reviewed' });
    expect((await service.executeSync(agent.id)).success).toBe(false);
    const params = llm.chatSync.mock.calls[0][0];
    expect(params.model).toBe('expert-model');
    expect(params.messages[0].content).toContain('我是审校专家');
    expect(params.tools.map((x: { name: string }) => x.name)).toEqual(['read_file', 'task_verify']);
    expect(executor.execute).not.toHaveBeenCalled();
  });
  it('cancels an in-flight model call and cannot resurrect the task or execute returned tools', async () => {
    let finish!: (value: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    llm.chatSync.mockImplementation(() => new Promise((done) => { finish = done; markStarted(); }));
    const agent = create({ inheritTools: true });
    const run = service.executeSync(agent.id);
    await started;
    const signal = llm.chatSync.mock.calls[0][0].signal as AbortSignal;
    service.terminateAgent(agent.id);
    expect(signal.aborted).toBe(true);
    finish({ content: '', toolCalls: [{ id: 'x', name: 'write_file', arguments: '{}' }] });
    expect((await run).status).toBe('destroyed');
    expect(service.getAgentStatus(agent.id)).toBeNull();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(ws.broadcast).not.toHaveBeenCalled();
  });
  it('resolves cancellation of queued work immediately without calling the provider', async () => {
    const releases: Array<(result: unknown) => void> = [];
    llm.chatSync.mockImplementation(() => new Promise((done) => releases.push(done)));
    const agents = Array.from({ length: 6 }, () => create());
    const pending = agents.map((a) => service.executeSync(a.id));
    service.terminateAgent(agents[5].id);
    expect((await pending[5]).status).toBe('destroyed');
    releases.forEach((done) => done({ content: 'ok' }));
    await Promise.all(pending);
    expect(llm.chatSync).toHaveBeenCalledTimes(5);
  });
  it('coalesces duplicate execution of the same task', async () => {
    const agent = create();
    await Promise.all([service.executeSync(agent.id), service.executeSync(agent.id)]);
    expect(llm.chatSync).toHaveBeenCalledTimes(1);
  });
  it('passes the latest screenshot as vision content and keeps pixels out of tool text', async () => {
    const agent=create({model:'qwen3-vl-plus',tools:['read_file']});
    executor.execute.mockResolvedValue({success:true,data:{visualObservation:{base64:'aGVsbG8='}}});
    llm.chatSync.mockResolvedValueOnce({content:'',toolCalls:[{id:'image',name:'read_file',arguments:'{}'}]}).mockResolvedValueOnce({content:'observed'});
    expect((await service.executeSync(agent.id)).success).toBe(true);
    const messages=llm.chatSync.mock.calls[1][0].messages;
    expect(messages.some((m: {content:unknown})=>Array.isArray(m.content))).toBe(true);
    expect(JSON.stringify(messages.filter((m: {role:string})=>m.role==='tool'))).not.toContain('aGVsbG8');
  });
  it('counts failures including creation failures and does not report overall success', async () => {
    llm.chatSync.mockRejectedValue(new Error('provider failed'));
    const result = await service.spawnSwarm('main', ['one', 'two']);
    expect(result.success).toBe(false);
    expect(result.failed).toBe(2);
    jest.spyOn(service, 'createSubAgent').mockReturnValue({ id: null, error: 'depth limit' });
    expect((await service.spawnSwarm('main', ['one'])).failed).toBe(1);
  });
  it('allows sibling forks and rejects forks nested within a fork', () => {
    const one = service.createFork('session', {}) as SubAgent;
    expect(service.createFork('session', {})).toHaveProperty('id');
    expect(service.createFork(one.id, {})).toHaveProperty('error');
  });
  it('delivers collaboration messages to the actual model context', async () => {
    const agent = create();
    service.communicate('reviewer', agent.id, '请补来源');
    await service.executeSync(agent.id);
    expect(llm.chatSync.mock.calls[0][0].messages).toContainEqual({ role: 'user', content: '请补来源' });
  });
  it('does not claim success for empty output or repeated tool calls', async () => {
    llm.chatSync.mockResolvedValue({ content: '' });
    expect((await service.executeSync(create().id)).success).toBe(false);
    llm.chatSync.mockResolvedValue({ content: 'working', toolCalls: [{ id: 'x', name: 'read_file', arguments: '{}' }] });
    const result = await service.executeSync(create({ inheritTools: true }).id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('避免死循环');
    expect(llm.chatSync.mock.calls.at(-1)![0].messages[0].role).toBe('system');
  });
  it('honors an explicit iteration budget without reporting completion', async () => {
    llm.chatSync.mockResolvedValue({ content: 'working', toolCalls: [{ id: 'x', name: 'read_file', arguments: '{}' }] });
    const result = await service.executeSync(create({ inheritTools: true, maxIterations: 2 }).id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('迭代上限');
    expect(llm.chatSync).toHaveBeenCalledTimes(2);
  });
  it('does not stop legitimate polling while the observed progress changes', async () => {
    let calls=0, progress=0;
    llm.chatSync.mockImplementation(async()=>++calls<=12 ? {content:'',toolCalls:[{id:String(calls),name:'read_file',arguments:'{}'}]} : {content:'done'});
    executor.execute.mockImplementation(async()=>({success:true,output:'progress '+(++progress)}));
    expect((await service.executeSync(create({inheritTools:true}).id)).success).toBe(true);
    expect(calls).toBe(13);
  });
  it('nested execution shares its waiting parent slot without deadlock', async () => {
    llm.chatSync.mockImplementation(async (params) => {
      if (params.messages[1].content !== 'task') return {content:'done'};
      if (params.messages.length === 2) return { content: '', toolCalls: [{ id: 'child', name: 'subagent_execute', arguments: '{"task":"child"}' }] };
      if (!params.messages.some((m: {toolCallId?:string}) => m.toolCallId === 'verify'))
        return {content:'',toolCalls:[{id:'verify',name:'task_verify',arguments:JSON.stringify({checks:[{requirement:'子任务完成',status:'passed',evidence:['child'],detail:'同步子任务已成功完成并返回结果'}]})}]};
      return {content:'done'};
    });
    const result = await service.spawnSwarm('session', Array.from({ length: 5 }, () => ({ task: 'task', inheritTools: true })));
    expect(result.completed).toBe(5);
    expect(service.getRunningCount()).toBe(0);
  });
});
