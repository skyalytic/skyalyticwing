import 'reflect-metadata';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApprovalService } from '../../src/modules/tools/executor/approval.service.js';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry.js';

describe('approval delivery and cancellation', () => {
  const request = (id: string, sessionId = 'own') => ({
    id,
    sessionId,
    toolName: 'write_file',
    args: { path: 'fixture' },
    reason: 'test',
    timestamp: Date.now(),
  });
  function setup() {
    const events = new EventEmitter2(),
      ws = { broadcast: jest.fn() };
    const service = new ApprovalService(
      events,
      ws as never,
      { info: jest.fn(), warn: jest.fn() } as never,
      {} as never,
      { get: () => ({}) } as never,
    );
    return { service, ws };
  }
  it('can approve synchronously upon receiving the notification', async () => {
    const { service, ws } = setup();
    ws.broadcast.mockImplementation((event: any) => {
      if (event.type === 'approval_request')
        service.respondApprovalWithDecision(event.data.id, 'allow-once');
    });
    await expect(service.requestApproval(request('fast'))).resolves.toBe(true);
    expect(service.getPendingApprovals()).toHaveLength(0);
    expect(ws.broadcast.mock.calls.filter(([event]) => event.type === 'approval_resolved')).toEqual([[{ type: 'approval_resolved', data: { id: 'fast', approved: true } }]]);
  });
  it('notifies every approval surface when a request expires; late answers cannot reapprove it', async () => {
    jest.useFakeTimers();
    try {
      const { service, ws } = setup();
      const pending = service.requestApproval(request('expired'));
      jest.advanceTimersByTime(120_001);
      await expect(pending).resolves.toBe(false);
      service.respondApprovalWithDecision('expired', 'allow-once');
      expect(ws.broadcast.mock.calls.filter(([event]) => event.type === 'approval_resolved')).toEqual([[{ type: 'approval_resolved', data: { id: 'expired', approved: false } }]]);
    } finally { jest.useRealTimers(); }
  });
  it('cancels pending approval only for the requested session', async () => {
    const { service } = setup();
    const own = service.requestApproval(request('own-request'));
    const other = service.requestApproval(request('other-request', 'other'));
    ChatControlRegistry.requestAbort('own');
    await expect(own).resolves.toBe(false);
    expect(service.getPendingApprovals().map((p) => p.id)).toEqual(['other-request']);
    service.respondApprovalWithDecision('other-request', 'denied');
    await other;
    ChatControlRegistry.clearAbort('own');
  });
});
