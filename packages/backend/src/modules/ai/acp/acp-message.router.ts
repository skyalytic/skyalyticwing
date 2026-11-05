import { Injectable } from '@nestjs/common';
import { LoggerService } from '../../core/logger/logger.service.js';
import { AcpSessionService } from './acp-session.service.js';

/**
 * AcpMessageRouter (ACP 消息路由) - NestJS TypeScript 重写
 *
 * 移植自 packages/web/acp-manager.cjs 的 _handleStdioMessage（第 193-298 行）。
 *
 * 核心能力：
 *   - JSON-RPC 2.0 风格消息路由
 *   - 支持方法：initialize / new_session / load_session / run_turn /
 *     close_session / cancel_session / list_sessions / get_session /
 *     request_permission / permission_response / complete_turn / fail_turn / ping
 *   - 统一返回 { jsonrpc: '2.0', id, result | error }
 *
 * 用于 ACP stdio 服务器或任何 JSON-RPC 传输层。
 */

/** ACP 协议版本 */
const ACP_PROTOCOL_VERSION = '0.1';

/** JSON-RPC 请求 */
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | null;
}

/** JSON-RPC 响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 路由处理结果 */
export interface RouteResult {
  response: JsonRpcResponse;
  /** 是否需要广播（如 session_initialized 等事件） */
  broadcast?: { event: string; payload: unknown };
}

/** 服务端能力描述 */
export interface AcpServerCapabilities {
  loadSession: boolean;
  promptCapabilities: { attachments: boolean; images: boolean };
  sessionCapabilities: {
    setModel: boolean;
    setAgent: boolean;
    setRuntimeOptions: boolean;
  };
}

