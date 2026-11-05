import { Injectable, Optional, OnModuleDestroy, OnModuleInit, OnApplicationBootstrap, NotFoundException, BadRequestException } from '@nestjs/common';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { InboxService } from './inbox.service.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import type {
  ChannelConfig,
  ChannelMessage,
  ChannelStatus,
  ChannelStatusInfo,
  ChannelType,
} from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { WebSocketService } from '../core/websocket/websocket.service.js';
import { ChannelRouterService } from './channel-router.service.js';
import {
  BaseProvider,
  type ChannelRuntimeStatus,
  type IncomingMessage,
  type MessageHandler,
  type RoutedSession,
  type SendOptions,
  type SendResult,
  type StatusChangeHandler,
} from './providers/base.provider.js';
import { DingTalkProvider } from './providers/dingtalk.service.js';
import { FeishuProvider } from './providers/feishu.service.js';
import { WeChatWorkProvider } from './providers/wechat-work.service.js';
import { DiscordProvider } from './providers/discord.service.js';
import { QQProvider } from './providers/qq.service.js';
import { TelegramProvider } from './providers/telegram.service.js';
import { SlackProvider } from './providers/slack.service.js';
import { WeComProvider } from './providers/wecom.service.js';
import { WeixinProvider } from './providers/weixin.service.js';

// ============================================================
// 类型定义
// ============================================================

/** 渠道运行时状态（含配置、连接状态与消息缓存） */
interface ChannelRuntime {
  config: ChannelConfig;
  status: ChannelStatus;
  lastError?: string;
  connectedAt?: number;
  messages: ChannelMessage[];
}

/** connectAll 的配置仓库（对应 channels.cjs connectAll 的 configStore） */
export interface ChannelConfigStore {
  channels?: Record<string, Record<string, unknown> | undefined>;
}

/** 单条渠道状态（getAllStatus 返回值项） */
export interface ChannelStatusSnapshot {
  connected: boolean;
  lastError: string | null;
  lastMessageAt: number | null;
  messagesReceived: number;
  messagesSent: number;
  [key: string]: unknown;
}

/** connect/reload 返回值（对应 channels.cjs result） */
export interface ChannelOperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

// ============================================================
// 常量
// ============================================================

/**
 * 预定义渠道全集（全量移植自旧版 start.cjs loadChannelsFromConfig 的 channels
 * 列表）：渠道中心按卡片展示全部渠道，enabled 由已保存配置决定。
 */
const PREDEFINED_CHANNELS: ReadonlyArray<{ id: string; name: string; category: string }> = [
  { id: 'weixin', name: '微信', category: 'im' },
  { id: 'wechat-work', name: '企业微信', category: 'enterprise' },
  { id: 'dingtalk', name: '钉钉', category: 'enterprise' },
  { id: 'feishu', name: '飞书', category: 'enterprise' },
  { id: 'email', name: 'Email', category: 'other' },
  { id: 'sms', name: 'SMS短信', category: 'other' },
  { id: 'cli', name: 'CLI终端', category: 'local' },
  { id: 'webchat', name: 'Web Chat', category: 'local' },
];
const retainedChannel = (type: string) => PREDEFINED_CHANNELS.some(channel=>channel.id===type);

/**
 * 支持的渠道类型清单（对应 channels.cjs createChannel 的 if 链）
 *
 * 全部九类渠道均已提供 NestJS provider 实现：
 * dingtalk / feishu / wechat-work / discord / qq /
 * telegram / slack / wecom / weixin
 */

/**
 * connectAll 中各渠道必填字段（对应 channels.cjs shouldConnect 的 requiredKey）
 * key = 渠道类型，value = 配置中必须存在的字段名（null 表示不强制校验）
 *
 * 注：wecom 为企业微信自建应用消息通道（corpId + corpSecret 换取 access_token），
 *     旧版 AI Bot WebSocket 模式由 wechat-work 类型承载。
 */
const CONNECT_REQUIRED_KEYS: Record<string, string | null> = {
  telegram: 'botToken',
  discord: 'botToken',
  slack: 'botToken',
  dingtalk: 'appKey',
  feishu: 'appId',
  'wechat-work': 'botId',
  qq: null,
  wecom: 'corpId',
  weixin: 'botToken',
};

