import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@skyalyticwing/shared';
import type { LlmMessage } from '../../src/modules/ai/types.js';
import { SessionService } from '../../src/modules/session/session.service.js';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service.js';
import { AutomaticContextCheckpoint } from '../../src/modules/ai/agent/automatic-context-checkpoint.js';
import { toolResultContext, replayToolResult } from '../../src/modules/ai/agent/tool-result-context.js';
import { estimateContextTokens } from '../../src/modules/ai/agent/context-compaction.js';

const logger = {info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()} as any;
describe('tool result replay', () => {
  it('sends a duplicated window inventory once, identically live and after resume', () => {
    const data = {roots:Array.from({length:100},(_,i)=>({title:'window '+i,windowId:i}))};
    const result = {success:true,output:JSON.stringify(data),data};
    expect(replayToolResult(JSON.stringify(result))).toBe(toolResultContext(result));
    expect(JSON.parse(replayToolResult(JSON.stringify(result)))).toEqual(data);
    expect(replayToolResult(JSON.stringify(result)).length).toBeLessThan(JSON.stringify(result).length / 2);
  });
  it('retains distinct metadata, failures, legacy text and interrupted receipts', () => {
    const observed = {success:true,output:'{"lookId":"frame","bounds":{"x":0}}',data:{bounds:{x:0},lookId:'frame',visualEvidence:{screenshotId:'frame'}}};
    expect(JSON.parse(toolResultContext(observed))).toEqual(observed.data);
    const result = {success:true,output:'rendered',data:{path:'movie.mp4'}};
    expect(JSON.parse(toolResultContext(result))).toEqual(result);
    const failed = {success:false,error:'permission denied',output:'partial',blocked:true,data:{exitCode:1}};
    expect(JSON.parse(replayToolResult(JSON.stringify(failed)))).toEqual(failed);
    for (const content of ['Execution result unknown after interruption','{broken','plain result'])
      expect(replayToolResult(content)).toBe(content);
  });
  it('continues excluding old corrupt binary output before replay normalization', () => {
    const result = {success:true,output:'\u0000'.repeat(10000),data:{path:'image.png'}};
    const text = replayToolResult(JSON.stringify(result),'file-read');
    expect(text).toContain('binary');
    expect(text.length).toBeLessThan(1000);
  });
});

