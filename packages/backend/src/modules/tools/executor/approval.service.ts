import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { ChatControlRegistry } from '../../ai/chat/chat-control.registry.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolApprovalRequest, ToolApprovalResponse } from '@skyalyticwing/shared';
import { LoggerService } from '../../core/logger/logger.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { ConfigService } from '../../core/config/config.service.js';
import { CommandGuardService } from '../../core/security/command-guard.service.js';
import { getDefaultDataDir, resolveWebDataDir } from '../../core/utils/web-data.util.js';
import { extractCommandText, isCommandTool, toCommandRulePattern } from './command-gate.util.js';
import { accessMode, toolAccess } from './tool-access.js';

/** 审批等待超时（毫秒），AgentLoopService 审批等待统一由本服务承担 */
const APPROVAL_TIMEOUT_MS = 120_000;

/** 审批事件名前缀 */
const APPROVAL_REQUEST_EVENT = 'approval.request';
const APPROVAL_RESPONSE_EVENT_PREFIX = 'approval.response.';

/** 审批决策类型（4 种，对齐旧版 start.cjs） */
export type ApprovalDecisionType = 'allow-once' | 'allow-always' | 'denied' | 'deny-always';

/** 审批历史记录条目 */
export interface ApprovalHistoryEntry {
  id: string;
  toolName: string;
  tool?: string | undefined;
  args?: unknown;
  sessionId?: string | undefined;
  /** 决策类型（旧版迁移的历史 pending 项可能尚无决策） */
  decision?: ApprovalDecisionType | undefined;
  reason?: string | undefined;
  status: string;
  createdAt: number;
  resolvedAt: number;
}

/** 待处理审批的内部追踪记录 */
interface PendingApproval {
  request: ToolApprovalRequest;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

/**
 * ApprovalService - 工具审批流程服务
 *
 * 实现 ask 模式下的完整审批流程：
 *   1. 接收工具执行请求 → 创建审批（生成唯一 ID）
 *   2. 通过 EventEmitter2 发送审批请求事件（approval.request.<id>）
 *   3. 通过 WebSocketService 广播审批请求给前端用户
 *   4. 等待用户批准/拒绝（resolveApproval 由 WebSocket 网关调用）
 *   5. 超时（120s）视为拒绝
 *   6. 返回审批结果，调用方据此执行或取消工具
 *
 * 设计：每个审批请求对应一个 Promise，通过 EventEmitter2 once 监听响应事件。
 * WebSocket 网关收到用户审批响应后，应调用 respondApproval() 触发事件解除等待。
 */
@Injectable()
export class ApprovalService implements OnModuleInit {
  /** 待处理审批映射：approvalId → PendingApproval */
  private readonly pending = new Map<string, PendingApproval>();

  /** 审批历史记录（最多 1000 条，对外暴露最近 50 条） */
  private readonly history: ApprovalHistoryEntry[] = [];
  private static readonly HISTORY_MAX = 1000;
  private static readonly HISTORY_EXPOSE_LIMIT = 50;

  constructor(
    private readonly events: EventEmitter2,
    private readonly ws: WebSocketService,
    private readonly logger: LoggerService,
    private readonly commandGuard: CommandGuardService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.loadLegacyApprovals();
  }

  /**
   * 启动时从旧版 approvals.json（用户数据目录优先，回退 packages/web/data）
   * 恢复历史审批记录（含历史 pending 项，重启后已无法继续等待，仅作历史保留）。
   * 幂等：按 id 去重，已有记录不覆盖。
   */
  private loadLegacyApprovals(): void {
    const candidates = [join(getDefaultDataDir(), 'approvals.json'), join(resolveWebDataDir(), 'approvals.json')];
    let raw: unknown = null;
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        raw = JSON.parse(readFileSync(p, 'utf-8'));
        break;
      } catch {
        // 解析失败尝试下一个候选
      }
    }
    if (!raw) return;