/**
 * ChannelsService - 渠道管理服务
 *
 * 对应 channels.cjs 中 ChannelManager IIFE 单例，迁移至 NestJS 依赖注入版本。
 *
 * 职责：
 *   - 维护渠道配置（持久化到 channels.json）与运行时状态
 *   - 持有各渠道 provider 实例（按 type 注册，惰性创建）
 *   - 暴露 ChannelManager 接口：register / connect / disconnect / reload /
 *     connectAll / disconnectAll / getChannel / getAllStatus / sendMessage /
 *     onMessage / onStatusChange / getRouter
 *   - 接收消息后通过 WebSocketService 广播 channel_message 事件
 *   - 状态变更通过 WebSocketService 广播 channel_status 事件
 *
 * 注意：
 *   - API 响应通过 ChannelStatusInfo 返回，不含 credentials 等敏感字段
 *   - 所有 HTTP 操作经 provider 内部的 fetchWithTimeout 受 30s 超时约束
 *   - onMessage / onStatusChange 均去重注册（_handlerRegistered 守卫）
 */
@Injectable()
export class ChannelsService implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
  /** 配置运行时表：channelId -> ChannelRuntime（持久化到 channels.json） */
  private readonly channels = new Map<string, ChannelRuntime>();
  /** 已注册的 provider 实例表：type -> BaseProvider（对应 channels.cjs channels 字典） */
  private readonly providers = new Map<string, BaseProvider>();
  /** 配置文件路径 */
  private channelsPath = '';

  /** 消息处理器列表（对应 channels.cjs messageHandlers） */
  private readonly messageHandlers: MessageHandler[] = [];
  /** 状态变更处理器列表（对应 channels.cjs _statusChangeHandlers） */
  private readonly statusChangeHandlers: StatusChangeHandler[] = [];
  /** handler 注册守卫（对应 channels.cjs _handlerRegistered，防止重复注册） */
  private handlerRegistered = false;
  private readonly messageQueues=new Map<string,Promise<void>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private stopping = false;

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly router: ChannelRouterService,
    /** 已注入的 provider 集合（NestJS DI 自动注入所有 @Injectable() provider） */
    private readonly dingtalk: DingTalkProvider,
    private readonly feishu: FeishuProvider,
    private readonly wechatWork: WeChatWorkProvider,
    private readonly discord: DiscordProvider,
    private readonly qq: QQProvider,
    private readonly telegram: TelegramProvider,
    private readonly slack: SlackProvider,
    private readonly wecom: WeComProvider,
    private readonly weixin: WeixinProvider,
    @Optional() private readonly inbox?: InboxService,
  ) {}

  onModuleInit(): void {
    this.channelsPath = this.resolveDataFilePath('channels.json');
    this.load();
  }

  onApplicationBootstrap(): void {
    for (const [id, runtime] of this.channels) {
      if (runtime.config.enabled && retainedChannel(runtime.config.type)) void this.connectChannel(id).catch(() => {
        // connectChannel retains the actionable error for the channel card.
      });
    }
  }

  private async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => {
      if (this.stopping) throw new Error('Application is shutting down');
      return operation();
    });
    this.operations.set(id, pending);
    try { return await pending; }
    finally { if (this.operations.get(id) === pending) this.operations.delete(id); }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.operations.values());
    // 模块销毁时尝试断开所有已连接的 provider，避免遗留 socket/定时器
    try {
      await this.disconnectAll();
    } catch (err) {
      this.logger.warn('ChannelsService destroy: disconnectAll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================================
  // 控制器面向 API（保留原 ChannelsService 接口）
  // ============================================================

  /**
   * 列出渠道状态信息（已脱敏，不含 credentials）
   *
   * 对齐旧版 GET /channels 行为：返回预定义渠道全集（18 个，与 start.cjs
   * loadChannelsFromConfig 的 channels 列表一致），合并 channels.json 中
   * 已保存的启用状态与 provider 实际连接状态。前端渠道中心按卡片展示全集。
   */
  listChannels(): ChannelStatusInfo[] {
    const result: ChannelStatusInfo[] = [];
    for (const def of PREDEFINED_CHANNELS) {
      const runtime = this.channels.get(def.id);
      if (runtime) {
        const info = this.toStatusInfo(runtime);
        info.category = def.category;
        info.enabled = runtime.config.enabled;
        result.push(info);
      } else {
        result.push({
          id: def.id,
          type: def.id as ChannelType,
          name: def.name,
          status: def.id === 'cli' || def.id === 'webchat' ? 'connected' : 'disconnected',
          messageCount: 0,
          category: def.category,
          enabled: def.id === 'cli' || def.id === 'webchat',
        });
      }
    }
    // 已保存但不在预定义列表中的渠道（自定义类型）追加展示
    for (const [id, r] of this.channels) {
      if (PREDEFINED_CHANNELS.some((d) => d.id === id)) continue;
      if (!retainedChannel(r.config.type)) continue;
      result.push(this.toStatusInfo(r));
    }
    return result;
  }

  /** 添加渠道（持久化到 channels.json，不自动连接） */
  addChannel(config: ChannelConfig): void {
    if (!retainedChannel(config.type)) throw new BadRequestException('Channel is no longer supported');
    if (this.channels.has(config.id)) throw new BadRequestException('Channel already exists');
    const runtime: ChannelRuntime = {
      config: {
        ...config,
        credentials: { ...config.credentials },
      },
      status: 'disconnected',
      messages: [],
    };
    this.channels.set(config.id, runtime);
    try { this.persist(); } catch (error) { this.channels.delete(config.id); throw error; }
    this.logger.info('Channel added', { channelId: config.id, type: config.type });
  }

  /** Persist first, then apply through saveChannel; predefined cards are created on first save. */
  updateChannel(id: string, config: Partial<ChannelConfig>): void {
    for (const [key, value] of Object.entries(config.credentials ?? {})) {
      if (/token|secret|password|pass$|api.?key|authorization/i.test(key) && typeof value === 'string' && /^(?:\*+|•+|\[REDACTED\]|\*+REDACTED\*+)$/i.test(value.trim())) {
        throw new BadRequestException('收到脱敏占位符，未覆盖原有凭据；请重新扫码或输入真实密钥');
      }
    }
    let runtime = this.channels.get(id);
    const before = runtime?.config;
    if (!runtime) {
      const definition = PREDEFINED_CHANNELS.find(d => d.id === id);
      if (!definition) throw new NotFoundException('Channel not found: ' + id);
      runtime = { config: {id,type:id as ChannelType,name:definition.name,enabled:false,credentials:{}},status:'disconnected',messages:[] };
      this.channels.set(id, runtime);
    }
    const next = { ...runtime.config };
    if (config.name !== undefined) next.name = config.name;
    if (config.enabled !== undefined) next.enabled = config.enabled;
    if (config.credentials !== undefined) {
      next.credentials = { ...next.credentials, ...config.credentials };
    }
    if (config.options !== undefined) next.options = { ...next.options, ...config.options };
    runtime.config = next;
    try { this.persist(); }
    catch (error) { if(before) runtime.config=before;else this.channels.delete(id);throw error; }
  }

  getConfiguration(id: string) {
    const runtime = this.channels.get(id);
    if (!runtime && !PREDEFINED_CHANNELS.some(d => d.id === id)) throw new NotFoundException('Channel not found');
    const credentials: Record<string, unknown> = {}, configuredSecrets: string[] = [];
    for (const [key,value] of Object.entries(runtime?.config.credentials ?? {})) {
      if (/token|secret|password|pass$|api.?key|authorization/i.test(key)) {
        if (value) configuredSecrets.push(key);
      } else credentials[key] = value;
    }
    return { credentials, configuredSecrets };
  }

  async saveChannel(id: string, config: Partial<ChannelConfig>, background = false): Promise<ChannelStatusInfo> {
    return this.serialize(id, async () => {
      if(!this.channels.has(id)&&!PREDEFINED_CHANNELS.some(c=>c.id===id))throw new NotFoundException('Channel not found: '+id);
      const type = this.channels.get(id)?.config.type ?? id;
      if (config.enabled && !retainedChannel(type)) throw new BadRequestException('Channel is no longer supported');
      if (config.enabled && !['cli','webchat'].includes(type) && !Object.hasOwn(CONNECT_REQUIRED_KEYS,type)) throw new BadRequestException('该渠道尚未接入，暂不能启用或连接');
      this.updateChannel(id, config);
      const runtime = this.channels.get(id)!;
      await this.disconnectRuntime(id);
      if (runtime.config.enabled) {
        if (background) {
          runtime.status = 'connecting';
          this.broadcastStatus(id, 'connecting');
          // Enqueue after this save finishes; keep subsequent edits ordered.
          void this.connectChannel(id).catch(() => { /* Error retained in channel status. */ });
        } else {
          try { await this.connectRuntime(id); } catch { /* Saved, with an explicit connection error. */ }
        }
      }
      return this.toStatusInfo(runtime);
    });
  }

  /** 删除渠道（若已连接则先断开） */
  async removeChannel(id: string): Promise<void> {
    const runtime = this.channels.get(id);
    if (!runtime) return;
    // 若该渠道对应的 provider 已注册并连接，则先断开
    const provider = this.providers.get(runtime.config.type);
    if (provider && provider.status.connected) {
      try {
        await provider.disconnect();
      } catch (err) {
        this.logger.warn('Channel remove: disconnect failed', {
          channelId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (runtime.status === 'connected') {
      runtime.status = 'disconnected';
    }
    this.channels.delete(id);
    this.persist();
    this.logger.info('Channel removed', { channelId: id });
  }

  /** 连接渠道（控制器入口，对应 POST /api/channels/:id/connect） */
  async connectChannel(id: string): Promise<void> {
    return this.serialize(id, () => this.connectRuntime(id));
  }

  private async connectRuntime(id: string): Promise<void> {
    const runtime = this.channels.get(id);
    if (!runtime) throw new Error(`Channel not found: ${id}`);
    if (!retainedChannel(runtime.config.type)) throw new BadRequestException('Channel is no longer supported');
    if (!runtime.config.enabled) throw new Error(`Channel ${id} is disabled`);

    runtime.status = 'connecting';
    this.broadcastStatus(id, 'connecting');

    try {
      if (['cli','webchat'].includes(runtime.config.type)) {
        runtime.status='connected';delete runtime.lastError;this.broadcastStatus(id,'connected');return;
      }
      // 合并 credentials 与 options 作为 provider 配置（对应 .cjs channels[type].config）
      const providerConfig: Record<string, unknown> = {
        ...runtime.config.credentials,
        ...(runtime.config.options || {}),
        __channelId: runtime.config.id,
        __channelName: runtime.config.name,
      };

      const result = await this.connect(runtime.config.type, providerConfig);
      if (!result.success) {
        throw new Error(result.error || `Channel ${runtime.config.type} connect failed`);
      }
      runtime.status = 'connected';
      runtime.connectedAt = Date.now();
      delete runtime.lastError;
      this.broadcastStatus(id, 'connected');
      this.logger.info('Channel connected', { channelId: id });
    } catch (err) {
      runtime.status = 'error';
      runtime.lastError = err instanceof Error ? err.message : String(err);
      this.broadcastStatus(id, 'error');
      throw err;
    }
  }

  /** 重新加载渠道（断开 → 应用新配置 → 重连） */
  async reloadChannel(id: string, newConfig?: Partial<ChannelConfig>): Promise<ChannelOperationResult> {
    try {
      const channel = await this.saveChannel(id, newConfig ?? {});
      return { success:channel.status!=='error',...(channel.lastError?{error:channel.lastError}:{}) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 断开渠道（控制器入口，对应 POST /api/channels/:id/disconnect） */
  async disconnectChannel(id: string): Promise<void> {
    return this.serialize(id, () => this.disconnectRuntime(id));
  }

  private async disconnectRuntime(id: string): Promise<void> {
    const runtime = this.channels.get(id);
    if (!runtime) return;
    try {
      await this.disconnect(runtime.config.type);
    } catch (err) {
      this.logger.warn('Channel disconnect failed', {
        channelId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    runtime.status = 'disconnected';
    delete runtime.lastError;
    delete runtime.connectedAt;
    this.broadcastStatus(id, 'disconnected');
  }

  /** 发送消息到指定目标（控制器入口，对应 POST /api/channels/:id/send） */
  async sendMessage(id: string, target: string, content: string, options?: SendOptions): Promise<void> {
    const runtime = this.channels.get(id);
    if (!runtime) throw new Error(`Channel not found: ${id}`);
    if (runtime.status !== 'connected') throw new Error(`Channel ${id} is not connected`);

    const message: ChannelMessage = {
      id: randomUUID(),
      channelId: id,
      direction: 'outbound',
      content,
      target,
      timestamp: Date.now(),
    };

    // 委托给对应 provider 发送（对应 channels.cjs sendMessage）
    const result = await this.sendMessageToProvider(runtime.config.type, target, content, options);
    if (!result.success) {
      throw new Error(result.error || 'send failed');
    }
    runtime.messages.push(message);
  }

  /** 获取渠道消息（支持 limit 从最新开始截取） */
  getMessages(id: string, limit?: number): ChannelMessage[] {
    const runtime = this.channels.get(id);
    if (!runtime) return [];
    const msgs = runtime.messages;
    if (limit !== undefined && limit > 0) {
      const start = Math.max(0, msgs.length - limit);
      return msgs.slice(start);
    }
    return [...msgs];
  }

  /**
   * 接收外部渠道消息并广播。
   * 供渠道 provider 回调使用：消息入库后通过 WebSocket 广播 channel_message 事件。
   */
  receiveMessage(id: string, content: string, sender: string): void {
    const runtime = this.channels.get(id);
    if (!runtime) return;
    const message: ChannelMessage = {
      id: randomUUID(),
      channelId: id,
      direction: 'inbound',
      content,
      sender,
      timestamp: Date.now(),
    };
    runtime.messages.push(message);
    this.ws.broadcast({
      type: 'channel_message',
      data: { channel: id, content, sender },
    });
  }

  // ============================================================
  // ChannelManager IIFE 接口（对应 channels.cjs 导出的 ChannelManager）
  // ============================================================

  /**
   * 注册渠道 provider（对应 channels.cjs ChannelManager.register）
   *
   * 行为：
   *   - 通过 type 查找已注入的 provider 实例
   *   - 注册全局消息处理器与状态变更处理器（去重，仅注册一次）
   *   - 将 provider 缓存到 this.providers[type]
   */
  async register(type: string, _config: Record<string, unknown>): Promise<BaseProvider> {
    const provider = this.resolveProvider(type);
    if (!provider) {
      throw new Error('Unknown channel type: ' + type);
    }
    // 注册消息处理器（仅一次，对应 .cjs ch.onMessage 守卫）
    provider.onMessage(async (channelType, message, session) => {
      await this.dispatchMessage(channelType, message, session);
    });
    // 注册状态变更处理器（对应 .cjs _statusChangeHandlers）
    provider.onStatusChange((channelType, status) => {
      this.handleProviderStatusChange(channelType, status);
    });
    this.providers.set(type, provider);
    return provider;
  }

  /**
   * 连接渠道（对应 channels.cjs ChannelManager.connect）
   *
   * 若 provider 未注册则先 register；然后合并 config 并调用 provider.connect；
   * 通过 _notifyStatusChange 广播状态。
   */
  async connect(type: string, config: Record<string, unknown>): Promise<ChannelOperationResult> {
    if (!retainedChannel(type)) return { success: false, error: 'Channel is no longer supported' };
    let provider = this.providers.get(type);
    if (!provider) {
      provider = await this.register(type, config);
    }
    provider.config = { ...(provider.config || {}), ...config };
    let result: SendResult | void;
    try {
      result = await provider.connect(provider.config);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!result) {
      return {
        success: provider.status.connected,
        message: provider.status.connected ? type + ' 已连接' : '',
        error: provider.status.lastError || '',
      };
    }
    this.notifyStatusChange(type, { ...provider.status });
    return {
      success: result.success,
      message: result.success ? type + ' 已连接' : '',
      error: result.error || provider.status.lastError || '',
    };
  }

  /**
   * 断开渠道（对应 channels.cjs ChannelManager.disconnect）
   */
  async disconnect(type: string): Promise<void> {
    const provider = this.providers.get(type);
    if (!provider) return;
    try {
      await provider.disconnect();
    } finally {
      this.notifyStatusChange(type, { ...provider.status });
    }
  }

  /**
   * 重载渠道（对应 channels.cjs ChannelManager.reload）
   *
   * 流程：disconnect → 更新 config → connect
   */
  async reload(type: string, config?: Record<string, unknown>): Promise<ChannelOperationResult> {
    if (!retainedChannel(type)) return { success: false, error: 'Channel is no longer supported' };
    const provider = this.providers.get(type);
    if (provider) {
      try {
        await provider.disconnect();
      } catch (err) {
        this.logger.warn('Channel reload: disconnect failed', {
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.notifyStatusChange(type, { ...provider.status });
      if (config) {
        provider.config = { ...(provider.config || {}), ...config };
      }
    } else {
      if (!config) {
        return { success: false, error: 'Channel not found and no config: ' + type };
      }
      await this.register(type, config);
      const newProvider = this.providers.get(type);
      if (newProvider && !newProvider.config) {
        newProvider.config = { ...config };
      }
    }
    const targetProvider = this.providers.get(type);
    if (!targetProvider || !targetProvider.config) {
      return { success: false, error: 'Channel not found or no config: ' + type };
    }
    let result: SendResult | void;
    try {
      result = await targetProvider.connect(targetProvider.config);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!result) {
      const r: ChannelOperationResult = {
        success: targetProvider.status.connected,
        message: targetProvider.status.connected ? type + ' 已重连' : '',
        error: targetProvider.status.lastError || '',
      };
      this.notifyStatusChange(type, { ...targetProvider.status });
      return r;
    }
    this.notifyStatusChange(type, { ...targetProvider.status });
    return {
      success: result.success,
      message: result.success ? type + ' 已重连' : '',
      error: result.error || targetProvider.status.lastError || '',
    };
  }

  /**
   * 连接所有已启用渠道（对应 channels.cjs ChannelManager.connectAll）
   *
   * 并行连接；单个渠道失败不阻塞其它渠道。
   * shouldConnect 守卫：未启用/必填字段缺失/已连接则跳过。
   */
  async connectAll(configStore: ChannelConfigStore): Promise<void> {
    const chCfg = configStore.channels || {};
    const promises: Promise<void>[] = [];

    const shouldConnect = (
      type: string,
      cfg: Record<string, unknown> | undefined,
      requiredKey: string | null,
    ): boolean => {
      if (!cfg || !cfg['enabled']) return false;
      if (requiredKey && !cfg[requiredKey]) return false;
      const existing = this.providers.get(type);
      if (existing && existing.status.connected) {
        this.logger.info('[ChannelManager] ' + type + ' already connected, skipping');
        return false;
      }
      return true;
    };

    for (const type of Object.keys(CONNECT_REQUIRED_KEYS)) {
      if (!retainedChannel(type)) continue;
      const cfg = chCfg[type];
      const requiredKey = CONNECT_REQUIRED_KEYS[type] ?? null;
      if (!shouldConnect(type, cfg, requiredKey)) continue;
      promises.push(
        (async () => {
          try {
            await this.connect(type, { ...cfg });
          } catch (e: unknown) {
            this.logger.warn('[ChannelManager] ' + type + ' connect failed', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })(),
      );
    }

    await Promise.all(promises);
    this.logger.info('[ChannelManager] All channels initialized');
  }

  /** 断开所有已注册渠道（对应 channels.cjs ChannelManager.disconnectAll） */
  async disconnectAll(): Promise<void> {
    const types = Array.from(this.providers.keys());
    for (const type of types) {
      try {
        const provider = this.providers.get(type);
        if (provider) await provider.disconnect();
      } catch (err) {
        this.logger.warn('[ChannelManager] ' + type + ' disconnect failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** 获取 provider 实例（对应 channels.cjs ChannelManager.getChannel） */
  getChannel(type: string): BaseProvider | undefined {
    return this.providers.get(type);
  }

  /** 获取所有 provider 状态快照（对应 channels.cjs ChannelManager.getAllStatus） */
  getAllStatus(): Record<string, ChannelStatusSnapshot> {
    const status: Record<string, ChannelStatusSnapshot> = {};
    for (const channel of this.listChannels()) {
      const provider = this.providers.get(channel.type);
      status[channel.id] = {
        lastMessageAt:null,messagesReceived:0,messagesSent:0,
        ...provider?.getStatus(), ...channel,
        connected:channel.status==='connected',lastError:channel.lastError??null,
      };
    }
    return status;
  }

  /**
   * 发送消息（对应 channels.cjs ChannelManager.sendMessage）
   *
   * 委托给对应 provider；provider 不存在时返回失败。
   */
  async sendMessageToProvider(
    type: string,
    to: string,
    text: string,
    options?: SendOptions,
  ): Promise<SendResult> {
    const provider = this.providers.get(type);
    if (!provider) {
      return { success: false, error: 'Channel not found: ' + type };
    }
    try {
      return await provider.sendMessage(to, text, options);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 注册全局消息处理器（对应 channels.cjs ChannelManager.onMessage）
   *
   * _handlerRegistered 守卫：仅允许注册一次，重复注册会被忽略并打印警告。
   */
  onMessage(handler: MessageHandler): void {
    if (this.handlerRegistered) {
      this.logger.warn(
        '[ChannelManager] WARNING: onMessage handler already registered, skipping duplicate',
      );
      return;
    }
    this.handlerRegistered = true;
    this.messageHandlers.push(handler);
  }

  stageReply(type: string, peer: string, content: string, raw?: Record<string, unknown>) {
    let id=type;
    for(const [key,runtime] of this.channels) if(runtime.config.type===type){id=key;break;}
    if(!this.inbox) throw new Error('收件箱服务不可用，未发送回复');
    return this.inbox.suggest(id,peer,content,raw);
  }

  /** 注册状态变更处理器（对应 channels.cjs ChannelManager.onStatusChange） */
  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandlers.push(handler);
  }

  /** 获取路由器实例（对应 channels.cjs ChannelManager.getRouter） */
  getRouter(): ChannelRouterService {
    return this.router;
  }

  // ============================================================
  // 内部工具方法
  // ============================================================

  /**
   * 按 type 解析 provider 实例（对应 channels.cjs createChannel 的 if 链）
   *
   * 利用 NestJS 已注入的 provider 实例直接返回，避免重复构造。
   * 返回前同步 type/id/name 以确保 provider 元数据正确。
   */
  private resolveProvider(type: string): BaseProvider | null {
    let provider: BaseProvider | null = null;
    switch (type) {
      case 'dingtalk':
        provider = this.dingtalk;
        break;
      case 'feishu':
        provider = this.feishu;
        break;
      case 'wechat-work':
        provider = this.wechatWork;
        break;
      case 'discord':
        provider = this.discord;
        break;
      case 'qq':
        provider = this.qq;
        break;
      case 'telegram':
        provider = this.telegram;
        break;
      case 'slack':
        provider = this.slack;
        break;
      case 'wecom':
        provider = this.wecom;
        break;
      case 'weixin':
        provider = this.weixin;
        break;
      default:
        return null;
    }
    if (!provider) return null;
    // 同步元数据（type/id/name），保持与 .cjs 中 new XxxChannel(config) 后赋值一致
    provider.id = type;
    provider.name = type.charAt(0).toUpperCase() + type.slice(1);
    return provider;
  }

  /**
   * 分发收到的消息给所有已注册的业务处理器
   * （对应 channels.cjs 中调用 messageHandlers[i](...) 的循环）
   */
  private async dispatchMessage(
    channelType: string,
    message: IncomingMessage,
    session: RoutedSession,
  ): Promise<void> {

    // 找到对应的 channelId（通过 type 反查 this.channels）
    let channelId = channelType;
    for (const [id, runtime] of this.channels) {
      if (runtime.config.type === channelType) {
        channelId = id;
        break;
      }
    }
    // 入库 + WebSocket 广播（保留原 ChannelsService.receiveMessage 语义）
    if (this.inbox?.receive(channelId, message.id, message.from, message.text, message.timestamp, message.raw) === false) return;
    this.receiveMessage(channelId, message.text, message.from);

    // Persist immediately, then serialize AI work per routed conversation. New messages are not dropped.
    const previous=this.messageQueues.get(session.sessionId) || Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{
      for(const handler of this.messageHandlers) {
        try{await handler(channelType,message,session);}catch(err){this.logger.warn('[ChannelManager] message handler error',{channelType,error:err instanceof Error?err.message:String(err)});}
      }
    });
    this.messageQueues.set(session.sessionId,pending);
    try{await pending;}finally{if(this.messageQueues.get(session.sessionId)===pending)this.messageQueues.delete(session.sessionId);}
  }

  /**
   * provider 状态变更回调（对应 channels.cjs _notifyStatusChange）
   *
   * 同步更新对应 ChannelRuntime 状态并广播 WebSocket 事件。
   */
  private handleProviderStatusChange(channelType: string, status: ChannelRuntimeStatus): void {
    // 找到对应 channelId
    let channelId: string | null = null;
    for (const [id, runtime] of this.channels) {
      if (runtime.config.type === channelType) {
        channelId = id;
        break;
      }
    }
    if (channelId) {
      const runtime = this.channels.get(channelId);
      if (runtime) {
        if (status.connected) {
          runtime.status = 'connected';
          runtime.connectedAt = Date.now();
          if (status.lastError) runtime.lastError = status.lastError;
          else delete runtime.lastError;
          this.broadcastStatus(channelId, 'connected');
        } else {
          // Providers clear their previous connection before validating the new one.
          // Keep the manager's connecting state until success or an actual error.
          if (runtime.status !== 'connecting' || status.lastError) runtime.status = status.lastError ? 'error' : 'disconnected';
          if (status.lastError) runtime.lastError = status.lastError;
          if (!status.connected) delete runtime.connectedAt;
          this.broadcastStatus(channelId, runtime.status);
        }
      }
    }
    // 通知所有业务级状态变更处理器
    this.notifyStatusChange(channelType, status);
  }

  /** 通知所有状态变更处理器（对应 channels.cjs _notifyStatusChange） */
  private notifyStatusChange(channelType: string, status: ChannelRuntimeStatus): void {
    for (const handler of this.statusChangeHandlers) {
      try {
        handler(channelType, status);
      } catch {
        // 忽略处理器异常
      }
    }
  }

  /** 通过 WebSocket 广播渠道状态（保留原 ChannelsService 行为） */
  private broadcastStatus(channel: string, status: string): void {
    this.ws.broadcast({ type: 'channel_status', data: { channel, status } });
  }

  /** 转换为对外状态信息（脱敏，不含 credentials） */
  private toStatusInfo(r: ChannelRuntime): ChannelStatusInfo {
    const provider = this.providers.get(r.config.type);
    const current = provider?.getStatus();
    if (current && r.status !== 'connecting') {
      r.status = !r.config.enabled ? 'disconnected' : current.connected ? 'connected' : (current.lastError || r.lastError) ? 'error' : 'disconnected';
      if (r.config.enabled && current.lastError) r.lastError=current.lastError;
      else if (current.connected || !r.config.enabled) delete r.lastError;
    }
    const info: ChannelStatusInfo = {
      id: r.config.id,
      type: r.config.type,
      name: r.config.name,
      status: r.status,
      messageCount: r.messages.length,
      enabled: r.config.enabled,
    };
    if (r.lastError !== undefined) info.lastError = r.lastError;
    if (r.connectedAt !== undefined) info.connectedAt = r.connectedAt;
    return info;
  }

  /** 持久化渠道配置到 channels.json */
  private persist(): void {
    try {
      const dir = dirname(this.channelsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, ChannelConfig> = {};
      for (const [k, v] of this.channels) {
        data[k] = v.config;
      }
      writeJsonAtomicSync(this.channelsPath, data);
    } catch (err) {
      this.logger.warn('Failed to persist channels', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error('渠道配置保存失败，请检查数据目录是否可写');
    }
  }

  /** 从 channels.json 加载渠道配置 */
  private load(): void {
    try {
      if (!existsSync(this.channelsPath)) return;
      const parsed = readJsonRecover(this.channelsPath, {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [k, v] of Object.entries(parsed as Record<string, ChannelConfig>)) {
        if (v && typeof v === 'object' && typeof v.id === 'string') {
          this.channels.set(k, {
            config: v,
            status: 'disconnected',
            messages: [],
          });
        }
      }
    } catch (err) {
      this.logger.warn('Failed to load channels', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 解析数据文件路径（沿用 SKYALYTICWING_DATA_DIR 约定） */
  private resolveDataFilePath(filename: string): string {
    const dir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // 忽略
      }
    }
    return join(dir, filename);
  }

  private getDefaultDataDir(): string {
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
