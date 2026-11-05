import 'reflect-metadata';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../../src/modules/ai/agent/agent.service.js';
import type { AgentInfo, AgentMemory } from '../../src/modules/ai/types.js';

describe('AgentService', () => {
  let service: AgentService;
  let nowMs: number;
  let dateNowSpy: jest.SpyInstance;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'wing-agent-unit-'));
    service = new AgentService();
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = previousDataDir;
    dateNowSpy.mockRestore();
  });

  describe('Agent CRUD', () => {
    it('createAgent 创建并返回完整 AgentInfo', () => {
      const agent = service.createAgent({
        name: 'coder',
        model: 'gpt-4o',
        description: '写代码',
        systemPrompt: '你是码农',
        tools: ['file-read', 'bash'],
      });

      expect(agent.id).toBeTruthy();
      expect(agent).toMatchObject({
        name: 'coder',
        model: 'gpt-4o',
        description: '写代码',
        systemPrompt: '你是码农',
        tools: ['file-read', 'bash'],
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      expect(service.getAgent(agent.id)).toEqual(agent);
    });

    it('createAgent 缺 name 抛错；model 可缺省（对齐旧版 /agents/save）', () => {
      expect(() => service.createAgent({ name: '', model: 'gpt-4o' })).toThrow(
        'createAgent requires name',
      );
      // model 允许为空：代理中心创建后可再配置模型（旧版行为）
      const noModel = service.createAgent({ name: 'a', model: '' });
      expect(noModel.model).toBe('');
    });

    it('可选字段缺省时使用空默认值', () => {
      const agent = service.createAgent({ name: 'a', model: 'm' });
      expect(agent.description).toBe('');
      expect(agent.systemPrompt).toBe('');
      expect(agent.tools).toEqual([]);
    });

    it('listAgents 返回全部创建的 Agent', () => {
      service.createAgent({ name: 'a1', model: 'm' });
      service.createAgent({ name: 'a2', model: 'm' });
      expect(service.listAgents().map((a) => a.name)).toEqual(['a1', 'a2']);
    });

    it('getAgent 不存在时抛错', () => {
      expect(() => service.getAgent('no-such')).toThrow("Agent 'no-such' not found");
    });

    it('updateAgent 更新指定字段并刷新 updatedAt', () => {
      const agent = service.createAgent({ name: 'old', model: 'm1', tools: ['t1'] });
      nowMs += 5_000;

      const updated = service.updateAgent(agent.id, {
        name: 'new',
        model: 'm2',
        tools: ['t1', 't2'],
      });

      expect(updated).toMatchObject({ name: 'new', model: 'm2', tools: ['t1', 't2'] });
      expect(updated.updatedAt).toBe(nowMs);
      expect(service.getAgent(agent.id)).toEqual(updated);
    });

    it('updateAgent 未提供的字段保持不变', () => {
      const agent = service.createAgent({
        name: 'a',
        model: 'm',
        description: 'keep-me',
        systemPrompt: 'keep-prompt',
      });

      const updated = service.updateAgent(agent.id, { name: 'renamed' });

      expect(updated.description).toBe('keep-me');
      expect(updated.systemPrompt).toBe('keep-prompt');
      expect(updated.model).toBe('m');
    });

    it('updateAgent 不存在时抛错', () => {
      expect(() => service.updateAgent('no-such', { name: 'x' })).toThrow(
        "Agent 'no-such' not found",
      );
    });

    it('deleteAgent 删除后不可查询', () => {
      const agent = service.createAgent({ name: 'a', model: 'm' });
      service.deleteAgent(agent.id);
      expect(service.listAgents()).toHaveLength(0);
      expect(() => service.getAgent(agent.id)).toThrow(/not found/);
    });
  });

  describe('Agent 记忆', () => {
    it('未设置记忆时返回空记忆结构', () => {
      const mem = service.getMemory('agent-x');
      expect(mem).toEqual({ agentId: 'agent-x', facts: [], lastUpdated: 0 });
    });

    it('setMemory 保存并强制归属 agentId 与 lastUpdated', () => {
      const agent = service.createAgent({ name: 'a', model: 'm' });
      nowMs += 1_000;

      const input: AgentMemory = { agentId: 'forged', facts: ['喜欢简洁代码'], lastUpdated: 1 };
      service.setMemory(agent.id, input);

      const mem = service.getMemory(agent.id);
      expect(mem.agentId).toBe(agent.id);
      expect(mem.facts).toEqual(['喜欢简洁代码']);
      expect(mem.lastUpdated).toBe(nowMs);
      expect(existsSync(join(process.env['SKYALYTICWING_DATA_DIR']!, 'agent-memories.json'))).toBe(false);
    });

    it('deleteAgent 同时清除其记忆', () => {
      const agent = service.createAgent({ name: 'a', model: 'm' });
      service.setMemory(agent.id, { agentId: agent.id, facts: ['f1'], lastUpdated: 1 });

      service.deleteAgent(agent.id);

      expect(service.getMemory(agent.id)).toEqual({
        agentId: agent.id,
        facts: [],
        lastUpdated: 0,
      });
    });
  });
});
