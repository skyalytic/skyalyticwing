/**
 * 事件契约（契约先行架构 · 002）
 *
 * WS 事件类型（WsEvent 联合）已在 ../types/ws-events.ts 定义；本文件提供
 * 事件名的唯一常量表与载 guid 索引，杜绝前后端手写字符串漂移。
 * 新增事件时：先在 ws-events.ts 的 WsEvent 联合登记类型，再在此登记常量。
 */
import type { WsEvent } from '../types/ws-events.js';

/** 从 WsEvent 联合提取全部事件名字面量 */
export type WsEventType = WsEvent['type'];

/**
 * 事件名常量（唯一事实来源）。
 * 用法：wsClient.on(WS_EVENTS.TOOL_RESULT, ...) / ctx.broadcast(WS_EVENTS.FILE_OFFER, payload)
 */
export const WS_EVENTS = {
  CHAT_MESSAGE: 'chat_message',
  CHAT_STREAM: 'chat_stream',
  APPROVAL_REQUEST: 'approval_request',
  APPROVAL_RESOLVED: 'approval_resolved',
  APPROVAL_RESPONSE: 'approval_response',
  CHANNEL_STATUS: 'channel_status',
  CHANNEL_MESSAGE: 'channel_message',
  CRON_UPDATED: 'cron_updated',
  SESSION_RESTORED: 'session_restored',
  CONFIG_RELOADED: 'config_reloaded',
  TOOL_LOADED: 'tool_loaded',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  BACKGROUND_TASK: 'background_task',
  HEALTH: 'health',
  ERROR: 'error',
  NOTIFICATION: 'notification',
  SHOW_MESSAGE: 'show_message',
  AGENT_MESSAGE: 'agent_message',
  SUBAGENT_COMPLETED: 'subagent_completed',
  TOOLS_REFRESH: 'tools_refresh',
  PERMISSIONS_REFRESH: 'permissions_refresh',
  ISOLATED_AGENT_COMPLETED: 'isolated_agent_completed',
  ASK_USER_REQUEST: 'ask_user_request',
  FILE_OFFER: 'file_offer',
} as const;

// 编译期校验：WS_EVENTS 的值集合必须覆盖全部 WsEventType（新增事件漏登记时此处报错）
type _MissingEvents = Exclude<WsEventType, (typeof WS_EVENTS)[keyof typeof WS_EVENTS]>;
type _AssertEventsCovered = _MissingEvents extends never ? true : ['unregistered event types', _MissingEvents];
/** 编译期覆盖校验产物（恒为 true；事件名漏登记时编译失败） */
export const WS_EVENTS_COVERAGE_OK: _AssertEventsCovered = true;

/** 事件载荷索引：按事件名取对应 data 类型（契约消费方免强转） */
export type WsEventPayload<T extends WsEventType> = Extract<WsEvent, { type: T }>['data'];