    // 归一化为条目列表：数组 / { pending, history } / { id→entry } 映射
    let entries: unknown[];
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      entries = [
        ...(Array.isArray(obj['pending']) ? obj['pending'] : []),
        ...(Array.isArray(obj['history']) ? obj['history'] : []),
      ];
      if (entries.length === 0) entries = Object.values(obj);
    } else {
      return;
    }

    const existingIds = new Set(this.history.map((e) => e.id));
    let restored = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      const id = typeof rec['approvalId'] === 'string' ? rec['approvalId']
        : typeof rec['id'] === 'string' ? rec['id']
        : `legacy-approval-${i}`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      const toolName = typeof rec['toolName'] === 'string' ? rec['toolName']
        : typeof rec['tool'] === 'string' ? rec['tool']
        : 'unknown';
      const status = typeof rec['status'] === 'string' ? rec['status'] : 'pending';
      this.history.push({
        id,
        toolName,
        tool: toolName,
        args: rec['args'],
        sessionId: typeof rec['sessionId'] === 'string' ? rec['sessionId'] : undefined,
        decision: (typeof rec['decision'] === 'string' ? rec['decision'] : undefined) as ApprovalDecisionType,
        reason: typeof rec['reason'] === 'string' ? rec['reason'] : undefined,
        status,
        createdAt: typeof rec['createdAt'] === 'number' ? rec['createdAt'] : Date.now(),
        resolvedAt: typeof rec['resolvedAt'] === 'number' ? rec['resolvedAt']
          : typeof rec['createdAt'] === 'number' ? rec['createdAt'] : Date.now(),
      });
      restored++;
    }

    if (this.history.length > ApprovalService.HISTORY_MAX) {
      this.history.splice(0, this.history.length - ApprovalService.HISTORY_MAX);
    }
    if (restored > 0) {
      this.logger.info('ApprovalService: restored legacy approvals', { restored, scope: 'approval' });
    }
  }

  /**
   * 发起审批请求并等待用户响应。
   *
   * @param request 审批请求（id 可选，未提供时自动生成）
   * @returns 用户是否批准；超时或拒绝返回 false
   */
  async requestApproval(request: ToolApprovalRequest): Promise<boolean> {
    // Re-read at the last gate, including automatic jobs and a mode switch in flight.
    if (accessMode(this.config) === 'yolo') return this.currentAccess(request).action === 'pass';
    // 确保有唯一 ID
    if (!request.id) request.id = randomUUID();
    const approvalId = request.id;

    this.logger.info('Approval request created, waiting for user response', {
      scope: 'approval',
      approvalId,
      toolName: request.toolName,
      sessionId: request.sessionId,
    });

    return new Promise<boolean>((resolve) => {
      let unsubscribe = () => {};
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.pending.delete(approvalId);
        this.events.removeAllListeners(APPROVAL_RESPONSE_EVENT_PREFIX + approvalId);
        this.ws.broadcast({ type: 'approval_resolved', data: { id: approvalId, approved } });
        resolve(approved);
      };
      const timer = setTimeout(() => {
        // 超时：清理并视为拒绝
        this.pending.delete(approvalId);
        this.events.removeAllListeners(APPROVAL_RESPONSE_EVENT_PREFIX + approvalId);
        this.logger.warn('Approval request timed out', {
          scope: 'approval',
          approvalId,
          toolName: request.toolName,
        });
        finish(false);
      }, APPROVAL_TIMEOUT_MS);

      // 记录待处理审批
      this.pending.set(approvalId, {
        request,
        resolve: finish,
        timer,
        createdAt: Date.now(),
      });

      // 监听该审批的响应事件
      this.events.once(
        APPROVAL_RESPONSE_EVENT_PREFIX + approvalId,
        (resp: ToolApprovalResponse) => {
          if (resp && resp.id === approvalId) {
            clearTimeout(timer);
            this.pending.delete(approvalId);
            finish(resp.approved);
          }
        },
      );
      unsubscribe = ChatControlRegistry.onAbort((sessionId) => {
        if (!sessionId || sessionId === request.sessionId) finish(false);
      });
      // Publish only after pending state and the response listener are installed.
      this.events.emit(APPROVAL_REQUEST_EVENT, request);
      this.ws.broadcast({ type: 'approval_request', data: request });
    });
  }

  /**
   * 处理用户审批响应（由 WebSocket 网关在收到用户操作后调用）。
   *
   * 通过 EventEmitter2 派发响应事件，解除 requestApproval 中的 Promise 等待。
   *
   * @param response 用户审批响应
   */
  approvePendingForFullAccess(): void {
    if (accessMode(this.config) !== 'yolo') return;
    for (const [id, pending] of [...this.pending]) {
      const access = this.currentAccess(pending.request);
      this.respondApprovalWithDecision(id, access.action === 'pass' ? 'allow-once' : 'denied',
        access.action === 'pass' ? '用户切换到完全访问' : access.reason);
    }
  }

  private currentAccess(request: ToolApprovalRequest) {
    return toolAccess({ config: this.config, name: request.toolName, args: request.args,
      sessionId: request.sessionId, dangerous: true, commandGuard: this.commandGuard });
  }

  notifyPermissionsChanged(): void {
    const data = { approvalId: '', decision: 'settings-changed' };
    this.ws.broadcast({ type: 'tools_refresh', data });
    this.ws.broadcast({ type: 'permissions_refresh', data });
  }

  respondApproval(response: ToolApprovalResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.logger.warn('Approval response received for unknown/expired request', {
        scope: 'approval',
        approvalId: response.id,
      });
      return;
    }

    this.logger.info('Approval response received', {
      scope: 'approval',
      approvalId: response.id,
      approved: response.approved,
      reason: response.reason,
    });

    // 派发响应事件，解除 requestApproval 中的 once 监听
    this.events.emit(APPROVAL_RESPONSE_EVENT_PREFIX + response.id, response);
  }

  /**
   * 取消指定审批（用于会话中止等场景）。
   *
   * @param approvalId 审批 ID
   * @param reason 取消原因
   */
  cancelApproval(approvalId: string, reason?: string): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    this.events.removeAllListeners(APPROVAL_RESPONSE_EVENT_PREFIX + approvalId);

    this.logger.info('Approval cancelled', {
      scope: 'approval',
      approvalId,
      reason: reason ?? 'cancelled',
    });

    // 视为拒绝
    pending.resolve(false);
  }

  /**
   * 取消指定会话的所有待处理审批。
   *
   * @param sessionId 会话 ID
   */
  cancelSessionApprovals(sessionId: string): void {
    const toCancel: string[] = [];
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId === sessionId) {
        toCancel.push(id);
      }
    }
    for (const id of toCancel) {
      this.cancelApproval(id, 'session cancelled');
    }
  }

  /** 获取所有待处理审批（诊断用） */
  getPendingApprovals(): ToolApprovalRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  // ===========================================================================
  // 扩展：4 种决策支持（allow-once / allow-always / denied / deny-always）
  // ===========================================================================

  /**
   * 使用 4 种决策响应审批（对齐旧版 start.cjs /approvals/:id 路由）。
   *
   * 决策映射：
   *   - allow-once   → approved=true（批准本次）
   *   - allow-always → approved=true（批准并创建持久规则，由调用方写入 permissions.rules）
   *   - denied       → approved=false（拒绝本次）
   *   - deny-always  → approved=false（拒绝并创建持久规则）
   *
   * 同时记录历史并广播 tools/permissions 刷新事件。
   *
   * @param id 审批 ID
   * @param decision 决策类型
   * @param reason 可选原因
   * @returns 处理结果
   */
  respondApprovalWithDecision(
    id: string,
    decision: ApprovalDecisionType,
    reason?: string,
  ): { success: boolean; reason?: string } {
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger.warn('Approval decision received for unknown/expired request', {
        scope: 'approval',
        approvalId: id,
        decision,
      });
      return { success: false, reason: 'Approval not found or expired' };
    }

    const approved = decision === 'allow-once' || decision === 'allow-always';
    const status = approved
      ? (decision === 'allow-always' ? 'approved-always' : 'approved-once')
      : (decision === 'deny-always' ? 'denied-always' : 'denied');

    this.logger.info('Approval decision processed', {
      scope: 'approval',
      approvalId: id,
      decision,
      approved,
      reason,
    });

    // 记录历史
    this.recordHistory(pending.request, decision, status, reason);

    // "始终"决策落规则（与用户确认的两层闸门联动设计）：
    //   命令类工具 → 写命令白名单/黑名单（CommandGuard，任何模式生效）
    //   普通工具   → 写工具策略（始终允许→自动；始终拒绝→禁止）
    if (decision === 'allow-always' || decision === 'deny-always') {
      this.persistAlwaysDecision(pending.request, decision === 'allow-always');
    }

    // 通过 EventEmitter2 派发响应事件，解除 requestApproval 中的 once 监听
    const response: ToolApprovalResponse = { id, approved, ...(reason !== undefined ? { reason } : {}) };
    this.events.emit(APPROVAL_RESPONSE_EVENT_PREFIX + id, response);

    // 广播 tools 和 permissions 刷新事件（对齐旧版前端审批后刷新逻辑）
    this.ws.broadcast({ type: 'tools_refresh', data: { approvalId: id, decision } });
    this.ws.broadcast({ type: 'permissions_refresh', data: { approvalId: id, decision } });

    return { success: true };
  }

  /**
   * "始终允许/始终拒绝"决策的规则落盘（两层闸门联动）。
   *
   * 命令类工具（bash/powershell/python/node 等）：
   *   always-allow → 命令加入白名单（CommandGuard allow 规则，任何模式免审批）
   *   always-deny  → 命令加入黑名单（CommandGuard deny 规则，任何模式拒绝）
   *   规则粒度：包管理器/复合命令取前两词（如 "pip install *"），其余取首词
   * 普通工具：
   *   always-allow → 工具策略置为自动（tools.toolSettings[name].permission='auto'）
   *   always-deny  → 工具策略置为禁止（tools.toolSettings[name].disabled=true）
   */
  private persistAlwaysDecision(request: ToolApprovalRequest, allow: boolean): void {
    try {
      if (isCommandTool(request.toolName)) {
        const cmd = extractCommandText(request.toolName, request.args);
        const pattern = cmd ? toCommandRulePattern(cmd) : '';
        if (pattern) {
          this.commandGuard.addCommandRule(
            allow ? 'allow' : 'deny',
            pattern,
            allow ? '审批"始终允许"自动创建' : '审批"始终拒绝"自动创建',
          );
          this.logger.info('Approval always-decision persisted as command rule', {
            scope: 'approval',
            toolName: request.toolName,
            pattern,
            allow,
          });
          return;
        }
      }

      // 非命令工具（或命令文本无法提取）：写工具策略。
      // 防御：config 无 tools 段时 get() 抛 ConfigError，此处需兜底空对象——
      // 否则"始终允许"的 toolSettings 写入被外层 catch 静默吞掉（历史 bug：
      // WS 通道审批从未生效的根因），permissionRules 与 toolSettings 双写双丢。
      let tools: Record<string, unknown>;
      try {
        tools = (this.config.get<Record<string, unknown>>('tools') ?? {}) as Record<string, unknown>;
      } catch {
        tools = {};
      }
      const previous = tools;
      tools = { ...tools };
      const toolSettings = { ...((tools['toolSettings'] ?? {}) as Record<string, unknown>) };
      const cfg = {
        ...((toolSettings[request.toolName] ?? {}) as Record<string, unknown>),
      };
      if (allow) {
        cfg['permission'] = 'auto';
        cfg['disabled'] = false;
      } else {
        cfg['disabled'] = true;
      }
      toolSettings[request.toolName] = cfg;
      tools['toolSettings'] = toolSettings;
      this.config.set('tools', tools);
      try { this.config.save(); }
      catch (error) { this.config.set('tools', previous); throw error; }
      this.logger.info('Approval always-decision persisted as tool setting', {
        scope: 'approval',
        toolName: request.toolName,
        allow,
      });
    } catch (err) {
      // 规则落盘失败不影响审批响应本身（本次决策仍生效，下次同类调用会再次审批）
      this.logger.warn('Failed to persist always-decision rule', {
        scope: 'approval',
        toolName: request.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 获取审批历史记录（最近 50 条，逆序）。
   */
  getApprovalHistory(): ApprovalHistoryEntry[] {
    return this.history.slice(-ApprovalService.HISTORY_EXPOSE_LIMIT).reverse();
  }

  /**
   * 清空审批历史记录（审计日志 clear 的真实实现）。
   * history 为纯内存结构（启动时从旧版 approvals.json 恢复，不回写），
   * 清空后需重启才会从磁盘重新加载。
   *
   * @returns 清除的条数
   */
  clearHistory(): { cleared: number } {
    const cleared = this.history.length;
    this.history.length = 0;
    this.logger.info('Approval history cleared', { scope: 'approval', cleared });
    return { cleared };
  }

  /**
   * 删除单条审批历史记录（审计日志单条删除的真实实现）。
   *
   * @param id 审批/审计条目 ID
   * @returns 是否删除成功（条目不存在返回 false）
   */
  deleteHistoryEntry(id: string): boolean {
    const index = this.history.findIndex((e) => e.id === id);
    if (index < 0) return false;
    this.history.splice(index, 1);
    this.logger.info('Approval history entry deleted', { scope: 'approval', id });
    return true;
  }

  /** 记录审批历史 */
  private recordHistory(
    request: ToolApprovalRequest,
    decision: ApprovalDecisionType,
    status: string,
    reason?: string,
  ): void {
    const entry: ApprovalHistoryEntry = {
      id: request.id,
      toolName: request.toolName,
      tool: request.toolName,
      args: request.args,
      sessionId: request.sessionId,
      decision,
      reason: reason ?? request.reason,
      status,
      createdAt: request.timestamp,
      resolvedAt: Date.now(),
    };
    this.history.push(entry);
    if (this.history.length > ApprovalService.HISTORY_MAX) {
      this.history.splice(0, this.history.length - ApprovalService.HISTORY_MAX);
    }
  }
}
