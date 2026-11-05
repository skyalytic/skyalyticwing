import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { ConfigService } from '../config/config.service.js';
import { LoggerService } from '../logger/logger.service.js';
import { ApprovalService } from '../../tools/executor/approval.service.js';
import { ApiTags } from '../swagger/swagger-decorators.js';
import { ProcessApprovalDto } from './dto/approval.dto.js';
import { ApprovalResolveCompatDto } from '../../tools/dto/mcporter.dto.js';

/**
 * ApprovalController - 审批管理 REST API（路由前缀 /api）
 *
 * 全量对齐旧版 start.cjs 中 /approvals 路由：
 *   GET  /api/approvals           - 待审批列表
 *   POST /api/approvals/resolve   - 处理审批（旧版路径兼容，body 携带 id）
 *   POST /api/approvals/:id       - 处理审批（4 种决策）
 *   GET  /api/approvals/history   - 审批历史（最近 50 条）
 *
 * 决策类型：
 *   - allow-once   : 批准本次
 *   - allow-always : 批准并创建持久规则（写入 permissions.rules）
 *   - denied       : 拒绝本次
 *   - deny-always  : 拒绝并创建持久规则
 *
 * 决策后通过 WebSocketService 广播 tools_refresh / permissions_refresh 事件，
 * 触发前端 /tools 和 /permissions 刷新（对齐旧版 approval.js 行为）。
 */
@ApiTags('Approvals')
@Controller()
export class ApprovalController {
  constructor(
    private readonly approvalService: ApprovalService,
    _config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  /** GET /approvals — 待审批列表 */
  @Get('approvals')
  listPending(): ApiResponse<Record<string, unknown>[]> {
    const pending = this.approvalService.getPendingApprovals();
    const approvals = pending.map((p) => ({
      id: p.id,
      tool: p.toolName,
      toolName: p.toolName,
      args: p.args,
      reason: p.reason,
      sessionId: p.sessionId,
      timestamp: p.timestamp,
      createdAt: p.timestamp,
    }));
    return { success: true, data: approvals };
  }

  /**
   * POST /approvals/resolve — 旧版路径兼容。
   *
   * body 携带 id / approvalId 与 decision（旧版允许 'approved' 等宽松值，
   * 此处映射为 4 种标准决策后转发到与 POST /approvals/:id 相同的处理逻辑）。
   */
  @Post('approvals/resolve')
  @HttpCode(HttpStatus.OK)
  resolveCompat(
    @Body() dto: ApprovalResolveCompatDto,
  ): ApiResponse<{ id: string; decision: string }> {
    const id = dto?.id || dto?.approvalId || '';
    const decision = this.mapCompatDecision(dto?.decision || '');
    if (!id || !decision) {
      return { success: false, error: 'id and decision required' };
    }
    return this.processApprovalInternal(id, decision, dto?.reason);
  }

  /** POST /approvals/:id — 处理审批（4 种决策） */
  @Post('approvals/:id')
  @HttpCode(HttpStatus.OK)
  processApproval(
    @Param('id') id: string,
    @Body() dto: ProcessApprovalDto,
  ): ApiResponse<{ id: string; decision: string }> {
    return this.processApprovalInternal(id, dto?.decision, dto?.reason);
  }

  /** GET /approvals/history — 审批历史（最近 50 条） */
  @Get('approvals/history')
  history(): ApiResponse<Record<string, unknown>> {
    const entries = this.approvalService.getApprovalHistory();
    return {
      success: true,
      data: {
        approvals: entries.map((e) => ({
          id: e.id,
          tool: e.tool ?? e.toolName,
          toolName: e.toolName,
          args: e.args,
          decision: e.decision,
          status: e.status,
          reason: e.reason,
          createdAt: e.createdAt,
          resolvedAt: e.resolvedAt,
        })),
      },
    };
  }

  // ─── 内部辅助方法 ──────────────────────────────────────────────────────────

  /**
   * 审批处理公共逻辑（POST /approvals/:id 与 POST /approvals/resolve 共用）。
   */
  private processApprovalInternal(
    id: string,
    decision: string,
    reason?: string,
  ): ApiResponse<{ id: string; decision: string }> {
    // 先获取待审批条目（用于持久规则创建）
    const pending = this.approvalService.getPendingApprovals();
    const entry = pending.find((p) => p.id === id);
    const toolName = entry?.toolName ?? '';

    // 调用扩展方法处理 4 种决策（内部记录历史并广播刷新事件）
    const result = this.approvalService.respondApprovalWithDecision(
      id,
      decision as 'allow-once' | 'allow-always' | 'denied' | 'deny-always',
      reason,
    );

    if (!result.success) {
      return { success: false, error: result.reason ?? 'Approval not found', code: 'NOT_FOUND' };
    }

    // ApprovalService persists the decision for both REST and WebSocket callers.

    this.logger.info('Approval processed', {
      scope: 'approval',
      approvalId: id,
      decision,
      toolName,
    });

    return { success: true, data: { id, decision } };
  }

  /**
   * 旧版宽松决策值映射为 4 种标准决策。
   * 'approved' / 'allow' → allow-once；无法识别时返回空串（由调用方报错）。
   */
  private mapCompatDecision(decision: string): string {
    const standard = ['allow-once', 'allow-always', 'denied', 'deny-always'];
    if (standard.includes(decision)) return decision;
    if (decision === 'approved' || decision === 'allow') return 'allow-once';
    if (decision === 'deny') return 'denied';
    return '';
  }

}
