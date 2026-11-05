import { Injectable } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { HttpClientService } from '../../core/http/http-client.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import {
  BaseProvider,
  fetchWithTimeout,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

// ============================================================
// Telegram Bot API 类型（最小结构定义）
// ============================================================

/** getMe 响应用户对象 */
interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

/** Bot API 通用响应包装 */
interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/** Telegram 消息对象（仅用到字段） */
interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number };
}

/** Telegram 更新对象 */
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: TgMessage;
  };
}

/** sendMessage / sendPhoto / sendDocument 响应结果 */
interface TgMessageResult {
  message_id: number;
}

/**
 * TelegramProvider - Telegram 渠道提供商
 *
 * 对应 channels.cjs TelegramChannel（行 330-491）。
 *
 * 实现方式：直接调用 Bot API（https://api.telegram.org/bot<token>/<method>），
 * 经 HttpClientService（SSRF 校验 + 超时），不依赖 grammy SDK。
 *
 * 能力：
 *   - connect：getMe 验证 token
 *   - 接收（二选一，对齐旧版双模式）：
 *     1. webhook 模式：配置 webhookUrl + webhookSecret 时，本地起 HTTP 服务器
 *        （webhookPort 默认 8787）接收更新并调用 setWebhook 注册
 *     2. 轮询模式：getUpdates 长轮询（timeout=25s，请求超时 35s）
 *   - sendMessage：POST sendMessage { chat_id, text }
 *   - 图片/文件发送：sendPhoto / sendDocument（multipart，fetch + FormData）
 */
@Injectable()
export class TelegramProvider extends BaseProvider {
  /** Bot API 基地址（token 拼在路径中，禁止打印完整 URL 防泄漏） */
  private readonly apiBase = 'https://api.telegram.org';
  /** 长轮询开关 */
  private polling = false;
  /** 轮询代数：每次启动新轮询/断开时递增，旧循环检测到代数变化即退出（防双循环 409） */
  private pollEpoch = 0;
  /** getUpdates offset（上次最大 update_id + 1） */
  private updateOffset = 0;
  /** webhook HTTP 服务器 */
  private webhookServer: Server | null = null;
  /** 发送者 → 最近 chatId（群聊时回复到对应 chat） */
  private readonly chatIds = new Map<string, string>();

  constructor(
    logger: LoggerService,
    router: ChannelRouterService,
    private readonly http: HttpClientService,
  ) {
    super(logger, router, 'telegram');
    this.name = 'Telegram';
  }

  /** 构造 Bot API URL（含 token，注意不要写入日志） */
  private methodUrl(method: string): string {
    const token = String((this.config as { botToken?: string })?.botToken || '');
    return `${this.apiBase}/bot${token}/${method}`;
  }

  /** 调用 Bot API（GET + query 参数） */
  private async callApi<T>(method: string, params?: Record<string, unknown>): Promise<TgApiResponse<T>> {
    const qs = params
      ? '?' +
        new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()
      : '';
    const resp = await this.http.get<TgApiResponse<T>>(this.methodUrl(method) + qs, {
      timeout: 35_000,
      responseType: 'json',
    });
    return resp.data;
  }

  /** 调用 Bot API（POST JSON） */
  private async postApi<T>(method: string, body: Record<string, unknown>): Promise<TgApiResponse<T>> {
    const resp = await this.http.post<TgApiResponse<T>>(this.methodUrl(method), body, {
      timeout: 35_000,
      responseType: 'json',
      headers: { 'Content-Type': 'application/json' },
    });
    return resp.data;
  }

