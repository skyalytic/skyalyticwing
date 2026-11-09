import 'reflect-metadata';
import { AgentMessengerService } from '../../src/modules/ai/agent/agent-messenger.service';

describe('collaborative reply skill execution', () => {
  function fixture() {
    const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const agents = {
      getAgent: (id: string) => ({
        id,
        name: id,
        model: 'fixture',
        systemPrompt: 'Expert',
        tools: ['skill_execute', 'file-read'],
      }),
    };
    const llm = { chatSync: jest.fn() };
    const tools = {
      getToolDefinitions: () =>
        ['skill_execute', 'file-read', 'file-write'].map((name) => ({ name })),
      execute: jest.fn(),
    };
    const skills = { buildPrompt: jest.fn().mockResolvedValue('AVAILABLE: long-guide') };
    const service = new AgentMessengerService(
      logger as any,
      { broadcast: jest.fn() } as any,
      agents as any,
      llm as any,
      tools as any,
      skills as any,
    ) as any;
    return { service, llm, tools, skills };
  }
  it('preserves the end of a long skill guide for the next real execution decision', async () => {
    const { service, llm, tools, skills } = fixture();
    const content = 'Step '.repeat(2000) + 'FINAL_REQUIRED_CHECK';
    tools.execute.mockResolvedValue({ success: true, output: content });
    const requests: any[] = [];
    llm.chatSync.mockImplementation(async (params: unknown) => {
      requests.push(structuredClone(params));
      return requests.length === 1
        ? {
            content: '',
            toolCalls: [{ id: 'read', name: 'skill_execute', arguments: '{"name":"long-guide"}' }],
          }
        : { content: 'Complete' };
    });
    await service.triggerAutoReply('source', 'target', 'Do the task', { id: 'original' });
    expect(skills.buildPrompt).toHaveBeenCalled();
    expect(requests[0].messages[0].content).toContain('AVAILABLE: long-guide');
    expect(requests[1].messages.find((m: any) => m.role === 'tool').content).toContain(
      'FINAL_REQUIRED_CHECK',
    );
  });
  it('rejects invented tools outside the expert allowlist and malformed JSON', async () => {
    const { service, tools } = fixture();
    expect(await service.executeTool('file-write', '{}', 'target')).toMatchObject({
      blocked: true,
    });
    expect(await service.executeTool('file-read', '{broken', 'target')).toMatchObject({
      success: false,
    });
    expect(tools.execute).not.toHaveBeenCalled();
  });
});
