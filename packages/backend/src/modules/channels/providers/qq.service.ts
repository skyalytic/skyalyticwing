import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import {
  BaseProvider,
  fetchWithTimeout,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

// ============================================================
// QQ 官方 Bot Gateway 协议常量（对应 channels.cjs QQChannel 中的 OP/INTENT）
// ============================================================
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
const INTENT_DIRECT_MESSAGE = 1 << 12;
const INTENT_GROUP_AND_C2C = 1 << 25;
const FULL_INTENTS = INTENT_PUBLIC_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE | INTENT_GROUP_AND_C2C;

const RECONNECT_DELAYS = [2000, 5000, 10000, 30000, 60000, 120000];
const MAX_RECONNECT_ATTEMPTS = 100;
const GATEWAY_CACHE_TTL = 300000;

/**
 * QQProvider - QQ 渠道提供商
 *
 * 对应 channels.cjs QQChannel（行 2387-3069）。
 *
 * 双协议模式：
 *   1. official（QQ 官方 Bot）：
 *      - getAppAccessToken → gateway URL（5min 缓存）→ WebSocket 连接
 *      - OP_HELLO → IDENTIFY/RESUME（带 FULL_INTENTS）+ 心跳
 *      - 处理 DISPATCH 事件：READY/RESUMED/C2C_MESSAGE_CREATE/AT_MESSAGE_CREATE/
 *        DIRECT_MESSAGE_CREATE/GROUP_AT_MESSAGE_CREATE
 *      - 重连退避 [2,5,10,30,60,120]s，最多 100 次
 *      - 特殊关闭码处理：4914/4915（下线/封禁）、4006/4007/4009（会话失效）
 *   2. onebot（OneBot 协议）：
 *      - WebSocket 模式（wsUrl）或 HTTP postback 模式（httpPort，含 IP 白名单）
 *      - 过滤 bot 自身消息（sub_type='self'）
 *
 * 发送：
 *   - official：v2/users/{to}/messages、v2/groups/{group_openid}/messages、
 *     channels/{channel_id}/messages、dms/{guild_id}/messages
 *   - onebot：ws send_group_msg/send_private_msg 或 httpPostUrl
 *   - 图片/文件：official 用 base64/CQ 码，onebot 用 [CQ:image]/[CQ:file]
 */
@Injectable()
export class QQProvider extends BaseProvider {
  private ws: WebSocket | null = null;
  private httpServer: Server | null = null;
  private accessToken: string | null = null;
  private tokenExpireAt = 0;
  private lastGroupId: string | null = null;
  private lastGroupOpenid: string | null = null;
  private lastChannelId: string | null = null;
  private lastGuildId: string | null = null;
  private lastMsgType: string | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isAborted = false;
  private lastGatewayUrl: string | null = null;
  private lastGatewayFetchTime = 0;

  constructor(logger: LoggerService, router: ChannelRouterService) {
    super(logger, router, 'qq');
    this.name = 'QQ';
  }

  /** 获取 AccessToken（对应 _getAccessToken） */
  private async getAccessToken(): Promise<string> {
    const config = this.config as { appId: string; appSecret: string };
    const resp = await fetchWithTimeout('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
    });
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; message?: string };
    if (data.access_token) {
      this.accessToken = data.access_token;
      this.tokenExpireAt = Date.now() + ((data.expires_in || 7200) - 300) * 1000;
      return data.access_token;
    }
    throw new Error(data.message || 'Get token failed');
  }

  /** 获取网关 URL（对应 _getGatewayUrl，5min 缓存） */
  private async getGatewayUrl(token: string): Promise<string> {
    if (this.lastGatewayUrl && Date.now() - this.lastGatewayFetchTime < GATEWAY_CACHE_TTL) {
      this.logger.info('[QQ Official] Using cached gateway URL');
      return this.lastGatewayUrl;
    }
    const resp = await fetchWithTimeout('https://api.sgroup.qq.com/gateway', {
      method: 'GET',
      headers: { Authorization: 'QQBot ' + token },
    });
    const data = (await resp.json()) as { url?: string; code?: number };
    if (data.url) {
      this.lastGatewayUrl = data.url;
      this.lastGatewayFetchTime = Date.now();
      return data.url;
    }
    if (data.code === 100017) {
      this.logger.info('[QQ Official] Rate limited, will retry later');
    }
    throw new Error('Get gateway URL failed: ' + JSON.stringify(data));
  }

  /** 清理 Gateway 连接（对应 _cleanupGateway） */
  private cleanupGateway(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
  }

  /** 调度重连（对应 _scheduleReconnect，退避 + 上限守卫） */
  private scheduleReconnect(customDelay?: number): void {
    if (this.isAborted || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.info('[QQ Official] Max reconnect attempts reached or aborted');
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const idx = Math.min(this.reconnectAttempts, RECONNECT_DELAYS.length - 1);
    const delay = customDelay || RECONNECT_DELAYS[idx];
    this.reconnectAttempts++;
    this.logger.info(`[QQ Official] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isAborted) this.connectGateway();
    }, delay);
  }

  /** 连接官方 Gateway（对应 _connectGateway） */
  private async connectGateway(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    try {
      this.cleanupGateway();
      const token = await this.getAccessToken();
      this.logger.info('[QQ Official] Access token obtained');
      const gatewayUrl = await this.getGatewayUrl(token);
      this.logger.info('[QQ Official] Connecting to gateway: ' + gatewayUrl);

      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.logger.info('[QQ Official] WebSocket connected');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
      });

      ws.on('message', async (data: unknown) => {
        try {
          const rawData =
            typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          const payload = JSON.parse(rawData) as { op: number; d: unknown; s?: number; t?: string };
          const op = payload.op;
          const d = payload.d;
          const s = payload.s;
          const t = payload.t;

          if (s) this.lastSeq = s;

          switch (op) {
            case OP_HELLO: {
              this.logger.info('[QQ Official] Hello received');
              const dObj = (d as Record<string, unknown>) || {};
              if (this.sessionId && this.lastSeq !== null) {
                this.logger.info('[QQ Official] Attempting to resume session ' + this.sessionId);
                ws.send(
                  JSON.stringify({
                    op: OP_RESUME,
                    d: { token: 'QQBot ' + token, session_id: this.sessionId, seq: this.lastSeq },
                  }),
                );
              } else {
                this.logger.info('[QQ Official] Sending identify with intents: ' + FULL_INTENTS);
                ws.send(
                  JSON.stringify({
                    op: OP_IDENTIFY,
                    d: { token: 'QQBot ' + token, intents: FULL_INTENTS, shard: [0, 1] },
                  }),
                );
              }
              const interval = dObj['heartbeat_interval'] ? (dObj['heartbeat_interval'] as number) : 41250;
              if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
              this.heartbeatTimer = setInterval(() => {
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }));
                }
              }, interval);
              break;
            }
            case OP_DISPATCH: {
              const dRec = (d as Record<string, unknown>) || {};
              if (t === 'READY') {
                this.sessionId = (dRec['session_id'] as string) || null;
                this.logger.info('[QQ Official] Ready, session: ' + this.sessionId);
                this.status.connected = true;
                this.status.lastError = null;
              } else if (t === 'RESUMED') {
                this.logger.info('[QQ Official] Session resumed');
                this.status.connected = true;
                this.status.lastError = null;
              } else if (t === 'C2C_MESSAGE_CREATE') {
                const author = (dRec['author'] as Record<string, unknown>) || {};
                const from = (author['user_openid'] as string) || (author['id'] as string) || 'unknown';
                const content = (dRec['content'] as string) || '';
                const msgId = (dRec['id'] as string) || '';
                this.lastSenderId = from;
                this.lastMsgType = 'c2c';
                await this.handleIncomingMessage(from, content, {
                  msgType: 'c2c',
                  messageId: msgId,
                  timestamp: (dRec['timestamp'] as string) || '',
                  raw: { op, t, d },
                });
              } else if (t === 'AT_MESSAGE_CREATE') {
                const gAuthor = (dRec['author'] as Record<string, unknown>) || {};
                const gFrom = (gAuthor['id'] as string) || (gAuthor['username'] as string) || 'unknown';
                const gContent = (dRec['content'] as string) || '';
                const gMsgId = (dRec['id'] as string) || '';
                const gChannelId = (dRec['channel_id'] as string) || '';
                const gGuildId = (dRec['guild_id'] as string) || '';
                this.lastSenderId = gFrom;
                this.lastChannelId = gChannelId;
                this.lastGuildId = gGuildId;
                this.lastMsgType = 'guild';
                await this.handleIncomingMessage(gFrom, gContent, {
                  msgType: 'guild',
                  messageId: gMsgId,
                  channelId: gChannelId,
                  guildId: gGuildId,
                  timestamp: (dRec['timestamp'] as string) || '',
                  raw: { op, t, d },
                });
              } else if (t === 'DIRECT_MESSAGE_CREATE') {
                const dmAuthor = (dRec['author'] as Record<string, unknown>) || {};
                const dmFrom = (dmAuthor['id'] as string) || (dmAuthor['username'] as string) || 'unknown';
                const dmContent = (dRec['content'] as string) || '';
                const dmMsgId = (dRec['id'] as string) || '';
                const dmGuildId = (dRec['guild_id'] as string) || '';
                this.lastSenderId = dmFrom;
                this.lastGuildId = dmGuildId;
                this.lastMsgType = 'dm';
                await this.handleIncomingMessage(dmFrom, dmContent, {
                  msgType: 'dm',
                  messageId: dmMsgId,
                  guildId: dmGuildId,
                  timestamp: (dRec['timestamp'] as string) || '',
                  raw: { op, t, d },
                });
              } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
                const grpAuthor = (dRec['author'] as Record<string, unknown>) || {};
                const grpFrom = (grpAuthor['member_openid'] as string) || (grpAuthor['id'] as string) || 'unknown';
                const grpContent = (dRec['content'] as string) || '';
                const grpMsgId = (dRec['id'] as string) || '';
                const grpOpenid = (dRec['group_openid'] as string) || '';
                this.lastSenderId = grpFrom;
                this.lastGroupOpenid = grpOpenid;
                this.lastMsgType = 'group';
                await this.handleIncomingMessage(grpFrom, grpContent, {
                  msgType: 'group',
                  messageId: grpMsgId,
                  groupOpenid: grpOpenid,
                  timestamp: (dRec['timestamp'] as string) || '',
                  raw: { op, t, d },
                });
              }
              break;
            }
            case OP_HEARTBEAT_ACK:
              break;
            case OP_RECONNECT:
              this.logger.info('[QQ Official] Server requested reconnect');
              this.cleanupGateway();
              this.scheduleReconnect();
              break;
            case OP_INVALID_SESSION: {
              const canResume = d as boolean;
              this.logger.info('[QQ Official] Invalid session, can resume: ' + canResume);
              if (!canResume) {
                this.sessionId = null;
                this.lastSeq = null;
              }
              this.cleanupGateway();
              this.scheduleReconnect(3000);
              break;
            }
          }
        } catch (e) {
          this.logger.warn('[QQ Official] Message parse error', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });

      ws.on('close', (code: number) => {
        this.logger.info('[QQ Official] WebSocket closed: ' + code);
        this.isConnecting = false;
        this.status.connected = false;
        this.emitStatusChange();
        if (code === 4914 || code === 4915) {
          this.logger.info('[QQ Official] Bot is ' + (code === 4914 ? 'offline/sandbox-only' : 'banned'));
          return;
        }
        if (code === 4006 || code === 4007 || code === 4009) {
          this.sessionId = null;
          this.lastSeq = null;
        }
        this.cleanupGateway();
        if (!this.isAborted && code !== 1000) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        this.logger.warn('[QQ Official] WebSocket error', { error: err.message });
        this.isConnecting = false;
        this.emitStatusChange();
      });
    } catch (e) {
      this.isConnecting = false;
      this.logger.warn('[QQ Official] Connection failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      this.scheduleReconnect();
    }
  }

  /** 连接 QQ（对应 QQChannel.connect，区分 official/onebot） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    this.isAborted = false;
    const mode = (cfg as { protocol?: string }).protocol || 'onebot';

    if (mode === 'official') {
      const config = cfg as { appId?: string; appSecret?: string };
      if (!config.appId || !config.appSecret) {
        this.status.lastError = 'Missing appId or appSecret for QQ Official Bot';
        return { success: false, error: this.status.lastError };
      }
      void this.connectGateway();
      // 等待连接建立（最多 15s）
      let waited = 0;
      while (!this.status.connected && waited < 15000) {
        await new Promise<void>((r) => setTimeout(r, 500));
        waited += 500;
      }
      if (this.status.connected) {
        return { success: true };
      }
      return { success: false, error: this.status.lastError || '连接超时' };
    }
    // onebot 模式
    const config = cfg as { wsUrl?: string; httpPort?: number };
    if (!config.wsUrl && !config.httpPort) {
      this.status.lastError = 'Missing wsUrl or httpPort for OneBot protocol';
      return { success: false, error: this.status.lastError };
    }
    await this.connectOneBot(cfg);
    return { success: !!this.status.connected, ...(this.status.lastError ? { error: this.status.lastError } : {}) };
  }

  /** 连接 OneBot（对应 connectOneBot，ws + http postback） */
  private async connectOneBot(cfg: Record<string, unknown>): Promise<void> {
    const config = cfg as {
      wsUrl?: string;
      httpPort?: number;
      httpAllowedIPs?: string[];
      httpHost?: string;
    };
    try {
      if (config.wsUrl) {
        this.logger.info('[QQ] Connecting via WebSocket to ' + config.wsUrl);
        this.ws = new WebSocket(config.wsUrl);

        this.ws.on('open', () => {
          this.logger.info('[QQ] WebSocket connected');
          this.status.connected = true;
          this.status.lastError = null;
        });

        this.ws.on('message', async (data: unknown) => {
          try {
            const raw = JSON.parse(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>;
            if (raw['post_type'] === 'message') {
              // 过滤 bot 自身发送的消息（OneBot 实现可能回传 bot 自己的消息）
              if (raw['sub_type'] === 'self' || raw['message_type'] === 'self') {
                this.logger.info('[QQ OneBot] Skipping self-message');
                return;
              }
              const rawUserId = raw['user_id'] as number | undefined;
              const rawSender = raw['sender'] as Record<string, unknown> | undefined;
              const from = rawUserId
                ? rawUserId.toString()
                : rawSender && rawSender['user_id']
                  ? (rawSender['user_id'] as number).toString()
                  : 'unknown';
              let text: unknown = raw['raw_message'] || raw['message'] || '';
              if (typeof text === 'object') text = JSON.stringify(text);
              this.lastSenderId = from;
              if (raw['group_id']) this.lastGroupId = (raw['group_id'] as number).toString();
              await this.handleIncomingMessage(from, String(text), {
                messageType: raw['message_type'] as string,
                groupId: raw['group_id'] ? (raw['group_id'] as number).toString() : '',
                messageId: raw['message_id'],
                raw,
              });
            } else if (
              raw['post_type'] === 'event' &&
              (raw['event'] === 'lifecycle' || raw['event'] === 'meta_event')
            ) {
              this.logger.info('[QQ] Event: ' + ((raw['sub_type'] as string) || (raw['event'] as string)));
            }
          } catch (e) {
            this.logger.warn('[QQ] WS message parse error', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });

        this.ws.on('error', (err: Error) => {
          this.logger.warn('[QQ] WebSocket error', { error: err.message });
          this.status.lastError = err.message;
          this.emitStatusChange();
        });

        this.ws.on('close', () => {
          this.logger.info('[QQ] WebSocket closed');
          this.status.connected = false;
          this.emitStatusChange();
        });
      }

      if (config.httpPort) {
        const qqAllowedIPs = config.httpAllowedIPs || [];
        const qqHttpHost = config.httpHost || '127.0.0.1';
        this.httpServer = createServer(async (req, res) => {
          // 来源 IP 白名单校验
          if (!this.checkIpAllowed(req, qqAllowedIPs)) {
            this.logger.info('[QQ] HTTP rejected: IP not allowed ' + (req.socket && req.socket.remoteAddress));
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'IP not allowed' }));
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(404);
            res.end();
            return;
          }
          const body: Buffer[] = [];
          req.on('data', (c) => body.push(c));
          req.on('end', async () => {
            try {
              const raw = JSON.parse(Buffer.concat(body).toString()) as Record<string, unknown>;
              if (raw['post_type'] === 'message') {
                if (raw['sub_type'] === 'self' || raw['message_type'] === 'self') {
                  res.writeHead(200);
                  res.end(JSON.stringify({ success: true }));
                  return;
                }
                const rawUserId = raw['user_id'] as number | undefined;
                const from = rawUserId ? rawUserId.toString() : 'unknown';
                let text: unknown = raw['raw_message'] || '';
                if (typeof text === 'object') text = JSON.stringify(text);
                this.lastSenderId = from;
                if (raw['group_id']) this.lastGroupId = (raw['group_id'] as number).toString();
                await this.handleIncomingMessage(from, String(text), {
                  messageType: raw['message_type'] as string,
                  groupId: raw['group_id'] ? (raw['group_id'] as number).toString() : '',
                  messageId: raw['message_id'],
                  raw,
                });
              }
              res.writeHead(200);
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
            }
          });
        });
        await this.safeListen(this.httpServer, config.httpPort, qqHttpHost);
        this.trackServer(this.httpServer);
        this.logger.info('[QQ] HTTP postback server on port ' + config.httpPort);
      }

      if (!this.status.connected && !this.httpServer) {
        this.status.lastError = 'No connection method established';
      } else if (this.httpServer) {
        this.status.connected = true;
        this.status.lastError = null;
        this.logger.info('[QQ] Connected via HTTP postback on port ' + config.httpPort);
      }
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.logger.warn('[QQ] OneBot connect error', { error: this.status.lastError });
      this.status.connected = false;
    }
  }

  /** 断开 QQ（对应 QQChannel.disconnect） */
  async disconnect(): Promise<void> {
    this.isAborted = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupGateway();
    await this.safeCloseServer(this.httpServer);
    this.httpServer = null;
    this.accessToken = null;
    this.tokenExpireAt = 0;
    this.sessionId = null;
    this.lastSeq = null;
    this.lastSenderId = null;
    this.lastGroupId = null;
    this.lastGroupOpenid = null;
    this.lastChannelId = null;
    this.lastGuildId = null;
    this.lastMsgType = null;
    this.reconnectAttempts = 0;
    this.isConnecting = false;
    this.status.connected = false;
  }

  /** 发送消息（对应 QQChannel.sendMessage，official API + ws + httpPostUrl） */
  async sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!to || to === 'me' || to === 'self') {
      to = this.lastSenderId || '';
      if (!to) return { success: false, error: '没有记录的联系人，请先从QQ给机器人发一条消息' };
    }
    const mode = (this.config as { protocol?: string }).protocol || 'onebot';

    if (mode === 'official') {
      if (!this.accessToken || (this.tokenExpireAt && Date.now() >= this.tokenExpireAt)) {
        try {
          await this.getAccessToken();
        } catch (e) {
          return { success: false, error: 'Token刷新失败: ' + (e instanceof Error ? e.message : String(e)) };
        }
      }
      try {
        let apiUrl: string;
        const msgType = (options && options.msgType) || this.lastMsgType || 'c2c';
        const msgSeq = Math.floor(Math.random() * 1000000) + 1;
        if (msgType === 'group' && (options?.['groupOpenid'] || this.lastGroupOpenid)) {
          apiUrl = 'https://api.sgroup.qq.com/v2/groups/' + String(options?.['groupOpenid'] || this.lastGroupOpenid) + '/messages';
        } else if (msgType === 'guild' && (options?.['channelId'] || this.lastChannelId)) {
          apiUrl = 'https://api.sgroup.qq.com/channels/' + String(options?.['channelId'] || this.lastChannelId) + '/messages';
        } else if (msgType === 'dm' && (options?.['guildId'] || this.lastGuildId)) {
          apiUrl = 'https://api.sgroup.qq.com/dms/' + String(options?.['guildId'] || this.lastGuildId) + '/messages';
        } else {
          apiUrl = 'https://api.sgroup.qq.com/v2/users/' + to + '/messages';
        }
        const reqBody = { content: text, msg_type: 0, msg_seq: msgSeq };
        const resp = await fetchWithTimeout(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + this.accessToken },
          body: JSON.stringify(reqBody),
        });
        const data = (await resp.json()) as { id?: string; message?: string };
        this.status.messagesSent++;
        return data.id ? { success: true, messageId: data.id } : { success: false, error: data.message || JSON.stringify(data) };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    const config = this.config as { wsUrl?: string; httpPostUrl?: string };

    if (config.wsUrl && this.ws && this.ws.readyState === 1) {
      try {
        const action = options && options.isGroup ? 'send_group_msg' : 'send_private_msg';
        const params =
          options && options.isGroup
            ? { group_id: parseInt(String(options?.['groupId'] || to), 10), message: text }
            : { user_id: parseInt(to, 10), message: text };
        this.ws.send(JSON.stringify({ action, params, echo: 'reply-' + Date.now() }));
        this.status.messagesSent++;
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    if (config.httpPostUrl) {
      try {
        await fetchWithTimeout(config.httpPostUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: options && options.isGroup ? 'send_group_msg' : 'send_private_msg',
            params:
              options && options.isGroup
                ? { group_id: parseInt(String(options?.['groupId'] || to), 10), message: text }
                : { user_id: parseInt(to, 10), message: text },
          }),
        });
        this.status.messagesSent++;
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    return { success: false, error: 'No send method available' };
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '自动目标: ' + this.lastSenderId : '需先从QQ给机器人发一条消息',
    };
  }

  /** 发送图片（对应 QQChannel.sendImage，official base64 + onebot CQ 码） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    try {
      if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
      const imageBuffer = readFileSync(imagePath);
      const ext = extname(imagePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      if (imageExts.indexOf(ext) < 0 && !imagePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
        return this.sendFile(imagePath, to);
      }
      const target = to || this.lastSenderId || '';
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[QQ] Sending image to ' + target + ': ' + imagePath);
      const mode = (this.config as { protocol?: string }).protocol || 'onebot';
      if (mode === 'official') {
        if (!this.accessToken || (this.tokenExpireAt && Date.now() >= this.tokenExpireAt)) {
          try {
            await this.getAccessToken();
          } catch (e) {
            return { success: false, error: 'Token刷新失败: ' + (e instanceof Error ? e.message : String(e)) };
          }
        }
        try {
          const base64Image = imageBuffer.toString('base64');
          const imgUrl = 'data:image/' + (ext.replace('.', '') || 'png') + ';base64,' + base64Image;
          let imgApiUrl: string;
          const imgMsgType = this.lastMsgType || 'c2c';
          if (imgMsgType === 'group' && this.lastGroupOpenid) {
            imgApiUrl = 'https://api.sgroup.qq.com/v2/groups/' + this.lastGroupOpenid + '/messages';
          } else {
            imgApiUrl = 'https://api.sgroup.qq.com/v2/users/' + target + '/messages';
          }
          const resp = await fetchWithTimeout(imgApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + this.accessToken },
            body: JSON.stringify({ content: imgUrl, msg_type: 4, msg_seq: Math.floor(Math.random() * 1000000) + 1 }),
          });
          const data = (await resp.json()) as { id?: string; message?: string };
          this.status.messagesSent++;
          return data.id ? { success: true, messageId: data.id } : { success: false, ...(data.message ? { error: data.message } : {}) };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      const config = this.config as { wsUrl?: string; httpPostUrl?: string };
      if (config.wsUrl && this.ws && this.ws.readyState === 1) {
        const isGroupImg = !!(to && this.lastGroupId);
        const action2 = isGroupImg ? 'send_group_msg' : 'send_private_msg';
        const targetId2 = isGroupImg ? parseInt(this.lastGroupId!, 10) : parseInt(target, 10);
        const cqCode = '[CQ:image,file=file:///' + imagePath.replace(/\\/g, '/').replace(/^\/+/, '') + ']';
        const imgParams = isGroupImg ? { group_id: targetId2, message: cqCode } : { user_id: targetId2, message: cqCode };
        this.ws.send(JSON.stringify({ action: action2, params: imgParams, echo: 'img-' + Date.now() }));
        this.status.messagesSent++;
        return { success: true };
      }

      if (config.httpPostUrl) {
        const isGroupImg3 = !!(to && this.lastGroupId);
        const action3 = isGroupImg3 ? 'send_group_msg' : 'send_private_msg';
        const targetId3 = isGroupImg3 ? parseInt(this.lastGroupId!, 10) : parseInt(target, 10);
        const cqCode3 = '[CQ:image,file=file:///' + imagePath.replace(/\\/g, '/').replace(/^\/+/, '') + ']';
        const imgParams3 = isGroupImg3 ? { group_id: targetId3, message: cqCode3 } : { user_id: targetId3, message: cqCode3 };
        await fetchWithTimeout(config.httpPostUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action3, params: imgParams3 }),
        });
        this.status.messagesSent++;
        return { success: true };
      }
      return { success: false, error: 'No send method available' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（对应 QQChannel.sendFile） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    try {
      if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const fileBuffer = readFileSync(filePath);
      const fileName = filePath.split(/[\\/]/).pop()!;
      const ext = extname(fileName).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0) {
        return this.sendImage(filePath, to);
      }
      const target = to || this.lastSenderId || '';
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[QQ] Sending file to ' + target + ': ' + fileName);

      const mode = (this.config as { protocol?: string }).protocol || 'onebot';
      if (mode === 'official') {
        if (!this.accessToken || (this.tokenExpireAt && Date.now() >= this.tokenExpireAt)) {
          try {
            await this.getAccessToken();
          } catch (e) {
            return { success: false, error: 'Token刷新失败: ' + (e instanceof Error ? e.message : String(e)) };
          }
        }
        try {
          let fileApiUrl: string;
          const fileMsgType = this.lastMsgType || 'c2c';
          if (fileMsgType === 'group' && this.lastGroupOpenid) {
            fileApiUrl = 'https://api.sgroup.qq.com/v2/groups/' + this.lastGroupOpenid + '/messages';
          } else {
            fileApiUrl = 'https://api.sgroup.qq.com/v2/users/' + target + '/messages';
          }
          const resp = await fetchWithTimeout(fileApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'QQBot ' + this.accessToken },
            body: JSON.stringify({
              content: '📎 文件: ' + fileName + ' (' + Math.round(fileBuffer.length / 1024) + 'KB)',
              msg_type: 0,
              msg_seq: Math.floor(Math.random() * 1000000) + 1,
            }),
          });
          const data = (await resp.json()) as { id?: string; message?: string };
          this.status.messagesSent++;
          return data.id ? { success: true, messageId: data.id } : { success: false, ...(data.message ? { error: data.message } : {}) };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      const config = this.config as { wsUrl?: string; httpPostUrl?: string };
      if (config.wsUrl && this.ws && this.ws.readyState === 1) {
        const isGroupFile = !!(to && this.lastGroupId);
        const action4 = isGroupFile ? 'send_group_msg' : 'send_private_msg';
        const targetId4 = isGroupFile ? parseInt(this.lastGroupId!, 10) : parseInt(target, 10);
        const cqCode4 = '[CQ:file,file=file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') + ']';
        const fileParams4 = isGroupFile ? { group_id: targetId4, message: cqCode4 } : { user_id: targetId4, message: cqCode4 };
        this.ws.send(JSON.stringify({ action: action4, params: fileParams4, echo: 'file-' + Date.now() }));
        this.status.messagesSent++;
        return { success: true };
      }

      if (config.httpPostUrl) {
        const isGroupFile5 = !!(to && this.lastGroupId);
        const action5 = isGroupFile5 ? 'send_group_msg' : 'send_private_msg';
        const targetId5 = isGroupFile5 ? parseInt(this.lastGroupId!, 10) : parseInt(target, 10);
        const cqCode5 = '[CQ:file,file=file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') + ']';
        const fileParams5 = isGroupFile5 ? { group_id: targetId5, message: cqCode5 } : { user_id: targetId5, message: cqCode5 };
        await fetchWithTimeout(config.httpPostUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action5, params: fileParams5 }),
        });
        this.status.messagesSent++;
        return { success: true };
      }
      return { success: false, error: 'No send method available' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
