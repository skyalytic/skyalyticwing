import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer as WebSocketServerDecorator } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { ToolApprovalRequest, ToolContext } from '@skyalyticwing/shared';
import type { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { ConfigService } from '../../core/config/config.service.js';
import { isTrustedBrowserRequest } from '../../core/security/browser-origin.util.js';
import { resolveEffectiveWorkspace } from '../../core/config/effective-workspace.util.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { ChatService } from './chat.service.js';
import { ChatControlRegistry } from './chat-control.registry.js';
import { ToolExecutorService } from '../../tools/executor/tool-executor.service.js';
import { ApprovalService, type ApprovalDecisionType } from '../../tools/executor/approval.service.js';
import {
  WS_CLOSE_CODES,
  WS_MAX_CONNECTIONS,
  WS_MAX_PAYLOAD } from '../../core/websocket/websocket.events.js';

/**
 * ChatGateway - /ws/chat 路径的聊天流式推送网关
 *
 * 参考 packages/backend/src/core/websocket/websocket.gateway.ts 的实现风格。
 *
 * 职责：
 *   - 订阅会话 → 接收流式 token → 完成时推送完整消息
 *   - 客户端发送 `chat:stream` 触发流式响应，服务端逐 token 推送 `chat:token`
 *   - 完成时推送 `chat:done`（携带完整消息），出错推送 `chat:error`
 *   - 客户端可 `subscribe` 会话以接收该会话的广播事件
 *
 * 事件：
 *   Client → Server:
 *     - chat:stream       { sessionId, message, model?, agent? }
 *     - subscribe         { sessionId }
 *     - unsubscribe       { sessionId? }
 *     - tool_execute      { tool, args?, sessionId? }（外部客户端触发工具执行）
 *     - approval_resolve  { approvalId, decision, reason? }（WS 审批决策）
 *     - ping
 *   Server → Client:
 *     - connected         { clientId, timestamp }
 *     - chat:token        { sessionId, content, done: false }
 *     - chat:done         { sessionId, message, usage? }
 *     - chat:error        { sessionId, error }
 *     - approval_pending  { approvalId, tool, reason }（tool_execute 需审批时）
 *     - tool_result       { tool, sessionId, result }（对齐旧版协议）
 *     - error             { error }
 *     - pong              { timestamp }
 *
 *     另经 WebSocketService 广播：approval_request / tools_refresh /
 *     permissions_refresh（见 ApprovalService）。
 */
@WebSocketGateway({
  path: '/ws/chat',
  maxPayload: WS_MAX_PAYLOAD,
  clientTracking: true })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);
  /** socket → clientId 反向索引 */
  private readonly socketToClientId = new WeakMap<WebSocket, string>();
  /** 正在进行的流式请求：clientId+sessionId → AbortController（用于取消） */
  private readonly activeStreams = new Map<string, AbortController>();

  @WebSocketServerDecorator()
  server!: WebSocketServer;

  constructor(
    private readonly config: ConfigService,
    private readonly wsService: WebSocketService,
    private readonly chatService: ChatService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly approvalService: ApprovalService,

  ) {}

  afterInit(): void {
    this.logger.log('Chat gateway initialized on /ws/chat');
  }

  handleConnection(client: WebSocket, req?: IncomingMessage): void {
    if (!isTrustedBrowserRequest(req?.headers || {})) {
      this.safeClose(client, WS_CLOSE_CODES.UNAUTHORIZED, 'Untrusted browser origin');
      return;
    }
    // 1. 连接数限制
    if (this.wsService.getConnectionCount() >= WS_MAX_CONNECTIONS) {
      this.safeClose(client, WS_CLOSE_CODES.TOO_MANY_CONNECTIONS, 'Too many connections');
      return;
    }

    // 2. Token 认证
    const authResult = this.authenticate(req);
    if (authResult.ok === false) {
      this.safeClose(client, WS_CLOSE_CODES.UNAUTHORIZED, authResult.reason);
      return;
    }

    // 3. 注册客户端
    const clientId = this.generateClientId();
    this.socketToClientId.set(client, clientId);
    this.wsService.register({
      id: clientId,
      socket: client,
      connectedAt: Date.now(),
      sessions: new Set<string>() });

    // 4. 发送连接就绪事件
    this.safeSend(client, {
      type: 'connected',
      timestamp: Date.now(),
      clientId });

    this.logger.debug(`Chat client connected: ${clientId}`);
  }

  handleDisconnect(client: WebSocket): void {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return;
    // 取消该客户端所有进行中的流式请求
    for (const key of Array.from(this.activeStreams.keys())) {
      if (key.startsWith(clientId + ':')) {
        const controller = this.activeStreams.get(key);
        controller?.abort();
        this.activeStreams.delete(key);
      }
    }
    this.wsService.unregister(clientId);
    this.socketToClientId.delete(client);
    this.logger.debug(`Chat client disconnected: ${clientId}`);
  }

  /**
   * 客户端订阅会话（接收该会话的广播事件）
   * 与主 WebSocketGateway 行为一致，复用 WebSocketService 的会话索引
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @MessageBody() body: { sessionId: string },
    @ConnectedSocket() client: WebSocket,
  ): { status: 'ok' | 'error' } {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return { status: 'error' };
    if (!body || typeof body.sessionId !== 'string' || !body.sessionId) {
      return { status: 'error' };
    }
    this.wsService.subscribeSession(clientId, body.sessionId);
    return { status: 'ok' };
  }

  /** 客户端取消订阅会话 */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @MessageBody() body: { sessionId?: string },
    @ConnectedSocket() client: WebSocket,
  ): { status: 'ok' | 'error' } {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return { status: 'error' };
    this.wsService.unsubscribeSession(clientId, body?.sessionId);
    return { status: 'ok' };
  }

  /**
   * 流式聊天：客户端发送消息，服务端逐 token 推送
   * - 调用 ChatService.streamMessage 驱动 LLM 流式响应
   * - 每个内容块推送 `chat:token`（done=false）
   * - 完成时推送 `chat:done`（携带完整消息）
   * - 出错推送 `chat:error`
   * - 支持通过取消订阅/断开连接中止流
   */
  @SubscribeMessage('chat:stream')
  async handleChatStream(
    @MessageBody() body: ChatStreamInput,
    @ConnectedSocket() client: WebSocket,
  ): Promise<{ status: 'ok' | 'error'; error?: string }> {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return { status: 'error', error: 'Client not registered' };
    if (!body || typeof body.sessionId !== 'string' || typeof body.message !== 'string') {
      return { status: 'error', error: 'Invalid payload: sessionId and message required' };
    }

    const { sessionId, message } = body;
    const streamKey = `${clientId}:${sessionId}`;
    // 同会话已有流进行中：先取消
    const existing = this.activeStreams.get(streamKey);
    if (existing) existing.abort();
    const controller = new AbortController();
    this.activeStreams.set(streamKey, controller);

    const model = typeof body.model === 'string' ? body.model : undefined;
    const agent = typeof body.agent === 'string' ? body.agent : undefined;

    try {
      let fullContent = '';
      for await (const chunk of this.chatService.streamMessage({
        session: sessionId,
        message,
        ...(model !== undefined ? { model } : {}),
        ...(agent !== undefined ? { agent } : {}),
        stream: true })) {
        // 流被取消
        if (controller.signal.aborted) break;

        if (chunk.type === 'delta' && chunk.content) {
          fullContent += chunk.content;
          this.safeSend(client, {
            type: 'chat:token',
            data: { sessionId, content: chunk.content, done: false } });
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          this.safeSend(client, {
            type: 'chat:tool_call',
            data: {
              sessionId,
              toolCall: {
                id: chunk.toolCall.id,
                name: chunk.toolCall.name,
                arguments: chunk.toolCall.arguments } } });
        } else if (chunk.type === 'error' && chunk.error) {
          this.safeSend(client, {
            type: 'chat:error',
            data: { sessionId, error: chunk.error } });
          this.activeStreams.delete(streamKey);
          return { status: 'ok' };
        } else if (chunk.type === 'done') {
          this.safeSend(client, {
            type: 'chat:done',
            data: {
              sessionId,
              message: fullContent,
              usage: chunk.usage } });
        }
      }
      this.activeStreams.delete(streamKey);
      return { status: 'ok' };
    } catch (err) {
      this.activeStreams.delete(streamKey);
      const errMsg = err instanceof Error ? err.message : String(err);
      this.safeSend(client, {
        type: 'chat:error',
        data: { sessionId, error: errMsg } });
      return { status: 'ok' };
    }
  }

  /** 取消进行中的流式请求 */
  @SubscribeMessage('chat:cancel')
  handleChatCancel(
    @MessageBody() body: { sessionId?: string },
    @ConnectedSocket() client: WebSocket,
  ): { status: 'ok' | 'error' } {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return { status: 'error' };
    if (body?.sessionId) {
      ChatControlRegistry.requestAbort(body.sessionId);
      const controller = this.activeStreams.get(`${clientId}:${body.sessionId}`);
      if (controller) {
        controller.abort();
        this.activeStreams.delete(`${clientId}:${body.sessionId}`);
      }
    } else {
      // 取消该客户端全部流
      for (const key of Array.from(this.activeStreams.keys())) {
        if (key.startsWith(clientId + ':')) {
          ChatControlRegistry.requestAbort(key.slice(clientId.length + 1));
          this.activeStreams.get(key)?.abort();
          this.activeStreams.delete(key);
        }
      }
    }
    return { status: 'ok' };
  }

  /**
   * 工具执行通道（对齐旧版 start.cjs tool_execute 协议）
   *
   * 流程：
   *   1. 调 ToolExecutorService.execute 走完整权限链（YOLO/危险工具/SecurityManager）
   *   2. 若返回 approvalRequired（危险工具 + ask 模式）：
   *      - 回执 approval_pending { approvalId, tool, reason } 给请求客户端
   *      - ApprovalService.requestApproval 广播 approval_request 并等待用户决策
   *        （REST POST /api/approvals/:id 或下方 approval_resolve 消息，120s 超时视为拒绝）
   *      - 批准 → 以 approvalGranted 重新执行（工具内部安全校验不变）
   *      - 拒绝/超时 → 回执 error 事件
   *   3. 结果回执 tool_result { tool, sessionId, result }
   */
  @SubscribeMessage('tool_execute')
  async handleToolExecute(
    @MessageBody() body: ToolExecuteInput,
    @ConnectedSocket() client: WebSocket,
  ): Promise<{ status: 'ok' | 'error'; error?: string }> {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return { status: 'error', error: 'Client not registered' };
    if (!body || typeof body.tool !== 'string' || !body.tool) {
      return { status: 'error', error: 'Invalid payload: tool required' };
    }

    const toolName = body.tool;
    const args = body.args ?? {};
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'ws';
    const ctx: ToolContext = {
      sessionId,
      // 会话绑定的项目目录优先（一会话一目录），未绑定时回退全局工程目录/智能体工作区
      workspace: resolveEffectiveWorkspace(undefined, sessionId),
      config: {},
      log: (level: string, message: string) => this.logger.debug(`[ws-tool:${level}] ${message}`),
      broadcast: (event: string, _data: unknown) => this.logger.debug(`[ws-tool broadcast] ${event}`) };

    try {
      let result = await this.toolExecutor.execute(toolName, args, ctx);

      if (result.approvalRequired) {
        const approval: ToolApprovalRequest = {
          id: randomUUID(),
          toolName,
          args,
          sessionId,
          reason: result.error || `Tool '${toolName}' requires approval`,
          timestamp: Date.now() };
        // 回执审批等待（对齐旧版 approval_pending 事件）
        this.safeSend(client, {
          type: 'approval_pending',
          data: { approvalId: approval.id, tool: toolName, reason: approval.reason } });
        // 广播 approval_request 并阻塞等待用户决策（超时/拒绝 → false）
        const approved = await this.approvalService.requestApproval(approval);
        if (!approved) {
          this.safeSend(client, {
            type: 'error',
            data: { error: `审批未通过（拒绝或超时）: ${toolName}` } });
          return { status: 'ok' };
        }
        // 用户已批准：以 approvalGranted 二次执行，跳过重复审批拦截（内部安全校验仍生效）
        result = await this.toolExecutor.execute(toolName, args, ctx, { approvalGranted: true });
      }

      this.safeSend(client, { type: 'tool_result', data: { tool: toolName, sessionId, result } });
      return { status: 'ok' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.safeSend(client, { type: 'error', data: { error: errMsg } });
      return { status: 'ok' };
    }
  }

  /**
   * WS 审批决策通道（对齐旧版 approval_resolve 协议）
   *
   * body: { approvalId, decision, reason? }
   * decision 兼容旧版宽松值：'approved' → allow-once，'denied' → denied
   */
  @SubscribeMessage('approval_resolve')
  handleApprovalResolve(
    @MessageBody() body: { approvalId?: string; decision?: string; reason?: string },
  ): { status: 'ok' | 'error'; error?: string } {
    if (!body || !body.approvalId || !body.decision) {
      return { status: 'error', error: 'Invalid payload: approvalId and decision required' };
    }
    const decision = this.mapCompatDecision(body.decision);
    if (!decision) {
      return { status: 'error', error: `Invalid decision: ${body.decision}` };
    }
    const result = this.approvalService.respondApprovalWithDecision(
      body.approvalId,
      decision,
      body.reason,
    );
    if (!result.success) {
      return { status: 'error', error: result.reason || 'Approval not found or expired' };
    }
    return { status: 'ok' };
  }

  /** 旧版宽松决策值 → 4 种标准决策映射 */
  private mapCompatDecision(raw: string): ApprovalDecisionType | null {
    switch (raw) {
      case 'allow-once':
      case 'approved':
      case 'approve':
        return 'allow-once';
      case 'allow-always':
        return 'allow-always';
      case 'denied':
      case 'deny':
        return 'denied';
      case 'deny-always':
        return 'deny-always';
      default:
        return null;
    }
  }

  /** 文本层 ping（兼容 Tauri WebView2） */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() _client: WebSocket): { type: string; timestamp: number } {
    return { type: 'pong', timestamp: Date.now() };
  }

  // ─── 内部方法 ──────────────────────────────────────────────

  private authenticate(req?: IncomingMessage): { ok: true } | { ok: false; reason: string } {
    let authMode = 'none';
    let authToken = '';
    try {
      const security = this.config.get<Record<string, unknown>>('security');
      const auth = (security['auth'] || {}) as Record<string, unknown>;
      authMode = typeof auth['mode'] === 'string' ? auth['mode'] : 'none';
      authToken = typeof auth['token'] === 'string' ? auth['token'] : '';
    } catch {
      // 配置缺失视为开放模式
    }

    if (authMode !== 'token') return { ok: true };
    if (!authToken) {
      return { ok: false, reason: 'Token auth configured but no token set' };
    }

    const provided = this.extractToken(req);
    if (!provided) return { ok: false, reason: 'Missing token' };

    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(authToken);
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return { ok: false, reason: 'Invalid token' };
    }
    return { ok: true };
  }

  private extractToken(req?: IncomingMessage): string {
    if (!req) return '';
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const subproto = headers['sec-websocket-protocol'];
    if (subproto) {
      const protos = (Array.isArray(subproto) ? subproto.join(',') : subproto)
        .split(',')
        .map((s) => s.trim());
      for (const p of protos) {
        const m = p.match(/^bearer\.(.+)$/i);
        if (m && m[1]) return m[1];
      }
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) return tokenParam;
    const authHeader = headers['authorization'];
    if (authHeader) {
      const authStr = Array.isArray(authHeader) ? authHeader[0] || '' : authHeader;
      const m = authStr.match(/^bearer\s+(.+)$/i);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  private generateClientId(): string {
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private safeClose(client: WebSocket, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch {
      // 忽略关闭错误
    }
  }

  private safeSend(client: WebSocket, data: unknown): void {
    if (client.readyState !== 1 /* WebSocket.OPEN */) return;
    try {
      client.send(JSON.stringify(data));
    } catch {
      // 忽略发送错误
    }
  }
}

/** chat:stream 消息体 */
export interface ChatStreamInput {
  sessionId: string;
  message: string;
  model?: string;
  agent?: string;
}

/** tool_execute 消息体（对齐旧版协议：tool + args + 可选 sessionId） */
export interface ToolExecuteInput {
  tool: string;
  args?: unknown;
  sessionId?: string;
}
