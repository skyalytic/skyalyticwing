import type { ChannelConfig } from '../types/index.js';
import { createLogger, type Logger } from '@skyalyticwing/shared';

export interface ChannelMessage {
  id: string;
  channelId: string;
  peerId: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelHandler {
  onMessage(message: ChannelMessage): void | Promise<void>;
}

export abstract class BaseChannel {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: string;

  protected logger: Logger;
  protected handler?: ChannelHandler;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'channel' });
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract sendMessage(peerId: string, content: string): Promise<void>;

  onMessage(handler: ChannelHandler): void {
    this.handler = handler;
  }

  protected notifyHandler(message: ChannelMessage): void {
    try {
      const result = this.handler?.onMessage(message);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.logger.error({ error: err }, 'Channel handler error');
        });
      }
    } catch (err) {
      this.logger.error({ error: err }, 'Channel handler sync error');
    }
  }
}

export class ChannelRegistry {
  private channels: Map<string, BaseChannel> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'channel-registry' });
  }

  register(channel: BaseChannel): void {
    // 注册同名 channel 前先 disconnect 旧 channel，避免资源泄漏与旧连接残留
    const existing = this.channels.get(channel.id);
    if (existing && existing !== channel) {
      this.logger.warn({ channel: channel.id }, 'Channel already registered, disconnecting old instance before overwriting');
      // fire-and-forget，因 register 为同步方法；catch 错误避免未处理的 Promise 拒绝
      void existing.disconnect().catch((err) => {
        this.logger.error({ channel: channel.id, error: err }, 'Failed to disconnect old channel during register');
      });
    }
    this.channels.set(channel.id, channel);
    this.logger.info({ channel: channel.id }, 'Channel registered');
  }

  unregister(channelId: string): void {
    // TS-5 fix: 删除前先断开连接，避免资源泄漏，与 register() 行为一致
    const channel = this.channels.get(channelId);
    if (channel) {
      void channel.disconnect().catch((err) => {
        this.logger.error({ channel: channelId, error: err }, 'Failed to disconnect channel during unregister');
      });
    }
    this.channels.delete(channelId);
  }

  get(channelId: string): BaseChannel | undefined {
    return this.channels.get(channelId);
  }

  list(): BaseChannel[] {
    return Array.from(this.channels.values());
  }

  async connectAll(configs: ChannelConfig[]): Promise<void> {
    for (const config of configs) {
      if (!config.enabled) continue;
      let channel = this.channels.get(config.name);
      // Fallback: try matching by channel name if config.name doesn't match channel.id
      if (!channel) {
        channel = Array.from(this.channels.values()).find(ch => ch.name === config.name);
      }
      if (channel) {
        try {
          await channel.connect();
          this.logger.info({ channel: config.name }, 'Channel connected');
        } catch (error) {
          this.logger.error({ channel: config.name, error }, 'Channel connection failed');
        }
      } else {
        this.logger.warn({ channel: config.name }, 'Channel not found in registry');
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.disconnect();
      } catch (error) {
        this.logger.error({ channel: channel.id, error }, 'Channel disconnect failed');
      }
    }
  }
}