  /** 连接 Telegram（对应 TelegramChannel.connect：getMe 验证 → webhook/轮询） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    const botToken = cfg['botToken'];
    if (!botToken) {
      this.status.lastError = 'Missing botToken';
      return { success: false, error: this.status.lastError };
    }
    try {
      // getMe 验证 token
      const me = await this.callApi<TgUser>('getMe');
      if (!me.ok || !me.result) {
        throw new Error(me.description || 'getMe failed (invalid token?)');
      }
      const botUsername = me.result.username || String(me.result.id);
      this.logger.info('[Telegram] Bot verified: @' + botUsername);

      if (cfg['webhookUrl'] && cfg['webhookSecret']) {
        await this.startWebhookMode(cfg);
      } else {
        this.startPollingMode();
      }

      this.status.connected = true;
      this.status.lastError = null;
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.logger.warn('[Telegram] Connect error', { error: this.status.lastError });
      this.status.connected = false;
      return { success: false, error: this.status.lastError };
    }
  }

  /** webhook 模式：本地 HTTP 服务器 + setWebhook（对齐旧版） */
  private async startWebhookMode(cfg: Record<string, unknown>): Promise<void> {
    const webhookUrl = String(cfg['webhookUrl']);
    const webhookSecret = String(cfg['webhookSecret']);
    const port = Number(cfg['webhookPort'] || 8787);
    const path = String(cfg['webhookPath'] || '/telegram-webhook');
    const host = String(cfg['webhookHost'] || '0.0.0.0'); // webhook 需接收外部回调

    this.webhookServer = createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url !== path || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      // secret token 校验（防伪造）
      const secret = req.headers['x-telegram-bot-api-secret-token'];
      if (secret !== webhookSecret) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => {
        try {
          const update = JSON.parse(Buffer.concat(body).toString('utf8')) as TgUpdate;
          void this.processUpdate(update);
          res.writeHead(200);
          res.end('ok');
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    });
    await this.safeListen(this.webhookServer, port, host);
    this.trackServer(this.webhookServer);
    this.logger.info('[Telegram] Webhook listening on port ' + port);

    // 注册 webhook 到 Telegram
    const hook = await this.postApi<boolean>('setWebhook', {
      url: webhookUrl,
      secret_token: webhookSecret,
    });
    if (!hook.ok) {
      throw new Error('setWebhook failed: ' + (hook.description || 'unknown'));
    }
    this.logger.info('[Telegram] Webhook set: ' + webhookUrl);
  }

  /** 轮询模式：getUpdates 长轮询循环（epoch 隔离，重连后旧循环自动退出） */
  private startPollingMode(): void {
    this.polling = true;
    const myEpoch = ++this.pollEpoch;
    this.logger.info('[Telegram] Starting polling mode...');
    const loop = async (): Promise<void> => {
      while (this.polling && this.pollEpoch === myEpoch) {
        try {
          const params: Record<string, unknown> = {
            offset: this.updateOffset,
            timeout: 25,
            allowed_updates: JSON.stringify(['message', 'callback_query']),
          };
          const resp = await this.callApi<TgUpdate[]>('getUpdates', params);
          if (!resp.ok) {
            this.logger.warn('[Telegram] getUpdates error: ' + (resp.description || 'unknown'));
            await this.sleep(3000);
            continue;
          }
          const result = resp.result;
          let updates: TgUpdate[] = [];
          if (Array.isArray(result)) {
            updates = result;
          } else if (result && typeof result === 'object') {
            // 兼容某些网关返回 { updates: [...] } 包装
            const wrapped = (result as unknown as { updates?: TgUpdate[] }).updates;
            if (Array.isArray(wrapped)) updates = wrapped;
          }
          for (const update of updates) {
            this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
            await this.processUpdate(update);
          }
        } catch (e) {
          if (this.polling && this.pollEpoch === myEpoch) {
            this.logger.warn('[Telegram] Polling error', {
              error: e instanceof Error ? e.message : String(e),
            });
            await this.sleep(3000);
          }
        }
      }
    };
    void loop();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 处理单条更新（对应 grammy bot.on('message') / on('callback_query')） */
  private async processUpdate(update: TgUpdate): Promise<void> {
    if (update.message) {
      const chatId = String(update.message.chat.id);
      this.lastSenderId = chatId;
      this.chatIds.set(chatId, chatId);
      const text = update.message.text || update.message.caption || '';
      if (!text) return;
      await this.handleIncomingMessage(chatId, text, {
        chatId,
        messageId: update.message.message_id,
        raw: update as unknown as Record<string, unknown>,
      });
    } else if (update.callback_query) {
      const cb = update.callback_query;
      const fromId = String(cb.from.id);
      const chatId = cb.message ? String(cb.message.chat.id) : fromId;
      this.lastSenderId = fromId;
      this.chatIds.set(fromId, chatId);
      const text = '[button] ' + (cb.data || '');
      await this.handleIncomingMessage(fromId, text, {
        chatId,
        messageId: 0,
        isCallback: true,
        raw: update as unknown as Record<string, unknown>,
      });
    }
  }

  /** 断开 Telegram（对应 TelegramChannel.disconnect） */
  async disconnect(): Promise<void> {
    this.polling = false;
    // 递增 epoch 使所有在途轮询循环立即失效（即使其正在 await 中，醒来后条件不满足即退出）
    this.pollEpoch++;
    await this.safeCloseServer(this.webhookServer);
    this.webhookServer = null;
    this.lastSenderId = null;
    this.chatIds.clear();
    this.status.connected = false;
  }

  /** 发送消息（对应 TelegramChannel.sendMessage：POST sendMessage {chat_id, text}） */
  async sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.status.connected && !(this.config as { botToken?: string })?.botToken) {
      return { success: false, error: 'Not connected' };
    }
    try {
      let chatId = to;
      if (!chatId || chatId === 'me' || chatId === 'self') {
        chatId = this.lastSenderId || '';
        if (!chatId) {
          return { success: false, error: '无法确定目标。请先在Telegram中给机器人发消息。' };
        }
      }
      if (options && options.chatId) chatId = String(options.chatId);
      chatId = this.chatIds.get(chatId) || chatId;

      const resp = await this.postApi<TgMessageResult>('sendMessage', {
        chat_id: chatId,
        // parse_mode:HTML 对齐旧版 channels.cjs；先转义 & < > 防止裸实体导致 API 解析错误
        text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        parse_mode: 'HTML',
      });
      if (!resp.ok) {
        return { success: false, error: resp.description || 'sendMessage failed' };
      }
      this.status.messagesSent++;
      const mid = resp.result ? String(resp.result.message_id) : '';
      return mid ? { success: true, messageId: mid } : { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '目标: ' + this.lastSenderId : '需先在Telegram发消息',
    };
  }

