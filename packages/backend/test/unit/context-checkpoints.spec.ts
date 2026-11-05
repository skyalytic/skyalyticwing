import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@skyalyticwing/shared';
import { SessionService } from '../../src/modules/session/session.service.js';
import { ChatControlService } from '../../src/modules/ai/chat/chat-control.service.js';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry.js';
import { compactContext, estimateContextTokens, historyExcerpt, COMPACTION_MARKER } from '../../src/modules/ai/agent/context-compaction.js';
import type { LlmMessage } from '../../src/modules/ai/types.js';

const logger = {info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()} as any;
const message = (i: number): ChatMessage => ({id:`m${i}`,role:'user',content:`要求 ${i}: ` + '重要内容'.repeat(1000),timestamp:i});

describe('model context checkpoints', () => {
  let session: SessionService;
  let previous: string | undefined;
  let id: string;
  beforeEach(() => {
    previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'wing-context-'));
    session = new SessionService(logger);
    session.onModuleInit();
    id = session.createSession().id;
    for (let i=0; i<20; i++) session.addMessage(id, message(i));
  });
  afterEach(async () => {
    ChatControlRegistry.markInactive(id);
    await session.onModuleDestroy();
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previous;
  });
  function service(chatSync = jest.fn().mockResolvedValue({content:'目标保持不变，继续剩余事项'})) {
    return new ChatControlService({chatSync,getDefaultModel:()=> 'test'} as any, logger, session);
  }
  it('keeps full history across compression, restart and subsequent messages; restore invalidates checkpoint', async () => {
    const original = structuredClone(session.getMessages(id));
    const result = await service().compact(id);
    expect(result).toMatchObject({success:true,compacted:true});
    expect(result.saved).toBeGreaterThan(0);
    expect(session.getMessages(id)).toEqual(original);
    expect(session.getContextMessages(id)).toHaveLength(9);
    expect(session.getContextMessages(id)[0]).toMatchObject({role:'user',contextSummary:true});
    const reopened = new SessionService(logger);
    reopened.onModuleInit();
    expect(reopened.getContextMessages(id)).toEqual(session.getContextMessages(id));
    reopened.addMessage(id,message(20));
    expect(reopened.getContextMessages(id)).toHaveLength(10);
    expect(reopened.getContextMessages(id).at(-1)?.id).toBe('m20');
    reopened.replaceMessages(id,original.slice(0,3));
    expect(reopened.getContextMessages(id)).toEqual(original.slice(0,3));
    await reopened.onModuleDestroy();
  });
  it('rejects a stale asynchronous summary without losing new messages', async () => {
    const chatSync = jest.fn().mockImplementation(async () => {
      session.addMessage(id,{...message(20),content:'刚追加的新要求'});
      return {content:'旧摘要'};
    });
    expect(await service(chatSync).compact(id)).toMatchObject({success:false,compacted:false});
    expect(session.getMessages(id)).toHaveLength(21);
    expect(session.getContextMessages(id).at(-1)?.content).toBe('刚追加的新要求');
  });
  it('rejects edits made while summarizing, even with unchanged IDs and count', async () => {
    const chatSync = jest.fn().mockImplementation(async () => {
      session.getSession(id)!.messages[0]!.content = 'changed';
      return {content:'old'};
    });
    expect(await service(chatSync).compact(id)).toMatchObject({success:false,compacted:false});
    expect(session.getContextMessages(id)[0]?.content).toBe('changed');
  });
  it('does not summarize a currently executing task', async () => {
    ChatControlRegistry.markActive(id);
    const call = jest.fn();
    expect(await service(call).compact(id)).toMatchObject({success:false,compacted:false});
    expect(call).not.toHaveBeenCalled();
  });
  it('micro compression preserves every request and tool pair, including tail diagnostics', () => {
    const original = [message(0), ...Array.from({length:35},(_,i):ChatMessage[]=>[
      {id:`call${i}`,role:'assistant',content:'',timestamp:i,toolCalls:[{id:`tc${i}`,type:'function',function:{name:'read',arguments:'{}'}}]},
      {id:`tool${i}`,role:'tool',toolCallId:`tc${i}`,content:'head'+'x'.repeat(6000)+'TAIL ERROR',timestamp:i},
    ]).flat(),message(99)];
    session.replaceMessages(id,original);
    expect(service().microCompact(id).success).toBe(true);
    const context = session.getContextMessages(id);
    expect(context).toHaveLength(original.length);
    expect(context[0]).toEqual(original[0]);
    expect(context[2]?.content).toContain('TAIL ERROR');
    expect(context[2]!.content.length).toBeLessThan(original[2]!.content.length);
    expect(session.getMessages(id)).toEqual(original);
  });
  it('falls back without erasing history when the summary model fails', async () => {
    expect(await service(jest.fn().mockRejectedValue(new Error('offline'))).compact(id)).toMatchObject({success:true,compacted:true});
    expect(session.getMessages(id)).toHaveLength(20);
    expect(JSON.stringify(session.getContextMessages(id))).toContain('要求 11');
  });
});

describe('context reduction', () => {
  it('counts multipart text and tool arguments without counting base64 as text tokens', () => {
    const text = '中文'.repeat(5000);
    expect(estimateContextTokens([{role:'user',content:[{type:'text',text}]}])).toBe(estimateContextTokens([{role:'user',content:text}]));
    expect(estimateContextTokens([{role:'assistant',content:'',toolCalls:[{id:'c',type:'function',function:{name:'write',arguments:text}}]}])).toBeGreaterThan(5000);
    expect(estimateContextTokens([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(100000)}}]}])).toBeLessThan(2000);
  });
  it('keeps parallel calls and results together and never expands context', () => {
    const transaction:LlmMessage[] = [
      {role:'assistant',content:'',toolCalls:['a','b'].map(id=>({id,type:'function',function:{name:'read',arguments:'{}'}}))},
      {role:'tool',toolCallId:'a',content:'A'}, {role:'tool',toolCallId:'b',content:'B'}, {role:'user',content:'continue'},
    ];
    const input:LlmMessage[] = [{role:'system',content:'policy'},...Array.from({length:15},(_,i):LlmMessage=>({role:'user',content:`request ${i} `+'x'.repeat(4000)})),...transaction];
    const output = compactContext(input,2);
    expect(output.slice(-4)).toEqual(transaction);
    expect(estimateContextTokens(output)).toBeLessThan(estimateContextTokens(input));
    const tiny:LlmMessage[] = [{role:'user',content:'hello'},{role:'assistant',content:'hi'}];
    expect(compactContext(tiny,1)).toBe(tiny);
  });
  it('does not mistake a user marker for generated summary metadata', () => {
    const input:LlmMessage[] = [{role:'user',content:COMPACTION_MARKER+' this is literal quoted text'}];
    expect(compactContext(input,1)).toBe(input);
    expect(input[0]?.contextSummary).toBeUndefined();
  });
  it('allocates space to the original request and late corrections despite huge tool output', () => {
    const input:LlmMessage[] = [{role:'user',content:'ORIGINAL GOAL'},...Array.from({length:50},():LlmMessage=>({role:'tool',content:'x'.repeat(5000)})),{role:'user',content:'LATEST CORRECTION'}, {role:'tool',content:'y'.repeat(5000)+'LAST ERROR'}];
    const summary = historyExcerpt(input);
    expect(summary).toContain('ORIGINAL GOAL');
    expect(summary).toContain('LATEST CORRECTION');
    expect(summary).toContain('LAST ERROR');
    expect(summary.length).toBeLessThanOrEqual(12000);
  });
});

