import { Injectable } from '@nestjs/common';
import { createDecipheriv, createHash } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
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
// 企业微信 API 常量与类型
// ============================================================

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com';

/** gettoken 响应 */
interface WecomTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

/** message/send / media/upload 响应 */
interface WecomApiResponse {
  errcode?: number;
  errmsg?: string;
  media_id?: string;
  msgid?: string;
}

/** 回调配置 */
interface WecomCallbackConfig {
  callbackToken: string;
  encodingAesKey: string;
  callbackPort: number;
  callbackHost: string;
  callbackAllowedIPs: string[];
}

/**
 * WeComProvider - 企业微信（自建应用）渠道提供商
 *
 * 对应 channels.cjs 中 wecom 类型（旧版为 WeComAIChannel 的 AI Bot WebSocket 模式，
 * 该模式已由 wechat-work.service.ts 实现；本 provider 按任务要求实现经典
 * 自建应用消息通道）。
 *
 * 能力：
 *   - connect：corpid + corpsecret 换取 access_token（gettoken），
 *     token 缓存并在过期前 300s 自动刷新
 *   - sendMessage：POST /cgi-bin/message/send { touser, msgtype: 'text', agentid, text }
 *     （errcode 40014/42001 token 失效时自动刷新重试一次）
 *   - 接收（可选）：配置 callbackToken + encodingAesKey + callbackPort 时启动
 *     回调服务器（GET URL 验证 + POST AES 加密 XML 消息解密）
 *   - 图片/文件：临时素材上传（media/upload，multipart）+ message/send
 */
@Injectable()
export class WeComProvider extends BaseProvider {
  /** 缓存的 access_token */
  private accessToken: string | null = null;
  /** token 过期时间戳（已提前 300s 衰减） */
  private tokenExpireAt = 0;
  /** 回调服务器 */
  private callbackServer: Server | null = null;

  constructor(
    logger: LoggerService,
    router: ChannelRouterService,
    private readonly http: HttpClientService,
  ) {
    super(logger, router, 'wecom');
    this.name = '企业微信';
  }

  /** 读取归一化后的配置（兼容 corpid/corp_secret/agentid 小写命名） */
  private normalizedConfig(): { corpId: string; corpSecret: string; agentId: string } {
    const cfg = (this.config || {}) as Record<string, unknown>;
    return {
      corpId: String(cfg['corpId'] || cfg['corpid'] || ''),
      corpSecret: String(cfg['corpSecret'] || cfg['corp_secret'] || cfg['secret'] || ''),
      agentId: String(cfg['agentId'] || cfg['agentid'] || ''),
    };
  }