  /** 解析发送目标（me/self → 最近发送者对应的 chat） */
  private resolveTarget(to?: string): string {
    const target = to || this.lastSenderId || '';
    return this.chatIds.get(target) || target;
  }

  /** 发送图片（对应 TelegramChannel.sendImage：sendPhoto multipart） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    try {
      if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
      const ext = extname(imagePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'];
      if (imageExts.indexOf(ext) < 0 && !imagePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
        return this.sendFile(imagePath, to);
      }
      const target = this.resolveTarget(to);
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[Telegram] Sending image to ' + target + ': ' + imagePath);
      const form = new FormData();
      form.append('chat_id', target);
      form.append('photo', new Blob([readFileSync(imagePath)]), basename(imagePath));
      const resp = await fetchWithTimeout(this.methodUrl('sendPhoto'), { method: 'POST', body: form });
      const data = (await resp.json()) as TgApiResponse<TgMessageResult>;
      if (!data.ok) return { success: false, error: data.description || 'sendPhoto failed' };
      this.status.messagesSent++;
      const mid = data.result ? String(data.result.message_id) : '';
      return mid ? { success: true, messageId: mid } : { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（对应 TelegramChannel.sendFile：sendDocument multipart） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    try {
      if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const fileName = basename(filePath);
      const ext = extname(fileName).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0) {
        return this.sendImage(filePath, to);
      }
      const target = this.resolveTarget(to);
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[Telegram] Sending file to ' + target + ': ' + fileName);
      const form = new FormData();
      form.append('chat_id', target);
      form.append('document', new Blob([readFileSync(filePath)]), fileName);
      const resp = await fetchWithTimeout(this.methodUrl('sendDocument'), { method: 'POST', body: form });
      const data = (await resp.json()) as TgApiResponse<TgMessageResult>;
      if (!data.ok) return { success: false, error: data.description || 'sendDocument failed' };
      this.status.messagesSent++;
      const mid = data.result ? String(data.result.message_id) : '';
      return mid ? { success: true, messageId: mid } : { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
