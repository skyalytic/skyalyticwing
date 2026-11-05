import type { WsEvent } from '@skyalyticwing/shared';

/**
 * WebSocket 事件类型常量
 *
 * 与 @skyalyticwing/shared 中 WsEvent 的 type 字段保持同步，
 * 便于在代码中以常量形式引用而非魔法字符串。
 */
export const WS_EVENTS = {
  /** 聊天消息 */
  CHAT_MESSAGE: 'chat_message',
  /** 流式聊天增量 */
  CHAT_STREAM: 'chat_stream',
  /** 工具审批请求 */
  APPROVAL_REQUEST: 'approval_request',
  /** 工具审批响应 */
  APPROVAL_RESPONSE: 'approval_response',
  /** 渠道状态变更 */
  CHANNEL_STATUS: 'channel_status',
  /** 定时任务变更 */
  CRON_UPDATED: 'cron_updated',
  /** 工具执行结果 */
  TOOL_RESULT: 'tool_result',
  /** 健康检查 */
  HEALTH: 'health',
  /** 错误事件 */
  ERROR: 'error',
} as const;

export type WsEventType =
  | 'chat_message'
  | 'chat_stream'
  | 'approval_request'
  | 'approval_response'
  | 'channel_status'
  | 'cron_updated'
  | 'tool_result'
  | 'health'
  | 'error';

/** 客户端连接后下发的连接就绪事件 */
export const WS_CONNECTED_EVENT = 'connected' as const;

/** 客户端订阅会话消息的 type */
export const WS_SUBSCRIBE_EVENT = 'subscribe' as const;

/** 客户端取消订阅会话消息的 type */
export const WS_UNSUBSCRIBE_EVENT = 'unsubscribe' as const;

/** 客户端心跳消息 type（注意：服务端不会基于 ping/pong 终止连接） */
export const WS_PING_EVENT = 'ping' as const;
export const WS_PONG_EVENT = 'pong' as const;

/** WebSocket 关闭码（应用层自定义 4xxx 段） */
export const WS_CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  UNAUTHORIZED: 4001,
  TOO_MANY_CONNECTIONS: 4013,
  INTERNAL_ERROR: 1011,
} as const;

/** 最大并发连接数 */
export const WS_MAX_CONNECTIONS = 100;

/** 单帧最大 payload (10MB) */
export const WS_MAX_PAYLOAD = 10 * 1024 * 1024;

/** WsEvent 类型别名（从 shared 复用） */
export type { WsEvent };

/** 客户端订阅消息 */
export interface WsSubscribeMessage {
  type: typeof WS_SUBSCRIBE_EVENT;
  sessionId: string;
}

/** 客户端取消订阅消息 */
export interface WsUnsubscribeMessage {
  type: typeof WS_UNSUBSCRIBE_EVENT;
  sessionId?: string;
}