  /**
   * 获取 access_token（带缓存 + 过期刷新，对应 gettoken）
   * force=true 时强制刷新（token 失效重试用）
   */
  private async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.tokenExpireAt) {
      return this.accessToken;
    }
    const { corpId, corpSecret } = this.normalizedConfig();
    if (!corpId || !corpSecret) {
      throw new Error('Missing corpId or corpSecret');
    }
    const url =
      WECOM_API_BASE +
      '/cgi-bin/gettoken?corpid=' +
      encodeURIComponent(corpId) +
      '&corpsecret=' +
      encodeURIComponent(corpSecret);
    const resp = await this.http.get<WecomTokenResponse>(url, { timeout: 15_000, responseType: 'json' });
    const data = resp.data;
    if (!data || data.errcode !== 0 || !data.access_token) {
      throw new Error('gettoken failed: ' + ((data && (data.errmsg || String(data.errcode))) || 'unknown'));
    }
    this.accessToken = data.access_token;
    this.tokenExpireAt = Date.now() + ((data.expires_in || 7200) - 300) * 1000;
    this.logger.info('[WeCom] access_token obtained, expires_in=' + (data.expires_in || 7200) + 's');
    return this.accessToken;
  }

  /** 连接企业微信（gettoken 验证 + 可选回调服务器） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    const { corpId, corpSecret, agentId } = this.normalizedConfig();
    if (!corpId || !corpSecret) {
      this.status.lastError = 'Missing corpId or corpSecret';
      return { success: false, error: this.status.lastError };
    }
    try {
      await this.getAccessToken(true);

      // 可选：启动回调服务器接收消息
      const cbToken = String(cfg['callbackToken'] || '');
      const cbAesKey = String(cfg['encodingAesKey'] || cfg['encodingAESKey'] || '');
      const cbPort = Number(cfg['callbackPort'] || 0);
      if (cbToken && cbAesKey && cbPort) {
        await this.startCallbackServer({
          callbackToken: cbToken,
          encodingAesKey: cbAesKey,
          callbackPort: cbPort,
          callbackHost: String(cfg['callbackHost'] || '0.0.0.0'),
          callbackAllowedIPs: (cfg['callbackAllowedIPs'] as string[]) || [],
        });
      } else if (!agentId) {
        // 无回调且无 agentId 时仅能收发受限，给出提示
        this.logger.info('[WeCom] No callback configured; agentId missing, send may fail');
      }

      this.status.connected = true;
      this.status.lastError = null;
      this.logger.info('[WeCom] Connected (corpId=' + corpId.substring(0, 6) + '...)');
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.logger.warn('[WeCom] Connect error', { error: this.status.lastError });
      this.status.connected = false;
      return { success: false, error: this.status.lastError };
    }
  }

  /** 断开企业微信 */
  async disconnect(): Promise<void> {
    await this.safeCloseServer(this.callbackServer);
    this.callbackServer = null;
    this.accessToken = null;
    this.tokenExpireAt = 0;
    this.lastSenderId = null;
    this.status.connected = false;
  }

  // ============================================================
  // 回调服务器（URL 验证 + 消息接收，企业微信加密协议）
  // ============================================================

  /** 启动回调服务器 */
  private async startCallbackServer(cb: WecomCallbackConfig): Promise<void> {
    const aesKey = this.decodeAesKey(cb.encodingAesKey);
    this.callbackServer = createServer((req, res) => {
      void this.handleCallbackRequest(req, res, cb, aesKey);
    });
    await this.safeListen(this.callbackServer, cb.callbackPort, cb.callbackHost);
    this.trackServer(this.callbackServer);
    this.logger.info('[WeCom] Callback server listening on port ' + cb.callbackPort);
  }

  /** 解码 EncodingAESKey（43 位 base64 → 32 字节 AES 密钥） */
  private decodeAesKey(encodingAesKey: string): Buffer {
    const key = Buffer.from(encodingAesKey + '=', 'base64');
    if (key.length !== 32) {
      throw new Error('Invalid encodingAesKey length: ' + key.length);
    }
    return key;
  }

  /** 计算回调签名：sha1(sort([token, timestamp, nonce, encrypt])) */
  private calcSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
    const parts = [token, timestamp, nonce, encrypt].sort();
    return createHash('sha1').update(parts.join('')).digest('hex');
  }

  /** 处理回调请求（GET=URL验证 / POST=消息推送） */
  private async handleCallbackRequest(
    req: IncomingMessage,
    res: ServerResponse,
    cb: WecomCallbackConfig,
    aesKey: Buffer,
  ): Promise<void> {
    try {
      // IP 白名单校验
      if (!this.checkIpAllowed(req, cb.callbackAllowedIPs)) {
        this.logger.info('[WeCom] Callback rejected: IP not allowed');
        res.writeHead(403);
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const query = url.searchParams;
      const msgSignature = query.get('msg_signature') || '';
      const timestamp = query.get('timestamp') || '';
      const nonce = query.get('nonce') || '';

      if (req.method === 'GET') {
        // URL 验证：解密 echostr 后原样返回
        const echostr = query.get('echostr') || '';
        const expected = this.calcSignature(cb.callbackToken, timestamp, nonce, echostr);
        if (expected !== msgSignature) {
          res.writeHead(403);
          res.end();
          return;
        }
        const decrypted = this.decryptMessage(echostr, aesKey);
        res.writeHead(200);
        res.end(decrypted);
        return;
      }

      if (req.method === 'POST') {
        const body: Buffer[] = [];
        req.on('data', (c: Buffer) => body.push(c));
        req.on('end', () => {
          try {
            const xml = Buffer.concat(body).toString('utf8');
            const encrypt = this.extractXmlField(xml, 'Encrypt') || '';
            const expected2 = this.calcSignature(cb.callbackToken, timestamp, nonce, encrypt);
            if (expected2 !== msgSignature) {
              res.writeHead(403);
              res.end();
              return;
            }
            const plainXml = this.decryptMessage(encrypt, aesKey);
            void this.handleCallbackMessage(plainXml);
            res.writeHead(200);
            res.end('success');
          } catch (e) {
            this.logger.warn('[WeCom] Callback parse error', {
              error: e instanceof Error ? e.message : String(e),
            });
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (e) {
      this.logger.warn('[WeCom] Callback error', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.writeHead(500);
      res.end();
    }
  }

  /** AES-256-CBC 解密企业微信消息（PKCS7 block=32，格式：random16+len4+msg+receiveid） */
  private decryptMessage(encryptBase64: string, aesKey: Buffer): string {
    const iv = aesKey.subarray(0, 16);
    const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(Buffer.from(encryptBase64, 'base64')), decipher.final()]);
    // PKCS7 unpad（block 32）
    const pad = padded[padded.length - 1];
    const content = padded.subarray(0, padded.length - pad);
    const msgLen = content.readUInt32BE(16);
    return content.subarray(20, 20 + msgLen).toString('utf8');
  }

  /** 提取 XML 字段（兼容 CDATA 与纯文本） */
  private extractXmlField(xml: string, field: string): string {
    const cdata = xml.match(new RegExp('<' + field + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + field + '>'));
    if (cdata) return cdata[1];
    const plain = xml.match(new RegExp('<' + field + '>([^<]*)</' + field + '>'));
    return plain ? plain[1] : '';
  }

  /** 处理解密后的回调 XML 消息 */
  private async handleCallbackMessage(plainXml: string): Promise<void> {
    const msgType = this.extractXmlField(plainXml, 'MsgType');
    if (msgType === 'event') return; // 事件通知不进入消息流
    const from = this.extractXmlField(plainXml, 'FromUserName');
    const msgId = this.extractXmlField(plainXml, 'MsgId');
    const createTime = parseInt(this.extractXmlField(plainXml, 'CreateTime') || '0', 10) || 0;
    let text = '';
    if (msgType === 'text') {
      text = this.extractXmlField(plainXml, 'Content');
    } else if (msgType === 'voice') {
      text = this.extractXmlField(plainXml, 'Recognition') || '[语音]';
    } else if (msgType === 'image') {
      text = '[图片]';
    } else if (msgType === 'file') {
      text = '[文件]';
    } else if (msgType === 'mixed') {
      text = this.extractXmlField(plainXml, 'Content') || '[混合消息]';
    }
    if (!text.trim() || !from) return;
    this.lastSenderId = from;
    await this.handleIncomingMessage(from, text, {
      chatId: from,
      messageId: msgId,
      raw: { create_time: createTime, msgid: msgId, fromusername: from, xml: plainXml },
    });
  }

  // ============================================================
  // 发送
  // ============================================================

  /** 解析发送目标：to 为空或 'me'/'self' 时回退最近发送者；chatId 优先 */
  private resolveTarget(to?: string, chatId?: string): string | null {
    let target = to || '';
    if (!target || target === 'me' || target === 'self') {
      target = this.lastSenderId || '';
    }
    if (chatId) target = String(chatId);
    return target || null;
  }

  /** 发送文本消息（message/send，token 失效自动刷新重试一次） */
  async sendMessage(to: string, text: string, _options?: SendOptions): Promise<SendResult> {
    try {
      const { agentId } = this.normalizedConfig();
      const touser = this.resolveTarget(to, _options?.chatId);
      if (!touser) {
        return { success: false, error: '无法确定目标。请先在企业微信中给应用发消息。' };
      }

      const body = {
        touser,
        msgtype: 'text',
        agentid: agentId ? parseInt(agentId, 10) : undefined,
        text: { content: text },
      };
      let result = await this.postMessageSend(body);
      // token 失效（40014/42001）时强制刷新重试一次
      if (result.errcode === 40014 || result.errcode === 42001) {
        this.accessToken = null;
        await this.getAccessToken(true);
        result = await this.postMessageSend(body);
      }
      if (result.errcode !== 0) {
        return {
          success: false,
          error: 'message/send failed: errcode=' + result.errcode + ' ' + (result.errmsg || ''),
        };
      }
      this.status.messagesSent++;
      return result.msgid ? { success: true, messageId: result.msgid } : { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 调用 message/send */
  private async postMessageSend(body: Record<string, unknown>): Promise<WecomApiResponse> {
    const token = await this.getAccessToken();
    const resp = await this.http.post<WecomApiResponse>(
      WECOM_API_BASE + '/cgi-bin/message/send?access_token=' + encodeURIComponent(token),
      body,
      { timeout: 15_000, responseType: 'json' },
    );
    return resp.data;
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '自动目标: ' + this.lastSenderId : '需先从企业微信给应用发一条消息',
    };
  }

  /** 上传临时素材（multipart 手工构造，与 wechat-work 同模式） */
  private async uploadMedia(
    filename: string,
    fileBuf: Buffer,
    type: 'image' | 'file',
  ): Promise<string | null> {
    const token = await this.getAccessToken();
    const uploadUrl =
      WECOM_API_BASE + '/cgi-bin/media/upload?access_token=' + encodeURIComponent(token) + '&type=' + type;
    const boundary = '----FormBoundary' + Date.now();
    const contentType =
      type === 'image' ? 'image/' + (extname(filename).replace('.', '') || 'png') : 'application/octet-stream';
    const body = Buffer.concat([
      Buffer.from(
        '--' +
          boundary +
          '\r\nContent-Disposition: form-data; name="media"; filename="' +
          basename(filename) +
          '"\r\nContent-Type: ' +
          contentType +
          '\r\n\r\n',
      ),
      fileBuf,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    const resp = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    const data = (await resp.json()) as WecomApiResponse;
    return data.media_id || null;
  }

  /** 发送图片（media/upload + message/send msgtype=image） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
    try {
      const ext = extname(imagePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      if (imageExts.indexOf(ext) < 0) {
        return { success: false, error: 'Unsupported image format: ' + ext };
      }
      const { agentId } = this.normalizedConfig();
      const target = this.resolveTarget(to);
      if (!target) return { success: false, error: '无法确定目标。请先在企业微信中给应用发消息。' };
      const mediaId = await this.uploadMedia(imagePath, readFileSync(imagePath), 'image');
      if (!mediaId) return { success: false, error: 'media/upload failed' };
      const result = await this.postMessageSend({
        touser: target,
        msgtype: 'image',
        agentid: agentId ? parseInt(agentId, 10) : undefined,
        image: { media_id: mediaId },
      });
      if (result.errcode !== 0) {
        return { success: false, error: 'errcode=' + result.errcode + ' ' + (result.errmsg || '') };
      }
      this.status.messagesSent++;
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（media/upload + message/send msgtype=file） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
    try {
      const fileName = basename(filePath);
      const ext = extname(fileName).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0) {
        return this.sendImage(filePath, to);
      }
      const { agentId } = this.normalizedConfig();
      const target = this.resolveTarget(to);
      if (!target) return { success: false, error: '无法确定目标。请先在企业微信中给应用发消息。' };
      const mediaId = await this.uploadMedia(fileName, readFileSync(filePath), 'file');
      if (!mediaId) return { success: false, error: 'media/upload failed' };
      const result = await this.postMessageSend({
        touser: target,
        msgtype: 'file',
        agentid: agentId ? parseInt(agentId, 10) : undefined,
        file: { media_id: mediaId },
      });
      if (result.errcode !== 0) {
        return { success: false, error: 'errcode=' + result.errcode + ' ' + (result.errmsg || '') };
      }
      this.status.messagesSent++;
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
