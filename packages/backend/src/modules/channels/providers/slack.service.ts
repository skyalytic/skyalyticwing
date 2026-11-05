import { Injectable } from '@nestjs/common';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ChannelRouterService } from '../channel-router.service.js';
import {
  BaseProvider,
  type SendOptions,
  type SendResult,
  type TestTarget,
} from './base.provider.js';

// 动态加载可选 SDK（对应 await import('@slack/bolt')，与 discord.service.ts 同模式）
const dynamicRequire = createRequire(__filename);

// ============================================================
// @slack/bolt 最小结构类型（避免直接依赖 SDK 类型声明）
// ============================================================

/** Slack 消息对象（仅用到字段） */
interface SlackMessage {
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

/** chat.postMessage 返回 */
interface ChatPostMessageResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** files.uploadV2 返回 */
interface FilesUploadV2Result {
  ok: boolean;
  error?: string;
  files?: Array<{ id?: string }>;
}

/** auth.test 返回 */
interface AuthTestResult {
  ok: boolean;
  user_id?: string;
  error?: string;
}

/** Bolt App 最小接口 */
type BoltApp = {
  message: (listener: (args: {
    message: SlackMessage;
    say: (text: string) => Promise<unknown>;
    client: BoltClient;
  }) => Promise<void>) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  client: BoltClient;
};

/** Bolt WebClient 最小接口 */
interface BoltClient {
  auth: { test: () => Promise<AuthTestResult> };
  chat: { postMessage: (params: Record<string, unknown>) => Promise<ChatPostMessageResult> };
  files: { uploadV2: (params: Record<string, unknown>) => Promise<FilesUploadV2Result> };
}

/**
 * SlackProvider - Slack 渠道提供商
 *
 * 对应 channels.cjs SlackChannel（行 637-756）。
 *
 * 实现方式：动态加载 @slack/bolt（与 discord.service.ts 加载 discord.js 同模式），
 *           发送走 Web API（chat.postMessage / files.uploadV2）。
 *
 * 能力：
 *   - connect：App(token, signingSecret, socketMode) + app.start() + auth.test
 *     （配置 appToken 时启用 Socket Mode，否则 HTTP Events API 模式，对齐旧版）
 *   - 接收：app.message 事件，过滤 bot 自身消息（bot_id / subtype / 自身 user_id）
 *   - sendMessage：chat.postMessage { channel, text }
 *   - 图片/文件发送：files.uploadV2
 */
@Injectable()
export class SlackProvider extends BaseProvider {
  private app: BoltApp | null = null;
  /** bot 自身 user ID（过滤自消息，防 echo 循环） */
  private botUserId: string | null = null;

  constructor(logger: LoggerService, router: ChannelRouterService) {
    super(logger, router, 'slack');
    this.name = 'Slack';
  }

  /** 连接 Slack（对应 SlackChannel.connect） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    const config = cfg as { botToken?: string; appToken?: string; signingSecret?: string };
    if (!config.botToken) {
      this.status.lastError = 'Missing botToken';
      return { success: false, error: this.status.lastError };
    }
    try {
      const boltModule = dynamicRequire('@slack/bolt') as { App: new (opts: Record<string, unknown>) => BoltApp };
      const app = new boltModule.App({
        token: config.botToken,
        signingSecret: config.signingSecret || '',
        socketMode: !!config.appToken,
        appToken: config.appToken || '',
      });

      app.message(async ({ message, say, client }) => {
        // 过滤 bot 自身发送的消息，防止 echo 循环
        if (message.bot_id || message.subtype === 'bot_message') return;
        if (this.botUserId && message.user === this.botUserId) return;
        const from = message.user || 'unknown';
        this.lastSenderId = from;
        await this.handleIncomingMessage(from, message.text, {
          channel: message.channel,
          ts: message.ts,
          threadTs: message.thread_ts,
          say,
          client,
        });
      });

      this.app = app;
      await app.start();

      // 获取 bot 自身 user ID，用于过滤自消息
      try {
        const authResult = await app.client.auth.test();
        if (authResult && authResult.ok && authResult.user_id) this.botUserId = authResult.user_id;
      } catch (e) {
        this.logger.warn('[Slack] Could not get bot user ID', { error: e instanceof Error ? e.message : String(e) });
      }
      this.logger.info('[Slack] App started (mode: ' + (config.appToken ? 'Socket' : 'HTTP') + ')');
      this.status.connected = true;
      this.status.lastError = null;
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.logger.warn('[Slack] Connect error', { error: this.status.lastError });
      this.status.connected = false;
      return { success: false, error: this.status.lastError };
    }
  }

  /** 断开 Slack（对应 SlackChannel.disconnect） */
  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // 忽略
      }
      this.app = null;
    }
    this.lastSenderId = null;
    this.botUserId = null;
    this.status.connected = false;
  }

  /** 发送消息（对应 SlackChannel.sendMessage：chat.postMessage） */
  async sendMessage(to: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.app) return { success: false, error: 'Not connected' };
    try {
      let target = to;
      if (!target || target === 'me' || target === 'self') {
        target = this.lastSenderId || '';
        if (!target) {
          return { success: false, error: '无法确定目标。请先在Slack中给机器人发消息。' };
        }
      }
      if (options && options.channel) target = String(options.channel);
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- Slack SDK method, not browser window.postMessage.
      const result = await this.app.client.chat.postMessage({ channel: target, text, ...(options?.['threadTs'] || options?.['ts'] ? {thread_ts:String(options['threadTs'] || options['ts'])}: {}) });
      if (!result.ok) {
        return { success: false, error: result.error || 'chat.postMessage failed' };
      }
      this.status.messagesSent++;
      return result.ts ? { success: true, messageId: result.ts } : { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '目标: ' + this.lastSenderId : '需先在Slack发消息',
    };
  }

  /** 解析发送目标（me/self → 最近发送者对应的频道） */
  private resolveTarget(to?: string): string {
    return to || this.lastSenderId || '';
  }

  /** 发送图片（对应 SlackChannel.sendImage：files.uploadV2） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    if (!this.app) return { success: false, error: 'Not connected' };
    try {
      if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
      const ext = extname(imagePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      if (imageExts.indexOf(ext) < 0 && !imagePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
        return this.sendFile(imagePath, to);
      }
      const target = this.resolveTarget(to);
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[Slack] Uploading image: ' + imagePath);
      const fileName = basename(imagePath);
      const uploadResult = await this.app.client.files.uploadV2({
        file: readFileSync(imagePath),
        filename: fileName,
        initial_comment: 'Image from AI assistant',
        channel_id: target,
        title: fileName,
      });
      if (!uploadResult.ok) {
        return { success: false, error: uploadResult.error || 'files.uploadV2 failed' };
      }
      this.status.messagesSent++;
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（对应 SlackChannel.sendFile：files.uploadV2） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    if (!this.app) return { success: false, error: 'Not connected' };
    try {
      if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const fileName = basename(filePath);
      const ext = extname(fileName).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0) {
        return this.sendImage(filePath, to);
      }
      const target = this.resolveTarget(to);
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[Slack] Uploading file: ' + fileName);
      const uploadResult = await this.app.client.files.uploadV2({
        file: readFileSync(filePath),
        filename: fileName,
        initial_comment: 'File from AI assistant',
        channel_id: target,
        title: fileName,
      });
      if (!uploadResult.ok) {
        return { success: false, error: uploadResult.error || 'files.uploadV2 failed' };
      }
      this.status.messagesSent++;
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
