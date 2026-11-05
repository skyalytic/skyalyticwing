import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway as WsGatewayDecorator,
  WebSocketServer as WebSocketServerDecorator,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { ConfigService } from '../config/config.service.js';
import { isTrustedBrowserRequest } from '../security/browser-origin.util.js';
import { WebSocketService } from './websocket.service.js';
import {
  WS_CLOSE_CODES,
  WS_CONNECTED_EVENT,
  WS_MAX_CONNECTIONS,
  WS_MAX_PAYLOAD,
  WS_PONG_EVENT,
  WS_SUBSCRIBE_EVENT,
  WS_UNSUBSCRIBE_EVENT,
  type WsSubscribeMessage,
  type WsUnsubscribeMessage } from './websocket.events.js';

/**
 * WebSocketGateway - /ws 路径的 WebSocket 网关
 *
 * 特性：
 *   - 路径 /ws，单帧最大 10MB
 *   - Token 认证（当 security.auth.mode === 'token' 时）：
 *       · 优先从 sec-websocket-protocol 头部提取 bearer.<token>
 *       · 回退到查询参数 ?token=<token>
 *       · 使用 timingSafeEqual 常量时间比较
 *   - 最多 100 个并发连接（超出立即关闭 4013）
 *   - 不基于 ping/pong 终止连接（兼容 Tauri WebView2）
 *   - 支持 subscribe / unsubscribe 消息维护会话订阅
 *
 * 注意：main.ts 已通过 `setGlobalPrefix('api', { exclude: [..., '/ws'] })` 排除 /ws，
 * 因此 WebSocket 路径不会附加 /api 前缀。
 */
@WsGatewayDecorator({
  path: '/ws',
  maxPayload: WS_MAX_PAYLOAD,
  // Nest WsAdapter.close iterates server.clients. Tracking does not enable ping timers.
  clientTracking: true })
export class WebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WebSocketGateway.name);
  /** socket → clientId 反向索引，用于 handleDisconnect 时查找 */
  private readonly socketToClientId = new WeakMap<WebSocket, string>();

  @WebSocketServerDecorator()
  server!: WebSocketServer;

  constructor(
    private readonly config: ConfigService,
    private readonly wsService: WebSocketService,

  ) {}

  afterInit(): void {
    this.logger.log('WebSocket gateway initialized on /ws');
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
      type: WS_CONNECTED_EVENT,
      timestamp: Date.now(),
      clientId });

    this.logger.debug(`Client connected: ${clientId} (total=${this.wsService.getConnectionCount()})`);
  }

  handleDisconnect(client: WebSocket): void {
    const clientId = this.socketToClientId.get(client);
    if (clientId) {
      this.wsService.unregister(clientId);
      this.socketToClientId.delete(client);
      this.logger.debug(`Client disconnected: ${clientId} (total=${this.wsService.getConnectionCount()})`);
    }
  }

  /** 客户端订阅会话 */
  @SubscribeMessage(WS_SUBSCRIBE_EVENT)
  handleSubscribe(
    @MessageBody() body: WsSubscribeMessage,
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
  @SubscribeMessage(WS_UNSUBSCRIBE_EVENT)
  handleUnsubscribe(
    @MessageBody() body: WsUnsubscribeMessage,
    @ConnectedSocket() client: WebSocket,
  ): { status: 'ok' | 'error' } {
    const clientId = this.socketToClientId.get(client);
    if (!clientId) return { status: 'error' };
    this.wsService.unsubscribeSession(clientId, body?.sessionId);
    return { status: 'ok' };
  }

  /** 文本层 ping（不依赖 WS ping 帧，兼容 Tauri WebView2） */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() _client: WebSocket): { type: string; timestamp: number } {
    return { type: WS_PONG_EVENT, timestamp: Date.now() };
  }

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
      // 配置了 token 模式但未配置 token：fail-close
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

    // 1. 从 sec-websocket-protocol 头部提取 bearer.<token>
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

    // 2. 从查询参数 ?token=<token> 提取
    // The request target contains the query; an untrusted Host must not crash URL parsing.
    const url = new URL(req.url || '/', 'http://localhost');
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) return tokenParam;

    // 3. 从 Authorization 头部提取 Bearer <token>
    const authHeader = headers['authorization'];
    if (authHeader) {
      const authStr = Array.isArray(authHeader) ? authHeader[0] || '' : authHeader;
      const m = authStr.match(/^bearer\s+(.+)$/i);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  private generateClientId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
