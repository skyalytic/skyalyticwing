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

// 动态加载可选 SDK（对应 await import('discord.js')）
const dynamicRequire = createRequire(__filename);
type DiscordClient = {
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  login: (token: string) => Promise<string>;
  destroy: () => Promise<void>;
  channels: { fetch: (id: string) => Promise<DiscordChannel | null> };
  users: { fetch: (id: string) => Promise<DiscordUser | null> };
  user: { id: string; tag: string } | null;
};
type DiscordChannel = { send: (content: string | Record<string, unknown>) => Promise<{ id: string }> };
type DiscordUser = { createDM: () => Promise<DiscordChannel> };
type DiscordMessage = {
  author: { bot?: boolean; id: string };
  content: string;
  guild?: { id: string } | null;
  channel: { id: string };
  id: string;
};

/**
 * DiscordProvider - Discord 渠道提供商
 *
 * 对应 channels.cjs DiscordChannel（行 567-710）。
 *
 * 能力：
 *   - 通过 discord.js Client 接收消息（intents: Guilds/GuildMessages/MessageContent/DirectMessages）
 *   - 过滤 bot 自身消息
 *   - 发送：优先 fetch 频道，失败回退 DM 用户
 *   - 图片/文件附件发送（channel.send with files）
 */
@Injectable()
export class DiscordProvider extends BaseProvider {
  private client: DiscordClient | null = null;

  constructor(logger: LoggerService, router: ChannelRouterService) {
    super(logger, router, 'discord');
  }

  /** 连接 Discord（对应 DiscordChannel.connect） */
  async connect(cfg: Record<string, unknown>): Promise<SendResult> {
    await this.disconnect();
    this.config = cfg;
    const config = cfg as { botToken?: string };
    if (!config.botToken) {
      this.status.lastError = 'Missing botToken';
      return { success: false, error: this.status.lastError };
    }
    try {
      const discordModule = dynamicRequire('discord.js') as {
        Client: new (opts: unknown) => DiscordClient;
        GatewayIntentBits: Record<string, number>;
      };
      const client = new discordModule.Client({
        intents: [
          discordModule.GatewayIntentBits['Guilds'],
          discordModule.GatewayIntentBits['GuildMessages'],
          discordModule.GatewayIntentBits['MessageContent'],
          discordModule.GatewayIntentBits['DirectMessages'],
        ],
      });

      client.on('ready', () => {
        const c = client as unknown as { user: { tag: string } };
        this.logger.info('[Discord] Bot ready: ' + (c.user ? c.user.tag : 'unknown'));
        this.status.connected = true;
        this.status.lastError = null;
      });

      client.on('messageCreate', async (messageArg: unknown) => {
        const message = messageArg as DiscordMessage;
        if (message.author.bot) return;
        const from = message.author.id;
        this.lastSenderId = from;
        const text = message.content;
        await this.handleIncomingMessage(from, text, {
          guildId: message.guild ? message.guild.id : 'dm',
          channelId: message.channel.id,
          messageId: message.id,
          message,
        });
      });

      this.client = client;
      await client.login(config.botToken);
      return { success: true };
    } catch (e) {
      this.status.lastError = e instanceof Error ? e.message : String(e);
      this.logger.warn('[Discord] Connect error', { error: this.status.lastError });
      this.status.connected = false;
      return { success: false, error: this.status.lastError };
    }
  }

  /** 断开 Discord（对应 DiscordChannel.disconnect） */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch {
        // 忽略
      }
      this.client = null;
    }
    this.lastSenderId = null;
    this.status.connected = false;
  }

  /** 发送消息（对应 DiscordChannel.sendMessage，频道 fetch 失败回退 DM） */
  async sendMessage(to: string, text: string, _options?: SendOptions): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' };
    try {
      let target = String(_options?.['channelId'] || _options?.chatId || to);
      if (!target || target === 'me' || target === 'self') {
        target = this.lastSenderId || (this.client.user ? this.client.user.id : '');
        if (!target) return { success: false, error: '无法确定发送目标。请先在Discord中给机器人发消息。' };
      }
      let channel: DiscordChannel | null = null;
      try {
        channel = await this.client.channels.fetch(target);
      } catch {
        channel = null;
      }
      if (!channel) {
        // 回退：尝试作为 DM 用户处理
        try {
          const user = await this.client.users.fetch(target);
          if (user) {
            const dmChannel = await user.createDM();
            const sent = await dmChannel.send(text);
            this.status.messagesSent++;
            return { success: true, messageId: sent.id };
          }
        } catch {
          // DM 失败
        }
        return { success: false, error: 'Channel/DM not found: ' + target };
      }
      const sent = await channel.send(text);
      this.status.messagesSent++;
      return { success: true, messageId: sent.id };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  getTestTarget(): TestTarget {
    return {
      lastSenderId: this.lastSenderId || null,
      hasTarget: !!this.lastSenderId,
      hint: this.lastSenderId ? '目标: ' + this.lastSenderId : '需先在Discord发消息给机器人',
    };
  }

  /** 发送图片（对应 DiscordChannel.sendImage） */
  async sendImage(imagePath: string, to?: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' };
    try {
      if (!existsSync(imagePath)) return { success: false, error: 'File not found: ' + imagePath };
      const imageBuffer = readFileSync(imagePath);
      const ext = extname(imagePath).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'];
      if (imageExts.indexOf(ext) < 0 && !imagePath.match(/\.(png|jpe?g|gif|webp|bmp)$/i)) {
        return this.sendFile(imagePath, to);
      }
      const target = to || this.lastSenderId || (this.client.user ? this.client.user.id : '');
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[Discord] Sending image to ' + target + ': ' + imagePath);
      const channel = await this.client.channels.fetch(target);
      if (!channel) return { success: false, error: 'Channel not found: ' + target };
      const fileName = basename(imagePath);
      const sent = await channel.send({ files: [{ attachment: imageBuffer, name: fileName }] });
      this.status.messagesSent++;
      return { success: true, messageId: sent.id };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 发送文件（对应 DiscordChannel.sendFile） */
  async sendFile(filePath: string, to?: string): Promise<SendResult> {
    if (!this.client) return { success: false, error: 'Not connected' };
    try {
      if (!existsSync(filePath)) return { success: false, error: 'File not found: ' + filePath };
      const fileBuffer = readFileSync(filePath);
      const fileName = basename(filePath);
      const ext = extname(fileName).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].indexOf(ext) >= 0) {
        return this.sendImage(filePath, to);
      }
      const target = to || this.lastSenderId || (this.client.user ? this.client.user.id : '');
      if (!target) return { success: false, error: 'No target - need someone to message first' };
      this.logger.info('[Discord] Sending file to ' + target + ': ' + fileName);
      const channel = await this.client.channels.fetch(target);
      if (!channel) return { success: false, error: 'Channel not found: ' + target };
      const sent = await channel.send({ files: [{ attachment: fileBuffer, name: fileName }] });
      this.status.messagesSent++;
      return { success: true, messageId: sent.id };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
