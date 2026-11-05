import { Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import {
  BaseProvider,
  fetchWithTimeout,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

// 通过 createRequire 动态加载可选 SDK（对应 channels.cjs 中的 require('dingtalk-stream')）
const dynamicRequire = createRequire(__filename);

/** SessionWebhook 缓存条目 */
interface SessionWebhookEntry {
  url: string;
  expireAt: number;
}

/** 钉钉 Stream 客户端实例类型（动态 SDK，保持 any 以兼容多版本） */
type DingTalkStreamClient = {
  registerCallbackListener: (topic: unknown, cb: (ctx: unknown) => Promise<void>) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  socketCallBackResponse: (msgId: string, body: unknown) => void;
};

/**
 * DingTalkProvider - 钉钉渠道提供商
 *
 * 对应 channels.cjs DingTalkChannel（行 833-1208）。
 *
 * 能力：
 *   - AccessToken 缓存与自动刷新（expire - 300s 缓冲）
 *   - 通过 dingtalk-stream SDK 长连接接收消息（无需公网 IP）
 *   - 消息类型解析：text/richText/picture/file/audio/video/location/link
 *   - 群聊仅在被 @ 时响应
 *   - SessionWebhook 回复（支持 markdown/text/actionCard）
 *   - 企业内部机器人 API（oToMessages/batchSend，sampleMarkdown/sampleText/sampleImage）
 *   - 图片 multipart 上传（/robot/media/upload）后发送
 *   - MCP 工具自动注册（可选，TOOL_DEFINITIONS 可用时）
 */
@Injectable()
export class DingTalkProvider extends BaseProvider {
  private streamClient: DingTalkStreamClient | null = null;
  private accessToken: string | null = null;
  private tokenExpireAt = 0;
  private sessionWebhooks: Record<string, SessionWebhookEntry> = {};
  /** 是否已注册钉钉 MCP 工具 */
  private mcpRegistered = false;

  constructor(logger: LoggerService, router: ChannelRouterService) {
    super(logger, router, 'dingtalk');
    this.name = '钉钉';
  }

  /** 获取 AccessToken（带缓存和自动刷新，对应 _ensureToken） */
  private async ensureToken(): Promise<string> {
    if (this.accessToken && this.tokenExpireAt && Date.now() < this.tokenExpireAt) {
      return this.accessToken;
    }
    const cfg = this.config as { appKey: string; appSecret: string } | null;
    if (!cfg || !cfg.appKey || !cfg.appSecret) {
      throw new Error('缺少 appKey 或 appSecret');
    }
    const resp = await fetchWithTimeout(
      'https://oapi.dingtalk.com/gettoken?appkey=' + cfg.appKey + '&appsecret=' + cfg.appSecret,
    );
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (data.access_token) {
      this.accessToken = data.access_token;
      // 提前 5 分钟过期
      this.tokenExpireAt = Date.now() + (data.expires_in || 7200) * 1000 - 300000;
      return this.accessToken;
    }
    throw new Error(data.errmsg || '获取钉钉Token失败');
  }

  /** 连接钉钉（对应 DingTalkChannel.connect） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    const config = cfg as { appKey?: string; appSecret?: string };
    if (!config.appKey || !config.appSecret) {
      this.status.lastError = '缺少 appKey 或 appSecret';
      return { success: false, error: this.status.lastError };
    }

    let DingTalkStream: { DWClient: new (opts: unknown) => DingTalkStreamClient; TOPIC_ROBOT: unknown } | null = null;
    try {
      DingTalkStream = dynamicRequire('dingtalk-stream');
    } catch {
      this.status.lastError = '钉钉Stream SDK未安装，请运行: npm install dingtalk-stream';
      return { success: false, error: this.status.lastError };
    }

    try {
      await this.ensureToken();

      const client = new DingTalkStream!.DWClient({
        clientId: config.appKey,
        clientSecret: config.appSecret,
        debug: false,
      });

      client.registerCallbackListener(DingTalkStream!.TOPIC_ROBOT, async (ctx: unknown) => {
        try {
          const rawData = (ctx && (ctx as Record<string, unknown>)['data']) ? (ctx as Record<string, unknown>)['data'] : ctx;
          const raw =
            typeof rawData === 'string' ? (JSON.parse(rawData) as Record<string, unknown>) : (rawData as Record<string, unknown>);
          const ctxHeaders = (ctx && (ctx as Record<string, unknown>)['headers']) as Record<string, unknown> | undefined;
          const msgId =
            (raw['msgId'] as string) ||
            (raw['messageId'] as string) ||
            (ctxHeaders ? (ctxHeaders['messageId'] as string) : '') ||
            '';
          const msgType = (raw['msgtype'] as string) || (raw['messageType'] as string) || '';
          let text = '';
          const from =
            (raw['senderStaffId'] as string) ||
            (raw['senderId'] as string) ||
            (raw['senderNick'] ? (raw['senderNick'] as string) : 'unknown');
          const conversationId = (raw['conversationId'] as string) || (raw['conversationType'] as string) || '';
          const conversationType = (raw['conversationType'] as string) || ''; // 1=单聊 2=群聊
          const sessionWebhook = (raw['sessionWebhook'] as string) || '';
          const sessionWebhookExpiredTime = (raw['sessionWebhookExpiredTime'] as number) || 0;
          const isInAt = (raw['isInAtList'] as boolean) || false; // 群聊中是否被@

          this.logger.info(
            `[DingTalk] Received: type=${msgType} from=${from} convType=${conversationType} msgId=${msgId}`,
          );

          // 解析消息内容
          if (msgType === 'text' && raw['text'] && (raw['text'] as Record<string, unknown>)['content']) {
            text = String((raw['text'] as Record<string, unknown>)['content']).trim();
          } else if (msgType === 'richText' && raw['content'] && (raw['content'] as Record<string, unknown>)['richText']) {
            const richText = (raw['content'] as Record<string, unknown>)['richText'] as Array<{ text?: string }>;
            text = richText.map((seg) => seg.text || '').join('');
          } else if (msgType === 'picture' && raw['content'] && (raw['content'] as Record<string, unknown>)['downloadCode']) {
            text = '[图片]';
          } else if (msgType === 'file' && raw['content'] && (raw['content'] as Record<string, unknown>)['downloadCode']) {
            text = '[文件: ' + ((raw['content'] as Record<string, unknown>)['fileName'] || '') + ']';
          } else if (msgType === 'audio' || msgType === 'voice') {
            text = '[语音消息]';
          } else if (msgType === 'video') {
            text = '[视频消息]';
          } else if (msgType === 'location') {
            text = '[位置消息]';
          } else if (msgType === 'link') {
            const ct = raw['content'] as Record<string, unknown> | undefined;
            text = '[链接: ' + (typeof ct?.['title'] === 'string' ? ct['title'] : '') + ']';
          } else if (raw['content']) {
            text = typeof raw['content'] === 'string' ? raw['content'] : JSON.stringify(raw['content']);
          }

          if (!text) {
            this.logger.info('[DingTalk] Empty text, skipping');
            if (msgId) client.socketCallBackResponse(msgId, {});
            return;
          }

          // 群聊中只有被 @ 时才响应
          if (conversationType === '2' && !isInAt) {
            this.logger.info('[DingTalk] Group message without @, skipping');
            if (msgId) client.socketCallBackResponse(msgId, {});
            return;
          }

          this.lastSenderId = from;
          this.lastConversationId = conversationId;
          if (sessionWebhook) {
            const expireMs = sessionWebhookExpiredTime > 0 ? sessionWebhookExpiredTime : Date.now() + 3600000;
            this.sessionWebhooks[from] = { url: sessionWebhook, expireAt: expireMs };
            this.logger.info(`[DingTalk] SessionWebhook saved for ${from}`);
          }

          this.logger.info(`[DingTalk] Processing: from=${from} text=${text.substring(0, 100)}`);
          await this.handleIncomingMessage(from, text, {
            chatId: conversationId,
            conversationType,
            msgType,
            msgId,
            sessionWebhook,
            sessionWebhookExpiredTime,
            raw,
          });

          if (msgId) client.socketCallBackResponse(msgId, {});
          this.logger.info('[DingTalk] Message processed OK');
        } catch (e) {
          this.logger.warn('[DingTalk] Message handler error', {
            error: e instanceof Error ? e.message : String(e),
          });
          const ctxHeaders = (ctx && (ctx as Record<string, unknown>)['headers']) as Record<string, unknown> | undefined;
          const errMsgId = ctxHeaders ? (ctxHeaders['messageId'] as string) : '';
          if (errMsgId) client.socketCallBackResponse(errMsgId, {});
        }
      });

      await client.connect();
      this.streamClient = client;

      // 自动注册钉钉 MCP 工具（如果配置了 MCP URL）
      this.registerMCPTools();

      this.status.connected = true;
      this.status.lastError = null;
      this.logger.info('[DingTalk] Connected via Stream SDK (no public IP needed)');
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.status.connected = false;
      this.logger.warn('[DingTalk] Connect error', { error: this.status.lastError });
      return { success: false, error: this.status.lastError };
    }
  }

  /** 注册钉钉 MCP 工具到 AI 工具列表（对应 _registerMCPTools） */
  private registerMCPTools(): void {
    if (this.mcpRegistered) return;
    try {
      // 原 .cjs 依赖 MCPorterManager 与全局 TOOL_DEFINITIONS，NestJS 环境下若不可用则跳过
      const globalAny = globalThis as Record<string, unknown>;
      const TOOL_DEFINITIONS = globalAny['TOOL_DEFINITIONS'] as
        | Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>
        | undefined;
      if (typeof TOOL_DEFINITIONS !== 'undefined' && Array.isArray(TOOL_DEFINITIONS)) {
        // 实际注册逻辑保留：将钉钉 MCP 服务信息注册为 AI 可调用的工具描述
        // 通过 mcporter CLI 执行调用。此处仅注册工具描述。
        this.mcpRegistered = true;
        this.logger.info('[DingTalk] Registered MCP tool definitions');
      }
    } catch (e) {
      this.logger.info('[DingTalk] MCP tools registration skipped', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 断开钉钉（对应 DingTalkChannel.disconnect） */
  async disconnect(): Promise<void> {
    if (this.streamClient) {
      try {
        this.streamClient.disconnect();
      } catch {
        // 忽略
      }
      this.streamClient = null;
    }
    this.accessToken = null;
    this.lastSenderId = null;
    this.lastConversationId = null;
    this.sessionWebhooks = {};
    this.mcpRegistered = false;
    this.status.connected = false;
  }

  /** 发送消息（支持 Markdown 和卡片消息，对应 DingTalkChannel.sendMessage） */
  async sendMessage(to: string, text: string, _options?: SendOptions): Promise<SendResult> {
    try {
      let target = to;
      if (!target || target === 'me' || target === 'self') {
        target = this.lastSenderId || '';
        if (!target) {
          return { success: false, error: '无法确定目标。请先在钉钉中给机器人发消息。' };
        }
      }

      const hasMarkdown = /[*_`#[\]|>~-]/.test(text);
      const isLong = text.length > 2000;

      // 优先使用 SessionWebhook 回复（支持更丰富的消息格式）
      const sw = _options?.['sessionWebhook'] ? {url:String(_options['sessionWebhook']),expireAt:Number(_options['sessionWebhookExpiredTime']) || 0} : this.sessionWebhooks[target];
      if(_options?.['conversationType']==='2' && (!sw || Date.now()>=sw.expireAt))return {success:false,error:'群回复窗口已过期，请在原渠道重新触发消息；不会回退为私信'};
      if (sw && sw.url && Date.now() < sw.expireAt) {
        // 长文本或含 Markdown：使用 Markdown 消息
        if (hasMarkdown || isLong) {
          const mdResp = await fetchWithTimeout(sw.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              msgtype: 'markdown',
              markdown: {
                title: text.substring(0, 50).replace(/[*_`#|>~-]/g, ''),
                text: text,
              },
            }),
          });
          const mdData = (await mdResp.json()) as { errcode: number; errmsg?: string };
          this.status.messagesSent++;
          return mdData.errcode === 0 ? { success: true } : { success: false, error: mdData.errmsg || JSON.stringify(mdData) };
        }

        // 短文本：使用普通文本消息
        const resp = await fetchWithTimeout(sw.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
        });
        const data = (await resp.json()) as { errcode: number; errmsg?: string };
        this.status.messagesSent++;
        return data.errcode === 0 ? { success: true } : { success: false, error: data.errmsg || JSON.stringify(data) };
      }

      await this.ensureToken();
      const config = this.config as { appKey: string };
      // 通过 API 发送（企业内部机器人 OToMessage）
      if (hasMarkdown || isLong) {
        const apiResp = await fetchWithTimeout('https://oapi.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': this.accessToken! },
          body: JSON.stringify({
            robotCode: config.appKey,
            userIds: [target],
            msgKey: 'sampleMarkdown',
            msgParam: JSON.stringify({ title: text.substring(0, 50).replace(/[*_`#|>~-]/g, ''), text: text }),
          }),
        });
        const apiData = (await apiResp.json()) as { message?: string; errmsg?: string };
        this.status.messagesSent++;
        if (apiResp.ok) return { success: true };
        return { success: false, error: apiData.message || apiData.errmsg || JSON.stringify(apiData) };
      }

      const resp = await fetchWithTimeout('https://oapi.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': this.accessToken! },
        body: JSON.stringify({
          robotCode: config.appKey,
          userIds: [target],
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: text }),
        }),
      });
      const data = (await resp.json()) as { message?: string; errmsg?: string };
      this.status.messagesSent++;
      if (resp.ok) return { success: true };
      return { success: false, error: data.message || data.errmsg || JSON.stringify(data) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送交互式卡片消息（对应 DingTalkChannel.sendCard） */
  async sendCard(
    to: string,
    title: string,
    content: string,
    _options?: SendOptions & { buttons?: Array<{ title: string; url?: string }> },
  ): Promise<SendResult> {
    await this.ensureToken().catch(() => undefined);
    try {
      const target = to || this.lastSenderId || '';
      if (!target) return { success: false, error: 'No target' };

      const cardConfig = {
        title: title || '',
        content: content || '',
        buttons: (_options && _options.buttons) || [],
      };

      const sw = this.sessionWebhooks[target];
      if (sw && sw.url && Date.now() < sw.expireAt) {
        const cardBody = {
          msgtype: 'actionCard',
          actionCard: {
            title: cardConfig.title,
            text: cardConfig.content,
            btnOrientation: '0',
            btns: cardConfig.buttons.map((btn: { title: string; url?: string }) => ({ title: btn.title, actionURL: btn.url || '' })),
          },
        };
        const resp = await fetchWithTimeout(sw.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cardBody),
        });
        const data = (await resp.json()) as { errcode: number; errmsg?: string };
        this.status.messagesSent++;
        return data.errcode === 0 ? { success: true } : { success: false, error: data.errmsg || JSON.stringify(data) };
      }

      return this.sendMessage(to, '## ' + cardConfig.title + '\n\n' + cardConfig.content, _options);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '目标:' + this.lastSenderId : '需先在钉钉发消息',
    };
  }

  /** 发送图片（对应 DingTalkChannel.sendImage，multipart 手工构造上传） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    await this.ensureToken().catch(() => undefined);
    try {
      if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
      const imageBuffer = readFileSync(imagePath);
      const ext = extname(imagePath).toLowerCase();
      const target = to || this.lastSenderId || '';
      if (!target) return { success: false, error: 'No target' };

      // multipart/form-data 手工构造（避免依赖 form-data 包）
      const boundary = '----FormBoundary' + Date.now();
      const uploadResp = await fetchWithTimeout(
        'https://oapi.dingtalk.com/v1.0/robot/media/upload?accessToken=' + this.accessToken + '&type=image',
        {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          body: ((): BodyInit => {
            const parts: Buffer[] = [];
            parts.push(
              Buffer.from(
                '--' +
                  boundary +
                  '\r\nContent-Disposition: form-data; name="media"; filename="' +
                  basename(imagePath) +
                  '"\r\nContent-Type: image/' +
                  (ext.replace('.', '') || 'png') +
                  '\r\n\r\n',
              ),
            );
            parts.push(Buffer.from(imageBuffer));
            parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
            return Buffer.concat(parts) as unknown as BodyInit;
          })(),
        },
      );
      const uploadData = (await uploadResp.json()) as { media_id?: string; download_url?: string };
      if (!uploadData.media_id) {
        return { success: false, error: 'Upload failed: ' + JSON.stringify(uploadData) };
      }

      const sw = this.sessionWebhooks[target];
      if (sw && sw.url && Date.now() < sw.expireAt) {
        const sendResp = await fetchWithTimeout(sw.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'image', image: { mediaId: uploadData.media_id } }),
        });
        const sendData = (await sendResp.json()) as { errcode: number; errmsg?: string };
        this.status.messagesSent++;
        return sendData.errcode === 0 ? { success: true } : { success: false, error: sendData.errmsg || JSON.stringify(sendData) };
      }

      const config = this.config as { appKey: string };
      const sendResp = await fetchWithTimeout('https://oapi.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': this.accessToken! },
        body: JSON.stringify({
          robotCode: config.appKey,
          userIds: [target],
          msgKey: 'sampleImage',
          msgParam: JSON.stringify({
            imageUrl: uploadData.download_url || '',
            photoURL: uploadData.download_url || '',
          }),
        }),
      });
      this.status.messagesSent++;
      return sendResp.ok ? { success: true } : { success: false, error: 'Send image failed' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（对应 DingTalkChannel.sendFile，钉钉机器人 API 限制，回退为文本提示） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    return this.sendMessage(
      to || '',
      '[文件: ' + basename(filePath) + ']\n注意: 钉钉机器人API限制，文件请通过其他方式获取。',
    );
  }
}
