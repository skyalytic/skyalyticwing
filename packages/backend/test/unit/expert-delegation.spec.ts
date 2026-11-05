import { AgentService } from '../../src/modules/ai/agent/agent.service';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service';
import { AgentSwarmService } from '../../src/modules/ai/agent/agent-swarm.service';
import { SessionService } from '../../src/modules/session/session.service';
import { createPlatformTools } from '../../src/modules/tools/executor/built-in/platform-tools';

describe('expert delegation bridge', () => {
  const registry = new AgentService();
  const writer = registry.createAgent({ name: 'writer', slug: 'writer', systemPrompt: '核实来源后写作', model: 'writer-model', tools: ['read_file'] });
  const editor = registry.createAgent({ name: 'editor', slug: 'editor', systemPrompt: '我是主管', model: 'lead-model', tools: ['subagent_spawn_swarm'] });
  const team = registry.createTeam({ name: '编辑团队', memberIds: [writer.id, editor.id], leadId: editor.id });
  const swarm = { spawnSwarm: jest.fn().mockResolvedValue({ success: true, totalTasks: 1, completed: 1, failed: 0, results: [], summary: 'ok' }) };
  const session = { getSession: () => ({ agent: 'team:' + team.id, model: 'session-model' }) };
  const tool = createPlatformTools({} as never, ((token: unknown) => token === AgentSwarmService ? swarm : token === AgentService ? registry : token === SessionService ? session : undefined) as never).find(x => x.name === 'subagent_spawn_swarm')!;
  const ctx = { sessionId: 'session', workspace: 'workspace' } as never;
  beforeEach(() => jest.clearAllMocks());
  it('loads saved expert configuration instead of letting the model invent the role', async () => {
    const result = await tool.execute({ tasks: [{ agentId: 'writer', task: 'draft', systemPrompt: 'invented role', model: 'wrong-model' }] }, ctx);
    expect(result.success).toBe(true);
    expect(swarm.spawnSwarm).toHaveBeenCalledWith('session', [expect.objectContaining({ systemPrompt: writer.systemPrompt, model: writer.model, tools: ['read_file'] })]);
  });
  it('rejects non-members, uncallable members and missing expert references', async () => {
    const outsider = registry.createAgent({ name: 'outsider', model: '' });
    for (const tasks of [[{ agentId: outsider.id, task: 'x' }], [{ task: 'x' }]]) expect((await tool.execute({ tasks }, ctx)).success).toBe(false);
    registry.updateAgent(writer.id, { callable: false });
    expect((await tool.execute({ tasks: [{ agentId: writer.id, task: 'x' }] }, ctx)).success).toBe(false);
    registry.updateAgent(writer.id, { callable: true });
    expect(swarm.spawnSwarm).not.toHaveBeenCalled();
  });
  it('uses the selected team lead model, tools and role in the chat loop', () => {
    const loop = Object.create(AgentLoopService.prototype);
    loop.agentService = registry;
    const result = loop.tryGetAgent('team:' + team.id);
    expect(result.model).toBe('lead-model');
    expect(result.tools).toEqual(editor.tools);
    expect(result.systemPrompt).toContain(editor.systemPrompt);
    expect(result.systemPrompt).toContain('agentId');
  });
  it('repairs the leader when members change or an expert is deleted', () => {
    const local = new AgentService();
    const one = local.createAgent({ name: 'one', model: '' }), two = local.createAgent({ name: 'two', model: '' });
    const group = local.createTeam({ name: 'group', memberIds: [one.id, two.id], leadId: one.id });
    expect(local.updateTeam(group.id, { memberIds: [two.id] }).leadId).toBe(two.id);
    local.deleteAgent(two.id);
    expect(local.getTeam(group.id).memberIds).toEqual([]);
    expect(local.getTeam(group.id).leadId).toBeUndefined();
  });
  it('reports swarm failure through ToolResult instead of returning success', async () => {
    swarm.spawnSwarm.mockResolvedValueOnce({ success: false, totalTasks: 1, completed: 0, failed: 1, results: [{ success: false, error: 'provider failed' }], summary: '' });
    expect((await tool.execute({ tasks: [{ agentId: writer.id, task: 'x' }] }, ctx)).success).toBe(false);
  });
});
