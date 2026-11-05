import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { HttpClientService } from '../../core/http/http-client.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import {
  BaseProvider,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

// ============================================================
// iLink Bot API 类型（最小结构定义）
// ============================================================

/** iLink 消息 item */
interface WxMsgItem {
  type: number;
  text_item?: { text?: string };
  image_item?: { file_path?: string };
  file_item?: { file_path?: string; file_name?: string };
}

/** iLink 收到的消息 */
interface WxIncomingMsg {
  from_user_id?: string;
  context_token?: string;
  msg_id?: string | number;
  message_id?: string | number;
  id?: string | number;
  create_time?: number;
  send_time?: number;
  item_list?: WxMsgItem[];
}

/** getupdates 响应 */
interface WxGetUpdatesResponse {
  errcode?: number;
  errmsg?: string;
  ret?: number;
  get_updates_buf?: string;
  msgs?: WxIncomingMsg[];
}

/** sendmessage 响应 */
interface WxSendMessageResponse {
  errcode?: number;
  errmsg?: string;
  ret?: number;
}

/** iLink 请求头（对应旧版 _wxFetch 的头集合） */
const ILINK_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  AuthorizationType: 'ilink_bot_token',
  'User-Agent': 'SkyalyticWing/2.0.0',
};

/** 长文本分块上限（对齐旧版 4000 字符） */
const MAX_CHUNK_LEN = 4000;
/** 轮询间隔 */
const POLL_INTERVAL_MS = 5000;
/** echo 缓存有效期（60s，防止 iLink 回传自己的回复） */
const ECHO_TTL_MS = 60_000;

/**
 * WeixinProvider - 微信（个人号 iLink Bot）渠道提供商
 *
 * 对应 channels.cjs WeixinChannel（行 3149-3390）。
 *
 * botToken 通过 WechatService 的扫码登录流程获取
 * （/api/weixin/qr + /api/weixin/poll，见 channels/wechat/wechat.service.ts），
 * 本 provider 负责 token 之后的消息收发：
 *   - 接收：POST /ilink/bot/getupdates 轮询（5s，get_updates_buf 游标）
 *   - 发送：POST /ilink/bot/sendmessage（context_token 路由会话，4000 字符分块）
 *   - echo 缓存：60s 内与最近发送文本匹配的消息跳过（防自回复循环）
 *   - 发送者处理锁：同一 sender 处理中跳过新消息（防并发重复 AI 调用）
 */
@Injectable()
export class WeixinProvider extends BaseProvider {
  /** 轮询定时器 */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private polling = false;
  /** getupdates 游标 */
  private cursor = '';
  /** 发送者 → 最近 context_token（iLink 路由会话必需） */
  private readonly contextTokens = new Map<string, string>();
  /** echo 检测缓存：消息文本前缀 → 发送时间 */
  private readonly echoCache = new Map<string, number>();
  /** 处理锁：sender → 加锁时间 */
  private readonly processingSenders = new Map<string, number>();
  /** iLink API 基地址 */
  private baseUrl = 'https://ilinkai.weixin.qq.com';

  constructor(
    logger: LoggerService,
    router: ChannelRouterService,
    private readonly http: HttpClientService,
  ) {
    super(logger, router, 'weixin');
    this.name = '微信';
  }

  /** 构造 iLink 请求头（附带 Bearer token） */
  private ilinkHeaders(): Record<string, string> {
    const token = String((this.config as { botToken?: string })?.botToken || '').trim();
    const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
    return { ...ILINK_HEADERS, Authorization: 'Bearer ' + token, 'X-WECHAT-UIN': uin };
  }

