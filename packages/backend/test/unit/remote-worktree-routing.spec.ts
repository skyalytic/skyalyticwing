import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSwarmService, SubAgent } from '../../src/modules/ai/agent/agent-swarm.service';
import { createSessionAgentTools } from '../../src/extensions/bundled/agents/tools/session-agent';

describe('remote isolation across orchestration entry points', () => {
  let root: string, previous: string | undefined, service: AgentSwarmService;
  const source = {
    id: 'source',
    name: 'source',
    root: '/work',
    transport: 'ssh',
    target: 'fixture.invalid',
  };
  const inherited = new Map<string, { parent: string; mode: string }>(),
    prepared = new Map<string, any>();
  const remote = {
    binding: (id: string) => (id === 'session' ? source : prepared.get(id)),
    inherit: jest.fn((parent: string, id: string, mode: string) => {
      inherited.set(id, { parent, mode });
    }),
    hasChild: (id: string) => inherited.has(id),
    prepareChild: jest.fn(async (id: string) => {
      const value = {
        ...source,
        id,
        root: '/worktrees/' + id,
        worktree: {
          token: id,
          sourceId: 'source',
          baseHead: 'base',
          checkout: '/worktrees/' + id,
          childSessionId: id,
        },
      };
      prepared.set(id, value);
      return value;
    }),
    release: jest.fn((id: string) => {
      inherited.delete(id);
    }),
  };
  const llm = {
    getDefaultModel: () => 'fixture',
    chatSync: jest.fn(),
    resolveProviderForModel: () => ({ id: 'fixture', model: 'fixture' }),
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} },
    ws = { broadcast() {} };
  const executor = {
    getToolDefinitions: () =>
      ['file-read', 'file-write', 'subagent_execute'].map((name) => ({
        name,
        description: name,
        parameters: { type: 'object' },
      })),
    execute: jest.fn(),
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-routing-fixture-'));
    previous = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    inherited.clear();
    prepared.clear();
    jest.clearAllMocks();
    llm.chatSync.mockResolvedValue({ content: 'done' });
    service = new AgentSwarmService(
      logger as any,
      ws as any,
      llm as any,
      executor as any,
      undefined,
      undefined,
      undefined,
      remote as any,
    );
  });
  afterEach(() => {
    service.onModuleDestroy();
    if (previous === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  it('defaults workers and forks to isolation and preserves explicit sharing', () => {
    const one = service.createSubAgent('session', {}) as SubAgent;
    const two = service.createFork('session', {}) as SubAgent;
    const shared = service.createSubAgent('session', { workspace: 'shared' }) as SubAgent;
    expect(remote.inherit).toHaveBeenCalledWith('session', one.id, 'isolated');
    expect(remote.inherit).toHaveBeenCalledWith('session', two.id, 'isolated');
    expect(remote.inherit).toHaveBeenCalledWith('session', shared.id, 'shared');
  });
  it('prepares before model execution and returns the retained worktree after automatic task destruction', async () => {
    const agent = service.createSubAgent('session', { task: 'task' }) as SubAgent;
    const result = await service.executeSync(agent.id);
    expect(result).toMatchObject({
      success: true,
      remoteWorkspace: { root: '/worktrees/' + agent.id },
    });
    expect(llm.chatSync.mock.calls[0][0].messages[0].content).toContain('/worktrees/' + agent.id);
    expect(remote.release).toHaveBeenCalledWith(agent.id);
  });
  it('nested subagent_execute keeps isolation and returns its worktree to the parent', async () => {
    const parent = service.createSubAgent('session', {
      task: 'parent',
      inheritTools: true,
      autoDestroy: false,
    }) as SubAgent;
    await remote.prepareChild(parent.id);
    const result = await (service as any).executeSubAgentTool(
      'subagent_execute',
      JSON.stringify({ task: 'nested' }),
      parent.id,
    );
    expect(result.success).toBe(true);
    expect(result.remoteWorkspace.root).not.toBe(prepared.get(parent.id).root);
    expect(remote.inherit.mock.calls.at(-1)?.[2]).toBe('isolated');
  });
  it('confirmed retry of an interrupted worktree requests a new isolated workspace', () => {
    const old = service.createSubAgent('session', { task: 'old', autoDestroy: false }) as SubAgent;
    old.workspace = '/worktrees/old';
    old.remoteWorkspace = {
      ...source,
      transport: 'ssh',
      root: old.workspace,
      worktree: {
        token: 'old',
        sourceId: 'source',
        baseHead: 'base',
        checkout: old.workspace,
        childSessionId: old.id,
      },
    };
    (service as any).history.set(old.id, { ...old, recovery: 'interrupted' });
    const create = jest.spyOn(service, 'createSubAgent');
    jest.spyOn(service, 'executeAsync').mockImplementation(() => {});
    expect(service.retryInterrupted(old.id, true).success).toBe(true);
    expect(create.mock.calls[0][1].workspace).toBe('isolated');
  });
  it('the installed subagent tool exposes explicit sharing and returns remote result locations', async () => {
    const tool = createSessionAgentTools(((type: any) =>
      type === AgentSwarmService ? service : undefined) as any).find(
      (t) => t.name === 'subagent_execute',
    )!;
    const result = await tool.execute(
      { task: 'built-in' },
      { sessionId: 'session', workspace: '/work', config: {}, log() {}, broadcast() {} },
    );
    expect(result.success).toBe(true);
    expect((result.data as any).remoteWorkspace.root).toContain('/worktrees/');
    expect(remote.inherit.mock.calls.at(-1)?.[2]).toBe('isolated');
    await tool.execute(
      { task: 'shared', workspace: 'shared' },
      { sessionId: 'session', workspace: '/work', config: {}, log() {}, broadcast() {} },
    );
    expect(remote.inherit.mock.calls.at(-1)?.[2]).toBe('shared');
  });
});
