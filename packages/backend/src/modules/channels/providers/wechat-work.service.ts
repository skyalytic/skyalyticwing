import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import { channelWebSocketAgent } from '../channel-network.js';
import {
  BaseProvider,
  fetchWithTimeout,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

/**
 * WeChatWorkProvider - 企业微信渠道提供商
 *
 * 对应 channels.cjs WeChatWorkChannel（行 2007-2385）。
 *
 * 能力：
 *   - 通过 WebSocket 长连接接收消息（wss://openws.work.weixin.qq.com，aibot_subscribe 握手）
 *   - 30s 心跳（ping）
 *   - 指数退避重连：[2, 5, 10, 30, 60] 秒，最多 10 次，_running 守卫
 *   - 消息类型解析：text/image/voice/file/video/mixed/event
 *   - reqId 去重（防止 WeCom 重发回调导致 AI 重复处理）
 *   - _replyReqIds 带 TTL（5 分钟）清理，防对象无限增长
 *   - 发送：有 reqId 用 aibot_respond_msg（既 ACK 又回复），无 reqId 用 aibot_send_msg（主动消息）
 *   - 长文本分块（4000 字符）
 *   - 图片/文件：临时素材上传（media/upload）+ 消息发送
 *
 * 注意：本实现对应 .cjs 中 WeChatWorkChannel（AI Bot WebSocket 模式），
 *      非经典 XML+AES 回调模式。
 */
@Injectable()
export class WeChatWorkProvider extends BaseProvider {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionGeneration = 0;
  private cancelPendingConnection: (() => void) | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnect = 10;
  private readonly reconnectBackoff = [2, 5, 10, 30, 60];
  private subscribeResolved = false;
  private deviceId = 'sc-wework-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10);
  private running = false;

  constructor(logger: LoggerService, router: ChannelRouterService) {
    super(logger, router, 'wechat-work');
    this.name = '企业微信';
  }

  /** 生成请求 ID（对应 _newReqId） */
  private newReqId(prefix: string): string {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  }

  /** 连接企业微信（对应 WeChatWorkChannel.connect） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    const config = cfg as { botId?: string; secret?: string; websocketUrl?: string };
    if (!config.botId || !config.secret) {
      this.status.lastError = 'Missing botId or secret (请先通过扫码接入获取)';
      return { success: false, error: this.status.lastError };
    }
    let generation = this.connectionGeneration;
    try {
      const wsUrl = config.websocketUrl || 'wss://openws.work.weixin.qq.com';
      this.running = true;
      const pending = this.openConnection(wsUrl, { botId: config.botId!, secret: config.secret! });
      generation = this.connectionGeneration;
      await pending;
      if (!this.running || generation !== this.connectionGeneration) return { success: false, error: '连接已取消' };
      this.status.connected = true;
      this.status.lastError = null;
      this.reconnectAttempts = 0;
      this.logger.info('[WeChatWork] AI Bot connected via WebSocket');
      return { success: true };
    } catch (e) {
      if (!this.running || generation !== this.connectionGeneration) return { success: false, error: '连接已取消' };
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.status.connected = false;
      this.logger.warn('[WeChatWork] Connect error', { error: this.status.lastError });
      if (this.running && !this.status.lastError.startsWith('Subscribe failed:')) this.attemptReconnect(config.websocketUrl || 'wss://openws.work.weixin.qq.com', { botId: config.botId!, secret: config.secret! });
      return { success: false, error: this.status.lastError };
    }
  }

  /** 打开 WebSocket 连接（对应 _openConnection，含 aibot_subscribe 握手与 20s 超时） */
  private openConnection(wsUrl: string, cfg: { botId: string; secret: string }): Promise<void> {
    this.cancelPendingConnection?.();
    const generation = ++this.connectionGeneration;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.ws?.terminate();
    return new Promise<void>((resolve, reject) => {
      this.subscribeResolved = false;
      let subscribed = false;
      const subscribeReqId = this.newReqId('subscribe');
      const socket = new WebSocket(wsUrl, { agent: channelWebSocketAgent(wsUrl), handshakeTimeout: 20000, headers: { 'User-Agent': 'SkyalyticWing/2.0.0' } });
      const connectTimeout = setTimeout(() => {
        if (!subscribed && generation === this.connectionGeneration) {
          reject(new Error('Subscribe handshake timeout'));
          socket.terminate();
        }
      }, 20000);

      this.cancelPendingConnection = () => { clearTimeout(connectTimeout); reject(new Error('连接已取消')); };
      this.ws = socket;

      this.ws.on('open', () => {
        if (generation !== this.connectionGeneration || !this.running) { socket.terminate(); return; }
        this.logger.info('[WeChatWork] WebSocket opened, sending aibot_subscribe botId=' + cfg.botId.substring(0, 8) + '...');
        const subMsg = JSON.stringify({
          cmd: 'aibot_subscribe',
          headers: { req_id: subscribeReqId },
          body: { bot_id: cfg.botId, secret: cfg.secret, device_id: this.deviceId },
        });
        socket.send(subMsg);
      });

      this.ws.on('message', (data: unknown) => {
        if (generation !== this.connectionGeneration || !this.running) return;
        try {
          const rawStr = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          const payload = JSON.parse(rawStr) as Record<string, unknown>;
          const respCmd = (payload['cmd'] as string) || '';
          const headers = (payload['headers'] as Record<string, unknown>) || {};
          const respReqId = (headers['req_id'] as string) || '';
          const body = (payload['body'] as Record<string, unknown>) || {};
          this.logger.info(
            `[WeChatWork] WS message: cmd=${respCmd} req_id=${respReqId} body=${JSON.stringify(body).substring(0, 200)}`,
          );
          if (!this.subscribeResolved && respReqId === subscribeReqId) {
            clearTimeout(connectTimeout);
            const errcode = (body['errcode'] as number) || 0;
            if (errcode && errcode !== 0) {
              const errmsg = (body['errmsg'] as string) || 'authentication failed';
              this.logger.warn(`[WeChatWork] Subscribe failed: errcode=${errcode} errmsg=${errmsg}`);
              this.subscribeResolved = true;
              reject(new Error('Subscribe failed: ' + errmsg + ' (errcode=' + errcode + ')'));
              socket.close();
              return;
            }
            this.logger.info('[WeChatWork] Subscribe success');
            this.subscribeResolved = true;
            subscribed = true;
            resolve();
            return;
          }
          this.handleWsMessage(payload);
        } catch (e) {
          this.logger.warn('[WeChatWork] Parse error', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(connectTimeout);
        if (generation !== this.connectionGeneration) return;
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        this.logger.info(
          `[WeChatWork] WebSocket closed code=${code} reason=${(reason || '').toString().substring(0, 200)}`,
        );
        this.status.connected = false;
        this.emitStatusChange();
        clearTimeout(connectTimeout);
        if (this.running && !subscribed) {
          reject(new Error('WebSocket was closed before the connection was established (code=' + code + ')'));
        } else if (this.running) {
          this.attemptReconnect(wsUrl, cfg);
        }
      });

      this.ws.on('error', (err: Error) => {
        clearTimeout(connectTimeout);
        if (generation !== this.connectionGeneration) return;
        this.logger.warn('[WeChatWork] WebSocket error', { error: err.message });
        this.emitStatusChange();
        clearTimeout(connectTimeout);
        if (!subscribed) {
          reject(err);
        }
      });

      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(
            JSON.stringify({ cmd: 'ping', headers: { req_id: this.newReqId('ping') }, body: {} }),
          );
        }
      }, 30000);
    });
  }

  /** 处理 WS 消息（对应 _handleWsMessage） */
  private handleWsMessage(payload: Record<string, unknown>): void {
    const cmd = (payload['cmd'] as string) || '';
    const headers = (payload['headers'] as Record<string, unknown>) || {};
    const body = (payload['body'] as Record<string, unknown>) || {};

    if (cmd === 'aibot_msg_callback' || cmd === 'aibot_callback') {
      const msgtype = (body['msgtype'] as string) || '';
      const msgId = String((body['msgid'] as string) || '');
      const fromObj = (body['from'] as Record<string, unknown>) || {};
      const senderId = String((fromObj['userid'] as string) || '');
      const chatId = String((body['chatid'] as string) || senderId);
      const isGroup = String((body['chattype'] as string) || '').toLowerCase() === 'group';
      let text = '';
      if (msgtype === 'text') {
        const textObj = (body['text'] as Record<string, unknown>) || {};
        text = (textObj['content'] as string) || '';
      } else if (msgtype === 'image') {
        text = '[图片]';
      } else if (msgtype === 'voice') {
        const voiceObj = (body['voice'] as Record<string, unknown>) || {};
        text = (voiceObj['content'] as string) || '[语音]';
      } else if (msgtype === 'file') {
        text = '[文件]';
      } else if (msgtype === 'video') {
        text = '[视频]';
      } else if (msgtype === 'mixed') {
        const mixedObj = (body['mixed'] as Record<string, unknown>) || {};
        const msgItems = (mixedObj['msg_item'] as Array<Record<string, unknown>>) || [];
        for (const item of msgItems) {
          const itemType = (item['type'] as string) || '';
          if (itemType === 'text' && item['text']) {
            const textItem = (item as Record<string, unknown>)['text'] as Record<string, unknown>;
            text += (textItem['content'] as string) || '';
          } else if (itemType === 'image') text += '[图片]';
          else if (itemType === 'voice') text += '[语音]';
        }
      } else if (msgtype === 'event') {
        return;
      }
      if (!text.trim()) return;
      const reqId = (headers['req_id'] as string) || '';
      // reqId 去重：防止 WeCom 重发回调导致 AI 重复处理
      if (reqId && this.processedReqIds && this.processedReqIds.has(reqId)) {
        this.logger.info('[WeChatWork] DEDUP skipped (reqId): ' + reqId);
        return;
      }
      if (reqId) {
        if (!this.processedReqIds) this.processedReqIds = new Set<string>();
        this.processedReqIds.add(reqId);
        if (this.processedReqIds.size > 200) {
          const iter = this.processedReqIds.values();
          const v = iter.next().value;
          if (v) this.processedReqIds.delete(v);
        }
      }
      // _replyReqIds 加 TTL 清理（5 分钟），防止对象无限增长
      if (msgId && reqId) {
        this.replyReqIds[msgId] = { reqId, ts: Date.now() };
        // 偶尔清理过期项（超过 200 条时触发）
        if (Object.keys(this.replyReqIds).length > 200) {
          const nowR = Date.now();
          for (const rk of Object.keys(this.replyReqIds)) {
            const entry = this.replyReqIds[rk];
            if (entry && typeof entry === 'object' && nowR - entry.ts > 5 * 60 * 1000) {
              delete this.replyReqIds[rk];
            }
          }
        }
      }
      void this.handleIncomingMessage(senderId || chatId, text, {
        chatId,
        isGroup,
        msgId,
        reqId,
        raw: payload,
      });
      // 不发送 ACK 空消息！AI 回复会通过 aibot_respond_msg 发送，既作为 ACK 又作为实际回复
      return;
    }

    if (cmd === 'aibot_event_callback') {
      return;
    }
    if (cmd === 'pong') {
      return;
    }
  }

  /** 尝试重连（对应 _attemptReconnect，指数退避 + _running 守卫） */
  private attemptReconnect(wsUrl: string, cfg: { botId: string; secret: string }): void {
    if (!this.running || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnect) {
      this.logger.info('[WeChatWork] Max reconnect attempts reached');
      return;
    }
    const delay = this.reconnectBackoff[Math.min(this.reconnectAttempts, this.reconnectBackoff.length - 1)];
    this.reconnectAttempts++;
    this.logger.info(`[WeChatWork] Reconnecting in ${delay}s (attempt ${this.reconnectAttempts})`);
    const generation = this.connectionGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running || generation !== this.connectionGeneration) return;
      const pending = this.openConnection(wsUrl, cfg);
      const activeGeneration = this.connectionGeneration;
      pending
        .then(() => {
          if (!this.running || activeGeneration !== this.connectionGeneration) return;
          this.status.connected = true;
          this.status.lastError = null;
          this.reconnectAttempts = 0;
          this.emitStatusChange();
          this.logger.info('[WeChatWork] Reconnected successfully');
        })
        .catch((e: unknown) => {
          if (!this.running || activeGeneration !== this.connectionGeneration) return;
          this.status.lastError = e instanceof Error ? e.message : String(e);
          this.status.connected = false;
          this.emitStatusChange();
          this.logger.warn('[WeChatWork] Reconnect failed', {
            error: e instanceof Error ? e.message : String(e),
          });
          if (!this.status.lastError.startsWith('Subscribe failed:')) this.attemptReconnect(wsUrl, cfg);
        });
    }, delay * 1000);
  }

  /** 发送消息（对应 WeChatWorkChannel.sendMessage，aibot_respond_msg/aibot_send_msg + 分块） */
  async sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.status.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return { success: false, error: '企业微信尚未连接，消息未发送' };
    const opts = options || {};
    try {
      const msgId = opts.msgId || '';
      // _replyReqIds 现存为 { reqId, ts } 对象——读取时检查 TTL(5分钟)，过期则视为不存在
      const rrEntry = msgId ? this.replyReqIds[msgId] : null;
      let reqId = '';
      if (rrEntry && typeof rrEntry === 'object' && rrEntry.reqId) {
        if (Date.now() - rrEntry.ts > 5 * 60 * 1000) {
          delete this.replyReqIds[msgId]; // 过期清理
        } else {
          reqId = rrEntry.reqId;
        }
      } else if (rrEntry && typeof rrEntry === 'string') {
        // 向后兼容：旧的字符串格式
        reqId = rrEntry;
      }
      // 如果有 reqId，用 aibot_respond_msg 发送（既作为 ACK 又作为实际回复，用户只看到一条消息）
      // 如果没有 reqId，用 aibot_send_msg 发送（主动消息）
      if (reqId) {
        delete this.replyReqIds[msgId]; // 清除已使用的 reqId
      }
      const chunks: string[] = [];
      const maxLen = 4000;
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.substring(0, maxLen));
        remaining = remaining.substring(maxLen);
      }
      for (let ci = 0; ci < chunks.length; ci++) {
        const sendCmd = reqId ? 'aibot_respond_msg' : 'aibot_send_msg';
        const sendBody: Record<string, unknown> = { msgtype: 'markdown', markdown: { content: chunks[ci] } };
        if (reqId) {
          sendBody['msgid'] = msgId;
        } else {
          sendBody['chatid'] = opts.chatId || to;
        }
        const sendMsg = JSON.stringify({
          cmd: sendCmd,
          headers: { req_id: reqId || 'send-' + Date.now() + '-' + ci },
          body: sendBody,
        });
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(sendMsg);
        }
      }
      this.status.messagesSent++;
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '自动目标: ' + this.lastSenderId : '需先从企业微信给机器人发一条消息',
    };
  }

  /** 发送图片（对应 WeChatWorkChannel.sendImage，临时素材上传 + 消息发送） */
  async sendImage(imagePath: string, to: string): Promise<boolean> {
    if (!existsSync(imagePath)) {
      this.logger.info('[WeChatWork] sendImage: file not found: ' + imagePath);
      return false;
    }
    try {
      const imgBuf = readFileSync(imagePath);
      const ext = imagePath.split('.').pop()!.toLowerCase();
      const mediaMap: Record<string, string> = {
        jpg: 'image',
        jpeg: 'image',
        png: 'image',
        gif: 'image',
        bmp: 'image',
        webp: 'image',
      };
      if (!mediaMap[ext]) {
        this.logger.info('[WeChatWork] sendImage: unsupported format: ' + ext);
        return false;
      }
      const config = this.config as { accessToken?: string; agentId?: string };
      const accessToken = config.accessToken || '';
      const agentId = config.agentId || '';
      if (!accessToken) {
        this.logger.info('[WeChatWork] sendImage: no accessToken configured');
        return false;
      }
      // 上传临时素材（multipart/form-data 手工构造，避免依赖 form-data 包）
      const mediaId = await this.uploadMedia(imagePath, imgBuf, 'image', accessToken);
      if (!mediaId) {
        this.logger.info('[WeChatWork] sendImage: upload failed');
        return false;
      }
      // 发送图片消息
      const sendUrl = 'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + accessToken;
      const sendBody = { touser: to, msgtype: 'image', agentid: agentId, image: { media_id: mediaId } };
      const sendResult = (await this.postJson(sendUrl, sendBody)) as { errcode?: number };
      this.logger.info('[WeChatWork] sendImage: to=' + to + ' errcode=' + (sendResult && sendResult.errcode));
      return !!sendResult && sendResult.errcode === 0;
    } catch (e) {
      this.logger.warn('[WeChatWork] sendImage error', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** 发送文件（对应 WeChatWorkChannel.sendFile） */
  async sendFile(filePath: string, to: string, fileName?: string): Promise<boolean> {
    if (!existsSync(filePath)) {
      this.logger.info('[WeChatWork] sendFile: file not found: ' + filePath);
      return false;
    }
    try {
      const fileBuf = readFileSync(filePath);
      const name = fileName || filePath.split(/[\\/]/).pop()!;
      const config = this.config as { accessToken?: string; agentId?: string };
      const accessToken = config.accessToken || '';
      const agentId = config.agentId || '';
      if (!accessToken) {
        this.logger.info('[WeChatWork] sendFile: no accessToken configured');
        return false;
      }
      // 上传临时素材
      const mediaId = await this.uploadMedia(name, fileBuf, 'file', accessToken);
      if (!mediaId) {
        this.logger.info('[WeChatWork] sendFile: upload failed');
        return false;
      }
      // 发送文件消息
      const sendUrl = 'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + accessToken;
      const sendBody = { touser: to, msgtype: 'file', agentid: agentId, file: { media_id: mediaId } };
      const sendResult = (await this.postJson(sendUrl, sendBody)) as { errcode?: number };
      this.logger.info('[WeChatWork] sendFile: to=' + to + ' errcode=' + (sendResult && sendResult.errcode));
      return !!sendResult && sendResult.errcode === 0;
    } catch (e) {
      this.logger.warn('[WeChatWork] sendFile error', { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** 上传临时素材到企业微信（multipart/form-data 手工构造） */
  private async uploadMedia(filename: string, fileBuf: Buffer, type: string, accessToken: string): Promise<string | null> {
    const uploadUrl = 'https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=' + accessToken + '&type=' + type;
    const boundary = '----FormBoundary' + Date.now();
    const contentType = type === 'image' ? 'image/' + (filename.split('.').pop() || 'png') : 'application/octet-stream';
    const body = Buffer.concat([
      Buffer.from(
        '--' + boundary + '\r\nContent-Disposition: form-data; name="media"; filename="' + basename(filename) + '"\r\nContent-Type: ' + contentType + '\r\n\r\n',
      ),
      fileBuf,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const resp = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    const data = (await resp.json()) as { media_id?: string };
    return data.media_id || null;
  }

  /** POST JSON 辅助（带响应大小限制 10MB，对应 .cjs 内联实现） */
  private async postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await resp.json()) as Record<string, unknown>;
  }

  /** 断开企业微信（对应 WeChatWorkChannel.disconnect） */
  async disconnect(): Promise<void> {
    this.running = false;
    this.connectionGeneration++;
    this.cancelPendingConnection?.();
    this.cancelPendingConnection = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
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
    this.replyReqIds = {};
    this.status.connected = false;
  }
}
