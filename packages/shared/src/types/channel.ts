import type { Attachment } from './chat';

/** 渠道类型 */
export type ChannelType =
  | 'dingtalk'
  | 'feishu'
  | 'wechat-work'
  | 'discord'
  | 'qq'
  | 'telegram'
  | 'slack'
  | 'wecom'
  | 'weixin'
  | 'webhook';

/** 渠道状态 */
export type ChannelStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

/** 渠道配置 */
export interface ChannelConfig {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  credentials: Record<string, string>;
  options?: Record<string, unknown>;
}

/** 渠道消息 */
export interface ChannelMessage {
  id: string;
  channelId: string;
  direction: 'inbound' | 'outbound';
  content: string;
  sender?: string;
  target?: string;
  timestamp: number;
  attachments?: Attachment[];
}

/** 渠道状态信息 */
export interface ChannelStatusInfo {
  id: string;
  type: ChannelType;
  name: string;
  status: ChannelStatus;
  lastError?: string;
  connectedAt?: number;
  messageCount: number;
  /** 渠道分类（旧版渠道中心卡片展示）：local 本地 / im 即时通讯 / enterprise 企业应用 / other 其他 */
  category?: string;
  /** 是否启用（未保存配置的预定义渠道为 false，与旧版一致） */
  enabled?: boolean;
}

/** 渠道提供商接口 */
export interface ChannelProvider {
  readonly id: string;
  readonly type: ChannelType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(target: string, message: ChannelMessage): Promise<void>;
  onMessage(handler: (message: ChannelMessage) => void): void;
  getStatus(): ChannelStatusInfo;
}