describe('automatic checkpoint contents', () => {
  it('keeps attachments and the latest task but excludes injected memory and screenshots across repeated compression', () => {
    const tracker = new AutomaticContextCheckpoint();
    const messages:LlmMessage[] = Array.from({length:20},(_,i)=>({role:'assistant',content:'history '+i+'x'.repeat(6000)}));
    const record:ChatMessage = {id:'latest',role:'user',content:'CURRENT TASK',timestamp:1,attachments:[{type:'file',name:'brief.txt',url:'file.txt'}]};
    const request:LlmMessage = {role:'user',content:record.content};
    tracker.track(request,record);
    request.content = 'INJECTED MEMORY '+record.content;
    messages.push(request,...Array.from({length:12},()=>({role:'assistant' as const,content:'tool progress '+'y'.repeat(6000)})));
    const screenshot:LlmMessage = {role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,TRANSIENT_SCREEN'}}]};
    tracker.ephemeral(screenshot); messages.push(screenshot);
    const compacted = tracker.compact(messages,4);
    expect(compacted).toContain(request);
    expect(compacted).toContain(screenshot);
    expect(compacted.find(m=>m.contextSummary)?.content).not.toContain('INJECTED MEMORY');
    const records = tracker.records(compacted);
    expect(records).toContainEqual(record);
    expect(JSON.stringify(records)).not.toContain('INJECTED MEMORY');
    expect(JSON.stringify(records)).not.toContain('TRANSIENT_SCREEN');
    expect(JSON.stringify(tracker.records(tracker.compact(compacted,1)))).not.toContain('INJECTED MEMORY');
  });
});

describe('agent automatic context recovery', () => {
  let session:SessionService, id:string, previous:string|undefined;
  beforeEach(()=>{
    previous=process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR']=mkdtempSync(join(tmpdir(),'wing-auto-context-'));
    session=new SessionService(logger);session.onModuleInit();id=session.createSession().id;
    for(let i=0;i<24;i++)session.addMessage(id,{id:'old'+i,role:i===0?'user':'assistant',content:'history '+i+'资料'.repeat(3000),timestamp:i});
  });
  afterEach(async()=>{
    await session.onModuleDestroy();
    if(previous===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=previous;
  });
  function create(chatSync:jest.Mock,budget:number|undefined) {
    const llm={chatSync,getDefaultModel:()=> 'gpt-4o',getMaxContextTokens:()=>budget,resolveProviderForModel:()=>({id:'openai',model:'gpt-4o'})};
    const service=new (AgentLoopService as any)(llm,{}, {validateString:jest.fn()},logger,{}, {}, {}, {}, {}, {}, {}, {},session) as AgentLoopService;
    jest.spyOn(service as any,'getToolDefinitions').mockReturnValue([{name:'computer_use',description:'fixture',parameters:{}}]);
    jest.spyOn(service as any,'emitHook').mockImplementation(()=>undefined);
    jest.spyOn(service as any,'buildWorkspaceNotice').mockReturnValue('workspace');
    return service;
  }
  async function run(service:AgentLoopService,text='continue') {const events=[];for await(const event of service.run(id,text))events.push(event);return events;}
  it('persists proactive compaction, preserves history, and resumes the checkpoint after a model failure and restart',async()=>{
    const call=jest.fn().mockRejectedValue(new Error('503 upstream_auth_error'));
    const original=structuredClone(session.getMessages(id));
    await run(create(call,30000));
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.getMessages(id).slice(0,24)).toEqual(original);
    expect(session.getContextMessages(id)[0]).toMatchObject({contextSummary:true});
    const reopened=new SessionService(logger);reopened.onModuleInit();
    expect(reopened.getContextMessages(id)).toEqual(session.getContextMessages(id));
    const next=jest.fn().mockResolvedValue({content:'done'});
    await run(create(next,30000),'resume');
    const sent=next.mock.calls[0][0].messages as LlmMessage[];
    expect(sent.filter(m=>m.contextSummary)).toHaveLength(1);
    expect(sent.at(-1)?.content).toBe('resume');
    expect(estimateContextTokens(sent)).toBeLessThan(30000);
    expect(session.getMessages(id)).toHaveLength(28);
    expect(session.getMessages(id).filter(m=>m.phase==='status')).toHaveLength(1);
    await reopened.onModuleDestroy();
  });
  it('uses progressively smaller history on real overflow, persists it, and never retries auth errors',async()=>{
    const captured:LlmMessage[][]=[];
    const call=jest.fn().mockImplementation(async(params)=>{
      captured.push(structuredClone(params.messages));
      if(captured.length<3)throw new Error('400 upstream_context_exceeded');
      return {content:'done'};
    });
    expect((await run(create(call,undefined))).at(-1)?.type).toBe('done');
    expect(call).toHaveBeenCalledTimes(3);
    expect(estimateContextTokens(captured[1]!)).toBeLessThan(estimateContextTokens(captured[0]!));
    expect(estimateContextTokens(captured[2]!)).toBeLessThan(estimateContextTokens(captured[1]!));
    expect(session.getContextMessages(id)[0]).toMatchObject({contextSummary:true});
    const auth=jest.fn().mockRejectedValue(new Error('503 upstream_auth_error'));
    await run(create(auth,undefined));
    expect(auth).toHaveBeenCalledTimes(1);
  });
  it('checkpoints tools produced in this run without persisting their screenshot or replaying the action',async()=>{
    const sent:LlmMessage[][]=[];
    const call=jest.fn().mockImplementation(async(params)=>{
      sent.push(structuredClone(params.messages));
      return sent.length===1
        ? {content:'',toolCalls:[{id:'screen-call',name:'computer_use',arguments:'{"action":"screenshot"}'}]}
        : {content:'done'};
    });
    const service=create(call,30000);
    jest.spyOn(service as any,'checkToolGate').mockReturnValue({action:'pass'});
    const execute=jest.spyOn(service as any,'executeTool').mockResolvedValue({
      success:true,output:'OBSERVATION '+'x'.repeat(200000),
      data:{desktopWorkflow:true,lookId:'frame',visualObservation:{base64:'SCREEN_BYTES',width:100,height:100,screenshotId:'frame'}},
    });
    const events=await run(service,'KEEP THIS REQUEST');
    expect(events.at(-1)?.type).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(estimateContextTokens(sent[1]!)).toBeLessThan(30000);
    expect(JSON.stringify(sent[1])).toContain('SCREEN_BYTES');
    expect(sent[1]?.some(m=>m.content==='KEEP THIS REQUEST')).toBe(true);
    const records=session.getContextMessages(id);
    expect(JSON.stringify(records)).not.toContain('SCREEN_BYTES');
    expect(records[0]?.contextSummary).toBe(true);
    const storedTool=session.getMessages(id).find(m=>m.toolCallId==='screen-call');
    expect(storedTool?.content).toContain('OBSERVATION');
    expect(session.getMessages(id)).toHaveLength(28);
  });
  it('bounds overflow retries and retains the current oversized request without silently truncating it',async()=>{
    const request='CURRENT REQUIREMENTS '.repeat(5000);
    const call=jest.fn().mockRejectedValue(new Error('maximum context length exceeded'));
    const events=await run(create(call,undefined),request);
    expect(call.mock.calls.length).toBeLessThanOrEqual(4);
    expect(events.at(-1)?.type).toBe('error');
    for(const [params] of call.mock.calls)expect(params.messages.some((m:LlmMessage)=>m.content===request)).toBe(true);
    expect(session.getMessages(id).filter(m=>m.role==='user').at(-1)?.content).toBe(request);
    expect(session.getMessages(id).at(-1)?.phase).toBe('status');
  });
  it('does not overwrite history changed while awaiting the supplier overflow',async()=>{
    const call=jest.fn().mockImplementationOnce(async()=>{
      session.addMessage(id,{id:'new',role:'user',content:'CONCURRENT CORRECTION',timestamp:1});
      throw new Error('maximum context length exceeded');
    }).mockResolvedValue({content:'done'});
    await run(create(call,undefined));
    expect(session.getContextMessages(id).some(m=>m.content==='CONCURRENT CORRECTION')).toBe(true);
    expect(session.getContextMessages(id)[0]?.contextSummary).not.toBe(true);
  });
});
