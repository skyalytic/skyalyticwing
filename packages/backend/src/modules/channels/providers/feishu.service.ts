import { Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import { URL } from 'node:url';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import {
  BaseProvider,
  fetchWithTimeout,
  type ChannelRuntimeStatus,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

// 动态加载可选 SDK（对应 require('@larksuiteoapi/node-sdk')）
const dynamicRequire = createRequire(__filename);
type LarkSDK = {
  Client: new (opts: unknown) => LarkClient;
  Domain: { Lark: unknown; Feishu: unknown };
  AppType: { SelfBuild: unknown };
  LoggerLevel: { WARN: unknown; INFO: unknown };
  WSClient: new (opts: unknown) => { start: (opts: unknown) => Promise<void>; close: () => void };
  EventDispatcher: new (opts: unknown) => {
    register: (handlers: Record<string, (data: unknown) => Promise<void>>) => void;
  };
};
type LarkClient = {
  request: (opts: unknown) => Promise<Record<string, unknown>>;
  im: {
    message: {
      reply: (opts: unknown) => Promise<Record<string, unknown>>;
      create: (opts: unknown) => Promise<Record<string, unknown>>;
      patch: (opts: unknown) => Promise<Record<string, unknown>>;
    };
    image: { create: (opts: unknown) => Promise<Record<string, unknown>> };
    file: { create: (opts: unknown) => Promise<Record<string, unknown>> };
  };
};

/** 飞书消息体（message 对象） */
interface FeishuMsgObj {
  content?: string;
  message_type?: string;
  chat_id?: string;
  chat_type?: string;
  message_id?: string;
  mentions?: Array<{
    id?: { open_id?: string; user_id?: string };
    key?: string;
    user_name?: string;
    name?: string;
  }>;
}

/**
 * FeishuProvider - 飞书渠道提供商
 *
 * 对应 channels.cjs FeishuChannel（行 1210-2005）。
 *
 * 能力：
 *   - SDK 模式（@larksuiteoapi/node-sdk）：WebSocket 长连接（无需公网IP）/ Webhook
 *   - 手动模式：HTTP 直连开放平台 API，token 自动刷新（动态 80% expire 间隔）
 *   - 消息内容解析：text/post(富文本)/interactive(卡片)/image/file/audio/video/sticker/share_chat/merge_forward
 *   - 群聊 @ 机器人过滤（去除 @ 文本）
 *   - Webhook 签名校验：HMAC-SHA256(timestamp + nonce + encrypt_key + body)，fail-close
 *   - Webhook 来源 IP 白名单校验
 *   - challenge 握手（GET/POST）
 *   - 发送：优先回复（im.message.reply），失败回退直接发送（im.message.create）
 *   - Markdown 支持：长文本用 post(md 标签)，短文本用 interactive 卡片
 *   - 图片上传（im.image.create）+ 图片消息发送
 *   - 文件上传（im.file.create）+ 文件消息发送
 *   - 消息编辑（im.message.patch）
 */
@Injectable()
export class FeishuProvider extends BaseProvider {
  private client: LarkClient | null = null;
  private webhookServer: Server | null = null;
  private wsClient: { start: (opts: unknown) => Promise<void>; close: () => void } | null = null;
  private sdk: LarkSDK | null = null;
  private domain: unknown = null;
  private botOpenId: string | null = null;
  private botName: string | null = null;
  private accessToken: string | null = null;
  private baseUrl: string | null = null;
  private tokenExpireAt = 0;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  /** 用于回复消息的最近消息 ID */
  private lastMessageId: string | null = null;
  /** 用于群聊路由的最近 chat_id */
  private lastChatId: string | null = null;

  constructor(logger: LoggerService, router: ChannelRouterService) {
    super(logger, router, 'feishu');
    this.name = '飞书';
  }

  /** 本地日志（保留 .cjs 中 [Feishu] 前缀风格） */
  private flog(msg: string, meta?: Record<string, unknown>): void {
    this.logger.info('[Feishu] ' + msg, meta);
  }

  /**
   * 解析飞书消息内容（对应 parseFeishuContent）
   *
   * 支持 text/post/interactive/image/file/audio/video/sticker/share_chat/merge_forward
   */
  private parseFeishuContent(msgObj: FeishuMsgObj | undefined): string {
    if (!msgObj) return '';
    const content = msgObj.content || '';
    const msgType = msgObj.message_type || 'text';
    if (!content) return '';
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (msgType === 'text') {
        return (parsed['text'] as string) || content;
      } else if (msgType === 'post') {
        // 富文本：提取所有语言的文本内容
        const langContent =
          (parsed['zh_cn'] as Record<string, unknown>) ||
          (parsed['en_us'] as Record<string, unknown>) ||
          (parsed['ja_jp'] as Record<string, unknown>) ||
          parsed;
        if (langContent && langContent['content']) {
          const lines: string[] = [];
          const contentArr = langContent['content'] as Array<Array<Record<string, unknown>>>;
          for (const line of contentArr) {
            const parts: string[] = [];
            for (const elem of line) {
              const tag = elem['tag'] as string;
              if (tag === 'text') parts.push((elem['text'] as string) || '');
              else if (tag === 'md' || tag === 'lark_md') parts.push((elem['text'] as string) || '');
              else if (tag === 'a') parts.push('[' + (elem['text'] || '') + '](' + (elem['href'] || '') + ')');
              else if (tag === 'at') parts.push('@' + (elem['user_name'] || elem['name'] || ''));
              else if (tag === 'img') parts.push('[图片]');
              else parts.push((elem['text'] as string) || '');
            }
            lines.push(parts.join(''));
          }
          return lines.join('\n');
        }
        return (parsed['text'] as string) || content;
      } else if (msgType === 'interactive') {
        // 卡片消息：提取 markdown/div 内容
        const texts: string[] = [];
        const header = parsed['header'] as Record<string, unknown> | undefined;
        if (header && header['title']) {
          const title = header['title'] as Record<string, unknown>;
          texts.push((title['content'] as string) || (title['text'] as string) || '');
        }
        const body = parsed['body'] as Record<string, unknown> | undefined;
        if (body && body['elements']) {
          for (const el of body['elements'] as Array<Record<string, unknown>>) {
            const tag = el['tag'] as string;
            if (tag === 'markdown' || tag === 'div') texts.push((el['content'] as string) || (el['text'] as string) || '');
          }
        }
        return texts.join('\n') || content;
      } else if (msgType === 'image') {
        return '[图片]';
      } else if (msgType === 'file') {
        return '[文件: ' + (parsed['file_name'] as string || 'unknown') + ']';
      } else if (msgType === 'audio') {
        return '[语音]';
      } else if (msgType === 'video' || msgType === 'media') {
        return '[视频]';
      } else if (msgType === 'sticker') {
        return '[表情]';
      } else if (msgType === 'share_chat') {
        return '[分享: ' + (parsed['body'] as string || parsed['summary'] as string || '') + ']';
      } else if (msgType === 'merge_forward') {
        return '[合并转发消息]';
      }
      return (parsed['text'] as string) || (parsed['content'] as string) || content;
    } catch {
      return content;
    }
  }

  /** 检查群聊中是否 @ 了机器人（对应 isBotMentioned） */
  private isBotMentioned(msgObj: FeishuMsgObj | undefined): boolean {
    if (!msgObj || !msgObj.mentions) return false;
    for (const m of msgObj.mentions) {
      if (m.id && (m.id.open_id === this.botOpenId || m.id.user_id === this.botOpenId)) return true;
    }
    return false;
  }

  /** 连接飞书（对应 FeishuChannel.connect） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg || this.config;
    const config = this.config as { appId?: string; appSecret?: string };
    const appId = config.appId || '';
    const appSecret = config.appSecret || '';
    if (!appId || !appSecret) return { success: false, error: '缺少 appId 或 appSecret' };

    let LarkSDK: LarkSDK | null = null;
    try {
      LarkSDK = dynamicRequire('@larksuiteoapi/node-sdk');
    } catch {
      this.status.lastError = '飞书SDK未安装，请运行: npm install @larksuiteoapi/node-sdk';
      return { success: false, error: this.status.lastError };
    }
    this.sdk = LarkSDK;

    try {
      const domainCfg = (this.config as { domain?: string }).domain;
      const domain =
        domainCfg === 'lark' || domainCfg === 'feishu-sg' ? LarkSDK!.Domain.Lark : LarkSDK!.Domain.Feishu;
      this.domain = domain;

      this.client = new LarkSDK!.Client({
        appId,
        appSecret,
        appType: LarkSDK!.AppType.SelfBuild,
        domain,
        loggerLevel: LarkSDK!.LoggerLevel.WARN,
      });

      const connectionMode = (this.config as { connectionMode?: string }).connectionMode || 'websocket';
      if (connectionMode === 'webhook' && (this.config as { webhookPort?: number }).webhookPort) {
        await this.startWebhookServer((this.config as { webhookPort: number }).webhookPort);
      } else {
        await this.startLongPoll();
      }

      // 获取 bot 信息（非关键，失败忽略）
      try {
        const botInfo = (await this.client.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
          data: {},
        })) as Record<string, unknown>;
        if (botInfo['code'] === 0) {
          const botData = (botInfo['bot'] as Record<string, unknown>) ||
            (botInfo['data'] && (botInfo['data'] as Record<string, unknown>)['bot'] as Record<string, unknown>);
          if (botData) {
            this.botOpenId = (botData['open_id'] as string) || '';
            this.botName = (botData['bot_name'] as string) || appId;
            this.flog(`Bot info: name=${this.botName} open_id=${this.botOpenId || '(none)'}`);
          }
        }
      } catch (e) {
        this.flog('Get bot info failed (non-critical): ' + (e instanceof Error ? e.message : String(e)));
      }

      this.status.connected = true;
      this.status.lastError = null;
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.status.connected = false;
      return { success: false, error: this.status.lastError };
    }
  }

  /** 处理飞书消息事件（统一入口，对应 handleFeishuEvent） */
  private async handleFeishuEvent(from: string, text: string, event: Record<string, unknown>): Promise<void> {
    const msgObj = (event['message'] as FeishuMsgObj) || {};
    const chatId = msgObj.chat_id || (event['chat_id'] as string) || '';
    const chatType = msgObj.chat_type || '';
    const messageId = msgObj.message_id || '';

    // 群聊中检查是否@了机器人（群聊需要@才响应）
    if (chatType === 'group' || chatType === 'topic_group') {
      if (!this.isBotMentioned(msgObj)) {
        this.flog('Group message without @bot, skipping');
        return;
      }
      // 去掉@机器人的文本
      if (msgObj.mentions) {
        for (let mi = 0; mi < msgObj.mentions.length; mi++) {
          const m = msgObj.mentions[mi];
          if (m.id && (m.id.open_id === this.botOpenId || m.id.user_id === this.botOpenId)) {
            text = text.replace(m.key || '@_user_' + (mi + 1), '').trim();
          }
        }
      }
    }

    if (!text.trim()) return;

    // 保存消息ID用于回复
    this.lastMessageId = messageId;
    this.lastChatId = chatId;

    // 群聊使用 chat_id 路由，私聊使用 open_id 路由
    const routeId = chatType === 'group' || chatType === 'topic_group' ? chatId : from;

    await this.handleIncomingMessage(routeId, text, {
      chatId,
      messageId,
      messageType: msgObj.message_type || 'text',
      chatType,
      originalFrom: from,
      raw: event,
    });
  }

  /** Webhook 签名校验（对应 _verifyFeishuSig，HMAC-SHA256） */
  private verifyFeishuSig(req: IncomingMessage, rawStr: string): boolean {
    const encryptKey = (this.config as { encryptKey?: string }).encryptKey || '';
    // INT-7 fix: fail-close，未配置 encryptKey 时拒绝所有消息（防止伪造 webhook 请求）
    if (!encryptKey) {
      this.flog('Webhook rejected: encryptKey not configured');
      return false;
    }
    const ts = (req.headers['x-lark-request-timestamp'] as string) || '';
    const nonce = (req.headers['x-lark-request-nonce'] as string) || '';
    const sig = (req.headers['x-lark-signature'] as string) || '';
    if (!sig) return false;
    try {
      const computed = createHash('sha256')
        .update(ts + nonce + encryptKey + rawStr)
        .digest('hex');
      // sig 形如 "sha256=xxxx"
      const sigHash = sig.indexOf('sha256=') === 0 ? sig.substring(7) : sig;
      // 时间常量比较防止时序攻击
      return this.safeEqual(computed, sigHash);
    } catch (e) {
      this.flog('Signature verify error: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /** 启动 Webhook 服务器（SDK 模式，对应 _startWebhookServer） */
  private async startWebhookServer(port: number): Promise<void> {
    const encryptKey = (this.config as { encryptKey?: string }).encryptKey || '';
    const allowedIPs = (this.config as { webhookAllowedIPs?: string[] }).webhookAllowedIPs || [];
    const webhookHost = (this.config as { webhookHost?: string }).webhookHost || '127.0.0.1';

    this.webhookServer = createServer(async (req, res) => {
      // 来源 IP 白名单校验
      if (!this.checkIpAllowed(req, allowedIPs)) {
        this.flog('Webhook rejected: IP not allowed ' + (req.socket && req.socket.remoteAddress));
        res.writeHead(403);
        res.end(JSON.stringify({ code: 403, msg: 'IP not allowed' }));
        return;
      }
      if (req.method === 'GET') {
        const urlObj = new URL(req.url || '/', 'http://localhost:' + port);
        const challenge = urlObj.searchParams.get('challenge') || '';
        const token = urlObj.searchParams.get('token') || '';
        const verifyToken = (this.config as { verificationToken?: string }).verificationToken || '';
        // INT-7 fix: 未配置 verifyToken 时拒绝请求（fail-close）
        if (!verifyToken) {
          this.flog('Webhook rejected: verificationToken not configured');
          res.writeHead(403);
          res.end(JSON.stringify({ code: 403, msg: 'verificationToken not configured' }));
          return;
        }
        if (token !== verifyToken) {
          res.writeHead(403);
          res.end(JSON.stringify({ code: 403 }));
          return;
        }
        this.flog('GET challenge received');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge }));
        return;
      }
      if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405);
        res.end();
        return;
      }
      const body: Buffer[] = [];
      req.on('data', (c) => body.push(c));
      req.on('end', async () => {
        try {
          const rawStr = Buffer.concat(body).toString();
          // 签名校验
          if (!this.verifyFeishuSig(req, rawStr)) {
            this.flog('Webhook rejected: invalid signature');
            res.writeHead(403);
            res.end(JSON.stringify({ code: 403, msg: 'Invalid signature' }));
            return;
          }
          const raw = JSON.parse(rawStr) as Record<string, unknown>;
          this.flog('Webhook event: ' + ((raw['event_type'] as string) || (raw['type'] as string) || 'unknown'));

          if (raw['challenge'] && !raw['event']) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: raw['challenge'] }));
            return;
          }

          if (raw['header'] && raw['event']) {
            const event = raw['event'] as Record<string, unknown>;
            const es = (event['sender'] as Record<string, unknown>) || {};
            const esid = es['sender_id'] as Record<string, unknown> | string | undefined;
            const from =
              (typeof esid === 'string'
                ? esid
                : esid
                  ? (esid['open_id'] as string) || (esid['user_id'] as string) || ''
                  : '') ||
              (es['open_id'] as string) ||
              (es['user_id'] as string) ||
              (event['app_id'] as string) ||
              'unknown';
            const eventType = (raw['event_type'] as string) || (raw['type'] as string) || '';

            // 过滤 bot 自身发送的消息
            if (this.botOpenId && from === this.botOpenId) {
              this.flog('Skipping self-message');
            } else if (eventType.indexOf('im.message.receive') >= 0 || eventType.indexOf('im.message') >= 0) {
              const msgObj = (event['message'] as FeishuMsgObj) || {};
              const text = this.parseFeishuContent(msgObj);
              this.flog(
                `Message from: ${from} chatType: ${msgObj.chat_type || '?'} text: ${(text || '').substring(0, 50)}`,
              );
              this.lastSenderId = from;
              await this.handleFeishuEvent(from, text, event);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0 }));
        } catch (e) {
          this.flog('Webhook error: ' + (e instanceof Error ? e.message : String(e)));
          res.writeHead(200);
          res.end(JSON.stringify({ code: 0 }));
        }
      });
    });

    await this.safeListen(this.webhookServer, port, webhookHost);
    this.trackServer(this.webhookServer);
    this.flog(
      `[Feishu] Webhook server on ${webhookHost}:${port}${encryptKey ? ' (signature verified)' : ' (no signature verification - configure encryptKey)'}`,
    );
  }

  /** 启动 WebSocket 长连接（对应 _startLongPoll，失败回退 webhook） */
  private async startLongPoll(): Promise<void> {
    try {
      const SDK = this.sdk;
      const cfg = this.config as {
        encryptKey?: string;
        verificationToken?: string;
        appId: string;
        appSecret: string;
        webhookPort?: number;
      };
      if (!SDK) {
        this.flog('SDK not available, falling back to webhook');
        const defaultPort = cfg.webhookPort || 3457;
        await this.startWebhookServer(defaultPort);
        return;
      }
      const WSClient = SDK.WSClient;
      const EventDispatcher = SDK.EventDispatcher;
      if (!WSClient || !EventDispatcher) {
        this.flog('WSClient/EventDispatcher not available in SDK, falling back to webhook');
        const defaultPort = cfg.webhookPort || 3457;
        await this.startWebhookServer(defaultPort);
        return;
      }

      const dispatcher = new EventDispatcher({
        encryptKey: cfg.encryptKey || '',
        verificationToken: cfg.verificationToken || '',
      });

      // 统一的消息处理函数
      const processFeishuWSMessage = async (data: unknown): Promise<void> => {
        try {
          const dataRec = data as Record<string, unknown>;
          const event = (dataRec['event'] as Record<string, unknown>) || (data as Record<string, unknown>);
          const sender = (event['sender'] as Record<string, unknown>) || {};
          const sid = sender['sender_id'] as Record<string, unknown> | string | undefined;
          const from =
            (typeof sid === 'string'
              ? sid
              : sid
                ? (sid['open_id'] as string) || (sid['user_id'] as string) || ''
                : '') ||
            (sender['open_id'] as string) ||
            (sender['user_id'] as string) ||
            'unknown';
          const msgObj = (event['message'] as FeishuMsgObj) || {};
          const text = this.parseFeishuContent(msgObj);
          this.flog(`[Feishu WS] Message from: ${from} chatType: ${msgObj.chat_type || '?'} text: ${(text || '').substring(0, 50)}`);
          // 过滤 bot 自身发送的消息
          if (this.botOpenId && from === this.botOpenId) {
            this.flog('[Feishu WS] Skipping self-message');
            return;
          }
          this.lastSenderId = from;
          try {
            await this.handleFeishuEvent(from, text, event);
            this.flog('[Feishu WS] Message handled OK');
          } catch (handleErr) {
            this.flog('[Feishu WS] _handleIncomingMessage ERROR', {
              error: handleErr instanceof Error ? handleErr.message : String(handleErr),
            });
          }
        } catch (e) {
          this.flog('[Feishu WS] Handler TOP error', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      };

      dispatcher.register({
        'im.message.receive_v1': processFeishuWSMessage,
        'im.message.receive': processFeishuWSMessage,
      });

      const wsClient = new WSClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: this.domain,
        loggerLevel: SDK.LoggerLevel.INFO,
        wsConfig: { PingInterval: 30, PingTimeout: 3 },
      });

      this.wsClient = wsClient;
      void wsClient.start({ eventDispatcher: dispatcher });
      this.flog('[Feishu] WebSocket client started (no public IP needed)');
      this.status.connected = true;
    } catch (e) {
      this.flog('[Feishu] Long-poll/WS failed: ' + (e instanceof Error ? e.message : String(e)) + ', trying webhook fallback');
      const cfg = this.config as { webhookPort?: number };
      const fallbackPort = cfg.webhookPort || 3457;
      await this.startWebhookServer(fallbackPort);
    }
  }

  /** 断开飞书（对应 FeishuChannel.disconnect） */
  async disconnect(): Promise<void> {
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch {
        // 忽略
      }
      this.wsClient = null;
    }
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    await this.safeCloseServer(this.webhookServer);
    this.webhookServer = null;
    this.client = null;
    this.accessToken = null;
    this.lastSenderId = null;
    this.lastMessageId = null;
    this.lastChatId = null;
    this.status.connected = false;
  }

  /** 发送飞书消息（支持回复/直接发送/Markdown/卡片，对应 FeishuChannel.sendMessage） */
  async sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    const opts = options || {};
    if (!this.client && !this.accessToken) return { success: false, error: 'Not connected' };

    let resolvedTo = to;
    if (!resolvedTo || resolvedTo === 'me' || resolvedTo === 'self') {
      resolvedTo = this.lastSenderId || this.botOpenId || '';
      if (!resolvedTo) return { success: false, error: '无法确定发送目标。请先从手机发消息给机器人。' };
      this.flog('Resolved target -> ' + resolvedTo);
    }

    try {
      // 判断是否包含 Markdown 格式（代码块、表格、标题、列表等）
      const hasMarkdown =
        /[`#*\-[\]|>]/.test(text) &&
        (text.indexOf('```') >= 0 || text.indexOf('##') >= 0 || text.indexOf('|') >= 0 || text.indexOf('- ') >= 0);

      if (this.client) {
        let receiveIdType = opts.receiveIdType || 'open_id';
        if (resolvedTo && resolvedTo.startsWith('oc_')) receiveIdType = 'chat_id';
        else if (opts.chatId || this.lastChatId) receiveIdType = 'chat_id';

        // 优先使用回复模式（如果有关联的消息ID）
        const replyMessageId = opts.skipReply ? '' : (opts.replyMessageId || opts.msgId || this.lastMessageId || '');

        // 构建消息内容：优先使用 post 类型支持 Markdown
        let contentJson: string;
        let msgType: string;
        if (hasMarkdown && text.length > 200) {
          // 长文本含 Markdown：使用 post 类型（支持 md 标签）
          msgType = 'post';
          contentJson = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: text }]] } });
        } else if (hasMarkdown) {
          // 短文本含 Markdown：使用卡片
          msgType = 'interactive';
          contentJson = JSON.stringify({
            schema: '2.0',
            config: { width_mode: 'fill' },
            body: { elements: [{ tag: 'markdown', content: text }] },
          });
        } else {
          // 纯文本
          msgType = 'text';
          contentJson = JSON.stringify({ text: String(text) });
        }

        // 尝试回复消息
        if (replyMessageId && !opts.skipReply) {
          try {
            const replyResult = (await this.client.im.message.reply({
              path: { message_id: replyMessageId },
              data: { content: contentJson, msg_type: msgType },
            })) as Record<string, unknown>;
            if (replyResult['code'] === 0) {
              const dataRec = replyResult['data'] as Record<string, unknown> | undefined;
              const sentMessageId = dataRec ? (dataRec['message_id'] as string) : '';
              this.status.messagesSent++;
              this.lastMessageId = null; // 清除，避免重复回复
              return { success: true, messageId: sentMessageId };
            }
            // 回复目标已撤回（错误码 230011/231003），回退到直接发送
            const code = replyResult['code'] as number;
            if (code === 230011 || code === 231003) {
              this.flog(`Reply target withdrawn (code=${code}), falling back to direct send`);
            } else {
              this.flog(`Reply failed: code=${code}, falling back to direct send`);
            }
          } catch (replyErr) {
            this.flog('Reply error: ' + (replyErr instanceof Error ? replyErr.message : String(replyErr)) + ', falling back to direct send');
          }
        }

        // 直接发送消息
        const result = (await this.client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: resolvedTo, content: contentJson, msg_type: msgType },
        })) as Record<string, unknown>;

        this.status.messagesSent++;
        if (result['code'] === 0) {
          const dataRec = result['data'] as Record<string, unknown> | undefined;
          return { success: true, messageId: dataRec ? (dataRec['message_id'] as string) : '' };
        } else {
          this.flog(`SDK send failed: code=${result['code']} msg=${result['msg']}`);
          const code = result['code'] as number;
          if (code === 9415 || code === 230013) {
            return {
              success: false,
              error:
                'Bot无可用性(错误码:' +
                code +
                ')。请在飞书开放平台将应用添加到可用范围（版本管理→创建测试版/发布版），并确保用户在可用范围内',
            };
          }
          return { success: false, error: (result['msg'] as string) || 'SDK错误码: ' + code };
        }
      } else {
        // 手动模式（无 SDK）
        if (this.tokenExpireAt && Date.now() >= this.tokenExpireAt) {
          try {
            const refreshResp = await fetchWithTimeout(this.baseUrl + '/open-apis/auth/v3/tenant_access_token/internal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_id: (this.config as { appId: string }).appId, app_secret: (this.config as { appSecret: string }).appSecret }),
            });
            const refreshData = (await refreshResp.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
            if (refreshData.code === 0) {
              this.accessToken = refreshData.tenant_access_token!;
              this.tokenExpireAt = Date.now() + ((refreshData.expire || 7200) - 300) * 1000;
            } else {
              return { success: false, error: '飞书Token刷新失败: ' + (refreshData.msg || '') };
            }
          } catch (e) {
            return { success: false, error: '飞书Token刷新失败: ' + (e instanceof Error ? e.message : String(e)) };
          }
        }
        let manualRit = 'open_id';
        if (resolvedTo && resolvedTo.startsWith('oc_')) manualRit = 'chat_id';
        else if (opts && opts.chatId) manualRit = 'chat_id';
        const manualContent = JSON.stringify({ text: String(text) });
        const resp = await fetchWithTimeout(this.baseUrl + '/open-apis/im/v1/messages?receive_id_type=' + manualRit, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.accessToken },
          body: JSON.stringify({ receive_id: resolvedTo, msg_type: 'text', content: manualContent }),
        });
        const data = (await resp.json()) as { code: number; msg?: string; data?: { message_id?: string } };
        this.status.messagesSent++;
        if (data.code === 0) return { success: true, messageId: (data.data && data.data.message_id) || '' };
        if (data.code === 9415 || data.code === 230013) {
          return { success: false, error: 'Bot无可用性(错误码:' + data.code + ')。请检查开放平台可用范围设置' };
        }
        return { success: false, ...(data.msg ? { error: data.msg } : {}) };
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 编辑已发送的消息（对应 FeishuChannel.editMessage） */
  async editMessage(messageId: string, text: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected (SDK required)' };
    if (!messageId) return { success: false, error: 'No messageId provided' };
    try {
      const hasMarkdown = /[`#*\-[\]|>]/.test(text) && (text.indexOf('```') >= 0 || text.indexOf('##') >= 0 || text.indexOf('|') >= 0);
      let contentJson: string;
      if (hasMarkdown) {
        contentJson = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: text }]] } });
      } else {
        contentJson = JSON.stringify({ text: String(text) });
      }
      const result = (await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: contentJson },
      })) as Record<string, unknown>;
      if (result['code'] === 0) return { success: true };
      return { success: false, error: (result['msg'] as string) || 'code: ' + result['code'] };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  override getStatus(): ChannelRuntimeStatus & Record<string, unknown> {
    return {
      ...this.status,
      hasClient: !!this.client,
      hasWebhook: !!this.webhookServer,
      hasWSClient: !!this.wsClient,
      botName: this.botName || '',
    };
  }

  getTestTarget(): TestTarget {
    return {
      botOpenId: this.botOpenId || '',
      botName: this.botName || '',
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!(this.lastSenderId || this.botOpenId),
      hint: this.lastSenderId
        ? '自动目标: ' + this.lastSenderId
        : this.botOpenId
          ? '机器人自身: ' + this.botOpenId
          : '需先从手机发消息',
    };
  }

  /** 发送图片（对应 FeishuChannel.sendImage，im.image.create + im.message.create） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    if (!this.client && !this.accessToken) return { success: false, error: 'Not connected' };
    try {
      if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
      const ext = extname(imagePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'];
      const isImage = imageExts.indexOf(ext) >= 0;
      if (!isImage && !imagePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
        this.flog('sendImage: not an image file, trying as file instead');
        return this.sendFile(imagePath, to);
      }
      this.flog('Uploading image: ' + imagePath);

      let imageData: unknown;
      try {
        imageData = createReadStream(imagePath);
      } catch (streamErr) {
        this.flog('createReadStream failed, fallback to readFileSync: ' + (streamErr instanceof Error ? streamErr.message : String(streamErr)));
        imageData = readFileSync(imagePath);
      }

      if (!this.client) return { success: false, error: '图片发送需要SDK模式，手动模式暂不支持' };

      const uploadResult = (await this.client.im.image.create({
        data: { image_type: 'message', image: imageData },
      })) as Record<string, unknown>;
      this.flog('im.image.create raw result: ' + JSON.stringify(uploadResult).substring(0, 500));

      const uploadCode = uploadResult['code'] as number | undefined;
      const uploadMsg = uploadResult['msg'] as string | undefined;

      if (uploadCode !== undefined && uploadCode !== null && uploadCode !== 0) {
        const errMsg = uploadMsg || 'HTTP code ' + uploadCode;
        this.flog(`Image upload FAILED: code=${uploadCode} msg=${errMsg}`);
        return { success: false, error: 'Upload failed (code=' + uploadCode + '): ' + errMsg };
      }

      const imageKey =
        (uploadResult['image_key'] as string) ||
        ((uploadResult['data'] as Record<string, unknown>) && (uploadResult['data'] as Record<string, unknown>)['image_key'] as string) ||
        '';
      if (!imageKey) {
        this.flog('No image_key in result: ' + JSON.stringify(uploadResult).substring(0, 300));
        return { success: false, error: 'No image_key returned. Full response: ' + JSON.stringify(uploadResult).substring(0, 200) };
      }
      this.flog('Image uploaded OK, image_key=' + imageKey.substring(0, 20) + '...');

      const target = to || this.lastSenderId || '';
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      const imgRit = target && target.startsWith('oc_') ? 'chat_id' : 'open_id';
      const sendResult = (await this.client.im.message.create({
        params: { receive_id_type: imgRit },
        data: { receive_id: target, content: JSON.stringify({ image_key: imageKey }), msg_type: 'image' },
      })) as Record<string, unknown>;
      this.flog('Message sent result: ' + JSON.stringify(sendResult).substring(0, 200));
      this.status.messagesSent++;
      if (sendResult['code'] === 0 || sendResult['code'] === undefined) {
        const dataRec = sendResult['data'] as Record<string, unknown> | undefined;
        return { success: true, messageId: dataRec ? (dataRec['message_id'] as string) : '' };
      }
      return { success: false, error: 'Send failed: ' + (sendResult['msg'] as string || 'code ' + sendResult['code']) };
    } catch (e) {
      this.flog('sendImage EXCEPTION: ' + (e instanceof Error ? e.message : String(e)));
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（对应 FeishuChannel.sendFile，im.file.create + im.message.create） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' };
    try {
      if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const fileName = basename(filePath);
      const ext = extname(fileName).toLowerCase();
      const fileTypeMap: Record<string, string> = {
        '.pdf': 'pdf',
        '.doc': 'doc',
        '.docx': 'doc',
        '.xls': 'xls',
        '.xlsx': 'xls',
        '.ppt': 'ppt',
        '.pptx': 'ppt',
        '.mp4': 'mp4',
        '.zip': 'stream',
        '.rar': 'stream',
        '.txt': 'stream',
      };
      const fileType = fileTypeMap[ext] || 'stream';
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0) {
        return this.sendImage(filePath, to);
      }
      this.flog('Uploading file: ' + fileName);

      let fileData: unknown;
      try {
        fileData = createReadStream(filePath);
      } catch (streamErr2) {
        this.flog('createReadStream failed for file, fallback to readFileSync: ' + (streamErr2 instanceof Error ? streamErr2.message : String(streamErr2)));
        fileData = readFileSync(filePath);
      }

      const safeFileName = fileName.replace(/[\x00-\x1F\x7F\r\n"\\]/g, '_');
      const uploadResult = (await this.client.im.file.create({
        data: { file_type: fileType, file_name: safeFileName, file: fileData },
      })) as Record<string, unknown>;
      this.flog('im.file.create raw result: ' + JSON.stringify(uploadResult).substring(0, 500));

      const fUploadCode = uploadResult['code'] as number | undefined;
      const fUploadMsg = uploadResult['msg'] as string | undefined;
      if (fUploadCode !== undefined && fUploadCode !== null && fUploadCode !== 0) {
        const fErrMsg = fUploadMsg || 'HTTP code ' + fUploadCode;
        this.flog(`File upload FAILED: code=${fUploadCode} msg=${fErrMsg}`);
        return { success: false, error: 'File upload failed (code=' + fUploadCode + '): ' + fErrMsg };
      }

      const fileKey =
        (uploadResult['file_key'] as string) ||
        ((uploadResult['data'] as Record<string, unknown>) && (uploadResult['data'] as Record<string, unknown>)['file_key'] as string) ||
        '';
      if (!fileKey) {
        this.flog('No file_key in result: ' + JSON.stringify(uploadResult).substring(0, 300));
        return { success: false, error: 'No file_key returned. Full response: ' + JSON.stringify(uploadResult).substring(0, 200) };
      }
      this.flog('File uploaded OK, file_key=' + fileKey.substring(0, 20) + '...');

      const target = to || this.lastSenderId || '';
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      const msgType = ['opus', 'mp4'].indexOf(fileType) >= 0 ? (fileType === 'opus' ? 'audio' : 'media') : 'file';
      const fileRit = target && target.startsWith('oc_') ? 'chat_id' : 'open_id';
      const sendResult = (await this.client.im.message.create({
        params: { receive_id_type: fileRit },
        data: { receive_id: target, content: JSON.stringify({ file_key: fileKey }), msg_type: msgType },
      })) as Record<string, unknown>;
      this.flog('File message sent result: ' + JSON.stringify(sendResult).substring(0, 200));
      this.status.messagesSent++;
      if (sendResult['code'] === 0 || sendResult['code'] === undefined) {
        const dataRec = sendResult['data'] as Record<string, unknown> | undefined;
        return { success: true, messageId: dataRec ? (dataRec['message_id'] as string) : '' };
      }
      return { success: false, error: 'Send failed: ' + (sendResult['msg'] as string || 'code ' + sendResult['code']) };
    } catch (e) {
      this.flog('sendFile EXCEPTION: ' + (e instanceof Error ? e.message : String(e)));
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
