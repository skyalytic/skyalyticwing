import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { AuditJournal } from './audit-journal.js';
import { OnEvent } from '@nestjs/event-emitter';
import { LoggerService } from '../core/logger/logger.service.js';

/** tool.executed 事件 payload（对齐 ToolExecutorService.emitToolExecuted，设计 §4.9） */
export interface ToolExecutedEvent {
  tool: string;
  sessionId?: string;
  durationMs: number;
  success: boolean;
}

/** 单工具累计统计 */
export interface ToolAuditStats {
  executions: number;
  failures: number;
  totalDurationMs: number;
}

/**
 * ToolAuditService - tool.executed 事件订阅者（审计 / 用量统计）
 *
 * ToolExecutorService 在每次工具真正进入执行阶段后发射 tool.executed；
 * 本服务消费该事件：
 *   1. 结构化审计日志（tool/sessionId/durationMs/success）——LoggerService
 *      暂无独立审计文件通道，落 debug 级结构化日志（进内存环形缓冲，可经
 *      GET /api/logs 查询）
 *   2. 按工具聚合执行次数 / 失败次数 / 累计耗时（getToolStats 供扩展使用）
 */
@Injectable()
export class ToolAuditService implements OnModuleInit {
  private journal?: AuditJournal;
  onModuleInit(): void {
    this.journal = new AuditJournal(join(getDefaultDataDir(), 'audit'));
  }
  recent(limit = 100) {
    return this.journal?.recent(limit) ?? [];
  }

  @OnEvent('tool.decision', { suppressErrors: false })
  onToolDecision(event: {
    tool: string;
    sessionId?: string;
    decision: string;
    policyVersion: string;
  }): void {
    this.journal?.append(event);
  }
  /** tool → 累计统计 */
  private readonly stats = new Map<string, ToolAuditStats>();
  /** 最近一次收到的事件（测试 / 诊断用） */
  private lastEvent: ToolExecutedEvent | null = null;

  constructor(private readonly logger: LoggerService) {}

  /** tool.executed 订阅者：审计日志 + 用量统计 */
  @OnEvent('tool.executed')
  onToolExecuted(event: ToolExecutedEvent): void {
    this.journal?.append({ ...event, decision: 'executed', policyVersion: 'workspace-policy-v2' });
    this.lastEvent = event;

    const s = this.stats.get(event.tool) ?? { executions: 0, failures: 0, totalDurationMs: 0 };
    s.executions += 1;
    if (!event.success) s.failures += 1;
    s.totalDurationMs += event.durationMs || 0;
    this.stats.set(event.tool, s);

    this.logger.debug('tool.executed', {
      scope: 'tool-audit',
      tool: event.tool,
      sessionId: event.sessionId,
      durationMs: event.durationMs,
      success: event.success,
    });
  }

  /** 按工具聚合的统计快照 */
  getToolStats(): Record<string, ToolAuditStats> {
    return Object.fromEntries(this.stats);
  }

  /** 最近一次事件 */
  getLastEvent(): ToolExecutedEvent | null {
    return this.lastEvent;
  }
}