@Injectable()
export class AcpMessageRouter {
  /** 当前已初始化的客户端信息 */
  private clientInfo: { name: string; version: string } | null = null;
  /** 是否完成 initialize 握手 */
  private initialized = false;
  /** 当前会话 ID（单会话 stdio 模式） */
  private currentSessionId: string | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly sessionService: AcpSessionService,
  ) {}

  /**
   * 路由 JSON-RPC 消息
   * - 根据 method 分发到对应处理器
   * - 未携带 id 的通知类消息返回 null（不回复）
   */
  route(msg: JsonRpcRequest): JsonRpcResponse | null {
    const method = msg.method || '';
    const id = msg.id ?? null;
    const params = msg.params || {};

    switch (method) {
      case 'initialize':
        return this._reply(id, this.handleInitialize(params));
      case 'new_session':
        return this._reply(id, this.handleNewSession(params));
      case 'load_session':
        return this._reply(id, this.handleLoadSession(params));
      case 'run_turn':
        return this._reply(id, this.handleRunTurn(params));
      case 'close_session':
        return this._reply(id, this.handleCloseSession(params));
      case 'cancel_session':
        return this._reply(id, this.handleCancelSession(params));
      case 'list_sessions':
        return this._reply(id, this.handleListSessions());
      case 'get_session':
        return this._reply(id, this.handleGetSession(params));
      case 'complete_turn':
        return this._reply(id, this.handleCompleteTurn(params));
      case 'fail_turn':
        return this._reply(id, this.handleFailTurn(params));
      case 'request_permission':
        return this._reply(id, this.handleRequestPermission(params));
      case 'permission_response':
        return this._reply(id, this.handlePermissionResponse(params));
      case 'ping':
        return this._reply(id, { pong: true, timestamp: Date.now() });
      default:
        return this._error(id, -32601, `Unknown method: ${method}`);
    }
  }

  /** initialize：ACP 协议握手 */
  handleInitialize(params: Record<string, unknown>): {
    protocolVersion: string;
    serverCapabilities: AcpServerCapabilities;
    serverInfo: { name: string; version: string };
  } {
    this.initialized = true;
    this.clientInfo =
      (params['clientInfo'] as { name: string; version: string }) || {
        name: 'unknown',
        version: '0.0.0',
      };
    this.logger.info('acp-router: ACP client initialized', {
      name: this.clientInfo.name,
    });
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      serverCapabilities: {
        loadSession: true,
        promptCapabilities: { attachments: true, images: true },
        sessionCapabilities: {
          setModel: true,
          setAgent: true,
          setRuntimeOptions: true,
        },
      },
      serverInfo: { name: 'skyalyticwing-acp-server', version: '1.1.1' },
    };
  }

  /** new_session：创建 ACP 会话 */
  handleNewSession(params: Record<string, unknown>): { success: boolean; sessionId?: string; error?: string } {
    const result = this.sessionService.initializeSession({
      ...((params['sessionId'] as string) ? { sessionId: params['sessionId'] as string } : {}),
      agentId: (params['agentId'] as string) || 'main',
      channel: 'stdio',
      peerId: (params['peerId'] as string) || '',
      metadata: (params['metadata'] as Record<string, unknown>) || {},
      runtimeOptions: (params['runtimeOptions'] as Record<string, unknown>) || {},
      backendCandidates: (params['backendCandidates'] as string[]) || ['default'],
    });
    if (result.success && result.sessionId) {
      this.currentSessionId = result.sessionId;
    }
    return result;
  }

  /** load_session：恢复已有会话 */
  handleLoadSession(params: Record<string, unknown>): { success: boolean; session?: unknown; error?: string } {
    const sessionId = params['sessionId'] as string;
    const existing = this.sessionService.getSession(sessionId);
    if (existing) {
      this.currentSessionId = sessionId;
      this.sessionService.restoreSession(sessionId);
      return { success: true, session: existing };
    }
    return { success: false, error: `Session not found: ${sessionId}` };
  }

  /** run_turn：在会话内运行一轮 AI 对话 */
  handleRunTurn(params: Record<string, unknown>): unknown {
    const sessionId =
      (params['sessionId'] as string) || this.currentSessionId || '';
    const turnResult = this.sessionService.runTurn({
      sessionId,
      prompt: (params['prompt'] as string) || '',
      mode: (params['mode'] as 'prompt' | 'oneshot') || 'prompt',
      attachments: (params['attachments'] as unknown[]) || [],
      timeoutMs: (params['timeoutMs'] as number) ?? 0,
      metadata: (params['metadata'] as Record<string, unknown>) || {},
    });
    return turnResult;
  }

  /** close_session：关闭会话 */
  handleCloseSession(params: Record<string, unknown>): unknown {
    const sessionId = (params['sessionId'] as string) || this.currentSessionId || '';
    const result = this.sessionService.closeSession({ sessionId });
    if (result.success && this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    return result;
  }

  /** cancel_session：取消会话 */
  handleCancelSession(params: Record<string, unknown>): unknown {
    const sessionId = (params['sessionId'] as string) || this.currentSessionId || '';
    return this.sessionService.cancelSession(sessionId);
  }

  /** list_sessions：列出全部会话 */
  handleListSessions(): unknown[] {
    return this.sessionService.listSessions();
  }

  /** get_session：获取单个会话 */
  handleGetSession(params: Record<string, unknown>): unknown {
    const sessionId = params['sessionId'] as string;
    return this.sessionService.getSession(sessionId);
  }

  /** complete_turn：完成 turn */
  handleCompleteTurn(params: Record<string, unknown>): unknown {
    const sessionId = params['sessionId'] as string;
    const result = params['result'] as { content?: string };
    return this.sessionService.completeTurn(sessionId, result || {});
  }

  /** fail_turn：标记 turn 失败 */
  handleFailTurn(params: Record<string, unknown>): unknown {
    const sessionId = params['sessionId'] as string;
    const error = (params['error'] as string) || 'Unknown error';
    const errorCode = params['errorCode'] as string | undefined;
    return this.sessionService.failTurn(sessionId, error, errorCode);
  }

  /**
   * request_permission：权限请求转发
   * 当前实现返回拒绝（ACP 路由层不直接处理权限，由上层 WebSocket 审批流处理）
   */
  handleRequestPermission(params: Record<string, unknown>): { success: boolean; error: string; approvalId?: string } {
    const approvalId = params['approvalId'] as string;
    this.logger.info('acp-router: Permission request relayed', { approvalId });
    return {
      success: false,
      error: 'Permission relay not directly supported in router; use WebSocket approval flow',
      approvalId,
    };
  }

  /**
   * permission_response：权限响应处理
   * 当前实现为占位（实际响应由 EventEmitter2 派发到 AgentLoopService）
   */
  handlePermissionResponse(params: Record<string, unknown>): { success: boolean; error?: string } {
    const approvalId = params['approvalId'] as string;
    const decision = params['decision'] as boolean;
    this.logger.info('acp-router: Permission response received', { approvalId, decision });
    return { success: true };
  }

  /** 当前客户端信息 */
  getClientInfo(): { name: string; version: string } | null {
    return this.clientInfo;
  }

  /** 是否已完成 initialize 握手 */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** 重置路由器状态（连接断开时调用） */
  reset(): void {
    this.initialized = false;
    this.clientInfo = null;
    this.currentSessionId = null;
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  /** 构造成功响应 */
  private _reply(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  /** 构造错误响应 */
  private _error(
    id: string | number | null,
    code: number,
    message: string,
  ): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
