import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ToolApprovalRequest } from '@skyalyticwing/shared';
import { ApprovalService } from '../../src/modules/tools/executor/approval.service.js';
import type { WebSocketService } from '../../src/modules/core/websocket/websocket.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { CommandGuardService } from '../../src/modules/core/security/command-guard.service.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
} as unknown as LoggerService;

/** WebSocketService mock */
const wsMock = { broadcast: jest.fn() } as unknown as WebSocketService;

/** CommandGuardService mock（本测试不触达命令校验逻辑） */
const commandGuardMock = {
  isCommandAllowed: () => true,
  isCommandWhitelisted: () => false,
  isCommandBlacklisted: () => false,
} as unknown as CommandGuardService;

/** ConfigService mock（security 段为空对象） */
const configMock = {
  get: (_section: string) => ({}),
} as unknown as ConfigService;

function makeService(): ApprovalService {
  return new ApprovalService(new EventEmitter2(), wsMock, loggerMock, commandGuardMock, configMock);
}

/** 发起一次审批并立即以指定决策响应，用于在 history 中产生一条记录 */
async function settleApproval(
  service: ApprovalService,
  id: string,
  decision: 'allow-once' | 'denied',
): Promise<void> {
  const request: ToolApprovalRequest = {
    id,
    toolName: 'read_file',
    args: { path: '/tmp/x' },
    sessionId: 'session-test',
    reason: '',
    timestamp: Date.now(),
  };
  const waiting = service.requestApproval(request);
  service.respondApprovalWithDecision(id, decision);
  await waiting;
}

describe('ApprovalService clearHistory/deleteHistoryEntry（POST /api/permissions/audit/* 后端逻辑）', () => {
  it('clearHistory 清空全部历史并返回清除条数', async () => {
    const service = makeService();
    await settleApproval(service, 'approval-1', 'allow-once');
    await settleApproval(service, 'approval-2', 'denied');
    expect(service.getApprovalHistory()).toHaveLength(2);

    const { cleared } = service.clearHistory();
    expect(cleared).toBe(2);
    expect(service.getApprovalHistory()).toHaveLength(0);
  });

  it('deleteHistoryEntry 按 id 删除单条记录', async () => {
    const service = makeService();
    await settleApproval(service, 'approval-3', 'allow-once');
    await settleApproval(service, 'approval-4', 'denied');

    expect(service.deleteHistoryEntry('approval-3')).toBe(true);
    const rest = service.getApprovalHistory();
    expect(rest).toHaveLength(1);
    expect(rest[0]!.id).toBe('approval-4');
  });

  it('deleteHistoryEntry 删除不存在的 id 返回 false', async () => {
    const service = makeService();
    await settleApproval(service, 'approval-5', 'allow-once');
    expect(service.deleteHistoryEntry('missing-id')).toBe(false);
    expect(service.getApprovalHistory()).toHaveLength(1);
  });
});
