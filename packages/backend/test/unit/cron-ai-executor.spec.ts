import 'reflect-metadata';
import { CronAiExecutorService } from '../../src/modules/ai/agent/cron-ai-executor.service';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';

describe('scheduled AI task completion contracts', () => {
  const llm = { chatSync: jest.fn(), getDefaultModel: () => 'fixture', resolveProviderForModel: (model: string) => ({id:'qwen',model}) };
  const cron = { applyLongRunningUpdate: jest.fn() };
  const executor = { getToolDefinitions: () => [], execute: jest.fn() };
  const service = new CronAiExecutorService({ warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as never, llm as never, cron as never, executor as never);
  const job = { id: 'fixture', name: 'test', prompt: 'test', model: 'fixture' } as never;
  beforeEach(() => jest.clearAllMocks());
  it('sends screenshot pixels to a vision model outside tool result text', async () => {
    executor.execute.mockResolvedValue({success:true,data:{visualObservation:{base64:'aGVsbG8='}}});
    llm.chatSync.mockResolvedValueOnce({content:'',toolCalls:[{id:'image',name:'desktop_screenshot',arguments:'{}'}]}).mockResolvedValueOnce({content:'画面已检查'});
    await service.executeAiJob({id:'visual',name:'vision',prompt:'look',model:'qwen3-vl-plus'} as never,'');
    const messages=llm.chatSync.mock.calls[1][0].messages;
    expect(messages.some((m: {content:unknown})=>Array.isArray(m.content))).toBe(true);
    expect(JSON.stringify(messages.filter((m: {role:string})=>m.role==='tool'))).not.toContain('aGVsbG8');
  });
  it('does not report an earlier narration as success after a model failure', async () => {
    llm.chatSync.mockResolvedValueOnce({ content: 'Starting', toolCalls: [{ id: '1', name: 'read', arguments: '{}' }] }).mockRejectedValueOnce(new Error('provider offline'));
    await expect(service.executeAiJob(job, '')).rejects.toThrow('provider offline');
    expect(cron.applyLongRunningUpdate).toHaveBeenLastCalledWith('fixture', expect.objectContaining({ error: true }));
  });
  it('continues past the old thirty-round cap and obeys an explicit stop', async () => {
    let rounds=0;
    executor.execute.mockResolvedValue({success:true,output:'read'});
    llm.chatSync.mockImplementation(async () => {
      if (++rounds===36) ChatControlRegistry.requestAbort('cron-ai-fixture');
      return { content:'Still working',toolCalls:[{id:String(rounds),name:'file_read',arguments:'{}'}] };
    });
    try {
      await expect(service.executeAiJob(job, '')).rejects.toThrow('用户停止');
      expect(llm.chatSync).toHaveBeenCalledTimes(36);
      for(const [args] of llm.chatSync.mock.calls) expect(args.messages[1]?.role).not.toBe('tool');
    } finally {ChatControlRegistry.clearAbort('cron-ai-fixture');}
  });
  it('fails empty output and does not execute malformed tool arguments', async () => {
    llm.chatSync.mockResolvedValue({ content: '' });
    await expect(service.executeAiJob(job, '')).rejects.toThrow('空结果');
    const result = await (service as any).executeTool('write', '{', 'fixture');
    expect(result.error).toContain('未执行'); expect(executor.execute).not.toHaveBeenCalled();
  });
});
