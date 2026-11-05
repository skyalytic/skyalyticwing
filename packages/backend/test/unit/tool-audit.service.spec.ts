// ToolAuditService 测试：tool.executed 事件消费（经 EventEmitter2 派发）→ 审计日志 + 统计聚合
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ToolAuditService } from '../../src/modules/monitor/tool-audit.service.js';
import { LoggerService } from '../../src/modules/core/logger/logger.service.js';

describe('ToolAuditService', () => {
  let emitter: EventEmitter2;
  let service: ToolAuditService;
  let loggerDebug: jest.Mock;

  beforeEach(() => {
    loggerDebug = jest.fn();
    const logger = { debug: loggerDebug } as unknown as LoggerService;
    service = new ToolAuditService(logger);
    emitter = new EventEmitter2();
    // 模拟 NestJS @OnEvent 装饰器在模块初始化时的监听注册
    emitter.on('tool.executed', (e) => service.onToolExecuted(e));
  });

  it('事件派发后被消费：写结构化审计日志（tool/sessionId/durationMs/success）', () => {
    emitter.emit('tool.executed', {
      tool: 'bash',
      sessionId: 'sess-1',
      durationMs: 120,
      success: true,
    });

    expect(loggerDebug).toHaveBeenCalledTimes(1);
    expect(loggerDebug).toHaveBeenCalledWith('tool.executed', {
      scope: 'tool-audit',
      tool: 'bash',
      sessionId: 'sess-1',
      durationMs: 120,
      success: true,
    });
    expect(service.getLastEvent()).toEqual({
      tool: 'bash',
      sessionId: 'sess-1',
      durationMs: 120,
      success: true,
    });
  });

  it('按工具聚合执行次数 / 失败次数 / 累计耗时', () => {
    emitter.emit('tool.executed', { tool: 'file_read', sessionId: 's1', durationMs: 30, success: true });
    emitter.emit('tool.executed', { tool: 'file_read', sessionId: 's2', durationMs: 50, success: false });
    emitter.emit('tool.executed', { tool: 'bash', sessionId: 's3', durationMs: 200, success: true });

    const stats = service.getToolStats();
    expect(stats['file_read']).toEqual({ executions: 2, failures: 1, totalDurationMs: 80 });
    expect(stats['bash']).toEqual({ executions: 1, failures: 0, totalDurationMs: 200 });
  });

  it('durationMs 缺省按 0 计入累计', () => {
    emitter.emit('tool.executed', { tool: 'notify', sessionId: undefined, durationMs: 0, success: true });
    expect(service.getToolStats()['notify']).toEqual({
      executions: 1,
      failures: 0,
      totalDurationMs: 0,
    });
  });
});