  /** 连接微信 iLink（对应 WeixinChannel.connect） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    if (!cfg['botToken']) {
      this.status.lastError = 'Missing botToken (请先通过iLink扫码获取)';
      return { success: false, error: this.status.lastError };
    }
    if (/^(?:\*+|•+|\[REDACTED\]|\*+REDACTED\*+)$/i.test(String(cfg['botToken']).trim())) {
      this.status.lastError = '微信凭据保存异常，请重新扫码获取有效凭据';
      return { success: false, error: this.status.lastError };
    }
    try {
      this.baseUrl = String(cfg['baseUrl'] || 'https://ilinkai.weixin.qq.com').trim().replace(/\/+$/, '');
      this.cursor = String(cfg['cursor'] || '');
      await this.pollMessages();
      if (this.status.lastError) throw new Error(this.status.lastError);
      this.startPolling();
      this.status.connected = true;
      this.status.lastError = null;
      this.emitStatusChange();
      this.logger.info('[Weixin] iLink connected, polling started');
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.logger.warn('[Weixin] Connect error', { error: this.status.lastError });
      this.status.connected = false;
      this.emitStatusChange();
      return { success: false, error: this.status.lastError };
    }
  }

  /** 启动轮询定时器（对应 _startPolling） */
  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (this.polling) return;
      const generation = this.generation;
      this.polling = true;
      void this.pollMessages().catch((e: unknown) => {
        if(generation!==this.generation)return;
        this.status.connected=false;
        this.status.lastError=e instanceof Error?e.message:String(e);
        this.emitStatusChange();
        this.logger.warn('[Weixin] Poll error', {
          error: e instanceof Error ? e.message : String(e),
        });
      }).finally(()=>{if(generation===this.generation)this.polling=false;});
    }, POLL_INTERVAL_MS);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
  }

  /** 轮询消息（对应 _pollMessages：getupdates + 游标推进） */
  private async pollMessages(): Promise<void> {
    const generation=this.generation;
    let resp;
    try { resp = await this.http.post<WxGetUpdatesResponse>(
      this.baseUrl + '/ilink/bot/getupdates',
      { get_updates_buf: this.cursor, base_info: { channel_version: '2.0.0' } },
      { timeout: 35_000, responseType: 'json', headers: this.ilinkHeaders() },
    ); } catch (error) {
      if (generation !== this.generation) return;
      // A long-poll without messages can reach the client timeout normally.
      if (error instanceof Error && /^Request timeout \(\d+ms\)$/.test(error.message)) return;
      throw error;
    }
    if(generation!==this.generation)return;
    const data = resp.data;
    if (!data || (data.errcode !== undefined && data.errcode !== 0) || (data.ret !== undefined && data.ret !== 0)) {
      const expired=data?.errcode===-14||data?.ret===-14;
      if(expired && this.pollTimer){clearInterval(this.pollTimer);this.pollTimer=null;}
      this.status.connected=false;
      this.status.lastError=expired?'微信登录已过期，请重新扫码':`微信连接失败 (${data?.errcode || data?.ret || 'invalid response'})`;
      this.emitStatusChange();
      throw new Error(this.status.lastError);
    }
    this.status.connected=true;
    this.status.lastError=null;
    this.emitStatusChange();
    if (data && data.get_updates_buf) this.cursor = data.get_updates_buf;
    const msgs = (data && data.msgs) || [];
    for (const msg of msgs) {
      if(generation!==this.generation)return;
      await this.processMessage(msg);
    }
  }

  /** 处理单条消息（对应 _processMessage：echo 检测 + 处理锁 + 分发） */
  private async processMessage(msg: WxIncomingMsg): Promise<void> {
    const senderId = String(msg.from_user_id || '');
    const contextToken = String(msg.context_token || '');
    const msgId = String(msg.msg_id || msg.message_id || msg.id || '');
    const createTime = msg.create_time || msg.send_time || 0;
    if (contextToken) this.contextTokens.set(senderId, contextToken);

    let text = '';
    const items = msg.item_list || [];
    for (const item of items) {
      if (item.type === 1 && item.text_item) text += item.text_item.text || '';
      else if (item.type === 2) text += '[图片]';
      else if (item.type === 4) text += '[语音]';
    }
    if (!text.trim() || !senderId) return;

    // Echo 检测：60s 内与最近发送文本匹配则跳过（防 iLink 回传自己的回复）
    const echoKey = text.trim().substring(0, 200);
    const echoTime = this.echoCache.get(echoKey);
    if (echoTime !== undefined) {
      if (Date.now() - echoTime < ECHO_TTL_MS) {
        this.logger.info('[Weixin] ECHO SKIPPED: text matches recently sent message');
        return;
      }
      this.echoCache.delete(echoKey);
    }

    // 处理锁：同一 sender 处理中则跳过（防并发导致重复 AI 调用）
    if (this.processingSenders.has(senderId)) {
      this.logger.info('[Weixin] LOCK SKIPPED: sender ' + senderId + ' is already being processed');
      return;
    }
    this.processingSenders.set(senderId, Date.now());

    try {
      await this.handleIncomingMessage(senderId, text, {
        chatId: senderId,
        messageId: msgId,
        create_time: createTime,
        contextToken,
        raw: msg as unknown as Record<string, unknown>,
      });
    } finally {
      this.processingSenders.delete(senderId);
    }
  }

  /** 断开微信（对应 WeixinChannel.disconnect） */
  async disconnect(): Promise<void> {
    this.generation++;
    this.polling=false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.contextTokens.clear();
    this.processingSenders.clear();
    this.lastSenderId = null;
    this.status.connected = false;
    this.status.lastError = null;
    this.emitStatusChange();
  }

  /** 发送消息（对应 WeixinChannel.sendMessage：sendmessage + 分块 + context_token） */
  async sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    try {
      let target = to;
      if (!target || target === 'me' || target === 'self') {
        target = this.lastSenderId || '';
        if (!target) {
          return { success: false, error: '没有记录的联系人，请先从微信给机器人发一条消息' };
        }
      }
      const contextToken = this.contextTokens.get(target) || String(options?.contextToken || '');

      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.substring(0, MAX_CHUNK_LEN));
        remaining = remaining.substring(MAX_CHUNK_LEN);
      }
      for (const chunk of chunks) {
        const msgBody: Record<string, unknown> = {
          from_user_id: '',
          to_user_id: target,
          client_id: 'sc-weixin-' + Date.now(),
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        };
        // iLink 需要 context_token 正确路由消息到用户会话
        if (contextToken) msgBody['context_token'] = contextToken;
        const resp = await this.http.post<WxSendMessageResponse>(
          this.baseUrl + '/ilink/bot/sendmessage',
          { msg: msgBody, base_info: { channel_version: '2.0.0' } },
          { timeout: 15_000, responseType: 'json', headers: this.ilinkHeaders() },
        );
        const data = resp.data;
        if (data && data.errcode && data.errcode !== 0) {
          return {
            success: false,
            error: '微信发送失败 errcode=' + data.errcode + ' ' + (data.errmsg || ''),
          };
        }
        if (data && data.ret && data.ret !== 0) {
          return { success: false, error: '微信发送失败 ret=' + data.ret };
        }
      }

      // 记录发送的消息到 echo 缓存
      const echoKey = text.trim().substring(0, 200);
      this.echoCache.set(echoKey, Date.now());
      if (this.echoCache.size > 100) {
        const now = Date.now();
        for (const [k, v] of this.echoCache) {
          if (now - v > ECHO_TTL_MS) this.echoCache.delete(k);
        }
      }
      this.status.messagesSent++;
      return { success: true };
    } catch (e) {
      this.logger.warn('[Weixin] sendMessage error', {
        error: e instanceof Error ? e.message : String(e),
      });
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '自动目标: ' + this.lastSenderId : '需先从微信给机器人发一条消息',
    };
  }

  /** 调用 sendmessage（图片/文件 item，对应 sendImage/sendFile） */
  private async sendItemMessage(
    target: string,
    itemList: WxMsgItem[],
    contextToken: string,
  ): Promise<SendResult> {
    const msgBody: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: target,
      client_id: 'sc-weixin-' + Date.now(),
      message_type: 2,
      message_state: 2,
      item_list: itemList,
    };
    if (contextToken) msgBody['context_token'] = contextToken;
    const resp = await this.http.post<WxSendMessageResponse>(
      this.baseUrl + '/ilink/bot/sendmessage',
      { msg: msgBody, base_info: { channel_version: '2.0.0' } },
      { timeout: 15_000, responseType: 'json', headers: this.ilinkHeaders() },
    );
    const data = resp.data;
    if (data && data.errcode && data.errcode !== 0) {
      return {
        success: false,
        error: '微信发送失败 errcode=' + data.errcode + ' ' + (data.errmsg || ''),
      };
    }
    // 与 sendMessage 对齐：iLink 网关以 ret 字段返回业务级失败
    if (data && data.ret && data.ret !== 0) {
      return { success: false, error: '微信发送失败 ret=' + data.ret };
    }
    this.status.messagesSent++;
    return { success: true };
  }

  /** 发送图片（对应 WeixinChannel.sendImage：image_item file_path） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
    const ext = extname(imagePath).toLowerCase().replace('.', '');
    const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
    if (imgExts.indexOf(ext) < 0) {
      return { success: false, error: 'Unsupported image format: ' + ext };
    }
    const target = to || this.lastSenderId || '';
    if (!target) return { success: false, error: 'No target - need someone to message first' };
    this.logger.info('[Weixin] Sending image to ' + target + ': ' + imagePath);
    return this.sendItemMessage(
      target,
      [{ type: 3, image_item: { file_path: imagePath } }],
      this.contextTokens.get(target) || '',
    );
  }

  /** 发送文件（对应 WeixinChannel.sendFile：file_item file_path + file_name） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
    const fileName = basename(filePath);
    const target = to || this.lastSenderId || '';
    if (!target) return { success: false, error: 'No target - need someone to message first' };
    this.logger.info('[Weixin] Sending file to ' + target + ': ' + fileName);
    return this.sendItemMessage(
      target,
      [{ type: 4, file_item: { file_path: filePath, file_name: fileName } }],
      this.contextTokens.get(target) || '',
    );
  }
}
