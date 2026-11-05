import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindingService } from '../../src/modules/channels/binding.service.js';
import type { Binding, BindingContext } from '../../src/modules/channels/binding.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

describe('BindingService', () => {
  let service: BindingService;
  let dataDir: string;
  let nowMs: number;
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), 'binding-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
    nowMs = 1_700_000_000_000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    service = new BindingService(loggerMock);
    service.onModuleInit();
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    delete process.env['SKYALYTICWING_DATA_DIR'];
  });

  const add = (agentId: string, match: Binding['match']): Binding =>
    service.addBinding({ agentId, match });

  describe('8 层优先级匹配', () => {
    it('无任何绑定时返回默认 agent', () => {
      const res = service.resolve({ channel: 'dingtalk', peerId: 'u1' });
      expect(res).toMatchObject({ agentId: 'main', matchedBy: 'default', binding: null });
    });

    it('自定义 defaultAgent 生效', () => {
      const res = service.resolve({ channel: 'dingtalk' }, 'fallback-agent');
      expect(res.agentId).toBe('fallback-agent');
    });

    it('L1 精确对端（peer.id + peer.kind）优先级 80', () => {
      add('peer-agent', { peer: { id: 'u1', kind: 'user' } });

      const res = service.resolve({ peerId: 'u1', peerKind: 'user' });
      expect(res.agentId).toBe('peer-agent');
      expect(res.matchedBy).toBe('binding(priority=80)');
    });

    it('精确对端要求 kind 也匹配（kind 不匹配则该规则不命中）', () => {
      add('peer-agent', { peer: { id: 'u1', kind: 'user' } });

      const res = service.resolve({ peerId: 'u1', peerKind: 'group' });
      expect(res.matchedBy).toBe('default');
    });

    it('L2 通配对端（peer.kind="*"）优先级 50', () => {
      add('wild-peer-agent', { peer: { kind: '*' } });

      const res = service.resolve({ peerId: 'u1', peerKind: 'user' });
      expect(res.agentId).toBe('wild-peer-agent');
      expect(res.matchedBy).toBe('binding(priority=50)');
    });

    it('通配对端要求上下文存在 peerId（空对端不命中）', () => {
      add('wild-peer-agent', { peer: { kind: '*' } });

      const res = service.resolve({ channel: 'x' });
      expect(res.matchedBy).toBe('default');
    });

    it('L3 Guild + 角色匹配优先级 70', () => {
      add('guild-role-agent', { guildId: 'g1', roles: ['admin'] });

      const res = service.resolve({ guildId: 'g1', roles: ['admin', 'dev'] });
      expect(res.agentId).toBe('guild-role-agent');
      expect(res.matchedBy).toBe('binding(priority=70)');
    });

    it('L4 Guild 匹配（无 roles 约束）优先级 60', () => {
      add('guild-agent', { guildId: 'g1' });

      const res = service.resolve({ guildId: 'g1', roles: ['whatever'] });
      expect(res.agentId).toBe('guild-agent');
      expect(res.matchedBy).toBe('binding(priority=60)');
    });

    it('Guild 匹配但角色不相交时规则不命中', () => {
      add('guild-role-agent', { guildId: 'g1', roles: ['admin'] });

      const res = service.resolve({ guildId: 'g1', roles: ['viewer'] });
      expect(res.matchedBy).toBe('default');
    });

    it('L5 Team 匹配优先级 50', () => {
      add('team-agent', { teamId: 't1' });

      const res = service.resolve({ teamId: 't1' });
      expect(res.agentId).toBe('team-agent');
      expect(res.matchedBy).toBe('binding(priority=50)');
    });

    it('L6 Account 匹配优先级 40', () => {
      add('account-agent', { accountId: 'acc-1' });

      const res = service.resolve({ accountId: 'acc-1' });
      expect(res.agentId).toBe('account-agent');
      expect(res.matchedBy).toBe('binding(priority=40)');
    });

    it('L7 Channel 精确匹配优先级 30', () => {
      add('channel-agent', { channel: 'dingtalk' });

      const res = service.resolve({ channel: 'dingtalk' });
      expect(res.agentId).toBe('channel-agent');
      expect(res.matchedBy).toBe('binding(priority=30)');
    });

    it('L8 Channel 通配 "*" 优先级 10', () => {
      add('any-channel-agent', { channel: '*' });

      const res = service.resolve({ channel: 'wechat' });
      expect(res.agentId).toBe('any-channel-agent');
      expect(res.matchedBy).toBe('binding(priority=10)');
    });

    it('channel 不匹配（非精确非通配）时规则不命中', () => {
      add('channel-agent', { channel: 'dingtalk' });

      const res = service.resolve({ channel: 'feishu' });
      expect(res.matchedBy).toBe('default');
    });

    it('多条件累加：精确对端 + Channel 精确 = 110', () => {
      add('combo-agent', { peer: { id: 'u1', kind: 'user' }, channel: 'dingtalk' });

      const res = service.resolve({ peerId: 'u1', peerKind: 'user', channel: 'dingtalk' });
      expect(res.matchedBy).toBe('binding(priority=110)');
    });

    it('多规则竞争时取最高分：精确对端(80) 压过通配对端(50)', () => {
      add('wild-agent', { peer: { kind: '*' } });
      add('exact-agent', { peer: { id: 'u1', kind: 'user' } });

      const res = service.resolve({ peerId: 'u1', peerKind: 'user' });
      expect(res.agentId).toBe('exact-agent');
    });

    it('复合规则（Guild+Account=100）压过单一精确对端（80）', () => {
      add('peer-only', { peer: { id: 'u1', kind: 'user' } });
      add('guild-account', { guildId: 'g1', accountId: 'a1' });

      const ctx: BindingContext = {
        peerId: 'u1',
        peerKind: 'user',
        guildId: 'g1',
        accountId: 'a1',
      };
      const res = service.resolve(ctx);
      expect(res.agentId).toBe('guild-account');
      expect(res.matchedBy).toBe('binding(priority=100)');
    });
  });

  describe('addBinding', () => {
    it('生成默认 id / agentId 并记录创建时间', () => {
      const b = service.addBinding({ match: { channel: 'x' } });

      expect(b.id).toBe(`bind-${nowMs}`);
      expect(b.agentId).toBe('main');
      expect(b.createdAt).toBe(nowMs);
      expect(b.match).toEqual({ channel: 'x' });
    });

    it('兼容旧版扁平字段：折叠为 match 结构', () => {
      const b = service.addBinding({
        agentId: 'legacy',
        matchChannel: 'dingtalk',
        matchAccountId: 'acc-9',
        matchPeerId: 'u1',
        matchPeerKind: 'user',
        matchGuildId: 'g1',
        matchTeamId: 't1',
        matchRoles: ['admin'],
      });

      expect(b.match).toEqual({
        channel: 'dingtalk',
        accountId: 'acc-9',
        peer: { id: 'u1', kind: 'user' },
        guildId: 'g1',
        teamId: 't1',
        roles: ['admin'],
      });
    });

    it('扁平 matchPeerId 缺省 kind 时默认通配 *', () => {
      const b = service.addBinding({ matchPeerId: 'u1' });
      expect(b.match?.peer).toEqual({ id: 'u1', kind: '*' });
    });
  });

  describe('removeBinding / listBindings', () => {
    it('removeBinding 删除存在项返回 true，不存在返回 false', () => {
      const b = service.addBinding({ match: {} });

      expect(service.removeBinding(b.id)).toBe(true);
      expect(service.removeBinding(b.id)).toBe(false);
      expect(service.listBindings()).toHaveLength(0);
    });

    it('listBindings 返回全部绑定', () => {
      service.addBinding({ agentId: 'a', match: { channel: 'x' } });
      service.addBinding({ agentId: 'b', match: { channel: 'y' } });

      expect(service.listBindings().map((x) => x.agentId)).toEqual(['a', 'b']);
    });
  });

  describe('持久化', () => {
    it('新增绑定写入 bindings.json', () => {
      service.addBinding({ agentId: 'persisted', match: { channel: 'dingtalk' } });

      const file = join(dataDir, 'bindings.json');
      expect(existsSync(file)).toBe(true);

      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Binding[];
      expect(raw).toHaveLength(1);
      expect(raw[0]).toMatchObject({ agentId: 'persisted', match: { channel: 'dingtalk' } });
    });

    it('新实例 onModuleInit 从文件恢复绑定', () => {
      service.addBinding({ agentId: 'restored', match: { channel: 'dingtalk' } });

      const revived = new BindingService(loggerMock);
      revived.onModuleInit();

      expect(revived.listBindings().map((b) => b.agentId)).toEqual(['restored']);
      const res = revived.resolve({ channel: 'dingtalk' });
      expect(res.agentId).toBe('restored');
    });
  });
});
