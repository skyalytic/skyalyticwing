// WebSocket 客户端：自动重连（指数退避，最大 60s，上限 50 次），心跳，事件订阅，消息去重
import type { WsEvent, WsConnectionStatus } from '@/types';
import {
  buildWsUrl,
  WS_HEARTBEAT_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_MAX_SEEN_MESSAGES,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
} from '@/utils/constants';
import { withWsTokenParam } from './auth-token';

type EventListener = (event: WsEvent) => void;
type StatusListener = (status: WsConnectionStatus, attempts: number) => void;

/** 简单字符串哈希（djb2），用于无显式 id 的消息生成去重键 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

/**
 * 流式事件类型：内容增量帧不做去重。
 * 这些事件的每一帧都是合法的相同内容增量（如连续换行/重复缩进），
 * 若按整包 JSON 哈希去重会误杀第二帧导致流内容丢失。
 */
const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  'chat_stream',
  'chat:token',
  'chat:delta',
  'stream_token',
  'stream',
]);

/**
 * 通知类无状态事件：跳过去重。
 * 这些事件即使整包 JSON 完全相同（如连续两次相同的错误通知、健康检查结果），
 * 也是两次独立的有效推送，按整包哈希去重会误杀后者。
 */
const NON_DEDUP_EVENT_TYPES: ReadonlySet<string> = new Set([
  'error',
  'health',
  'agent_message',
  'subagent_completed',
  'tools_refresh',
  'approval_request',
  'ask_user_request',
]);

class WsClientImpl {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<EventListener>>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private status: WsConnectionStatus = 'disconnected';
  private manualClose = false;
  private url: string;
  /** 消息去重缓存（插入序，超限后淘汰最旧，LRU 清理） */
  private seenKeys = new Set<string>();

  constructor(url: string) {
    this.url = url;
  }

  /** 当前连接状态 */
  getStatus(): WsConnectionStatus {
    return this.status;
  }

  /** 当前重连次数 */
  getReconnectAttempts(): number {
    return this.attempts;
  }

  /**
   * 发送 Nest WsAdapter 格式消息（{event, data}）。
   * 连接未就绪时静默丢弃——订阅等控制消息由调用方在 connected 后触发，
   * 业务事件丢失由重连后的 subscribe 幂等补偿
   */
  send(event: string, data?: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify({ event, data: data ?? {} }));
    } catch {
      /* 发送失败由 onclose 兜底重连 */
    }
  }

  /** 建立连接 */
  connect(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    // CONNECTING/CLOSING 状态：旧 socket 的 close 事件会触发 handleClose 重连，
    // 此处直接 return 避免并发开第二个 socket（旧 socket 迟到的 onclose
    // 会清掉新 socket 引用导致连接风暴）
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      return;
    }
    if (this.socket && this.socket.readyState === WebSocket.CLOSING) {
      return;
    }
    this.manualClose = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  /** 主动断开（不会触发自动重连） */
  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onopen = null;
      this.socket.onmessage = null;
      try {
        this.socket.close();
      } catch {
        /* noop */
      }
      this.socket = null;
    }
    this.setStatus('disconnected');
    this.attempts = 0;
  }

  /** 强制重连 */
  reconnect(): void {
    this.disconnect();
    this.manualClose = false;
    this.connect();
  }

  /** 订阅指定类型事件 */
  on(eventType: string, callback: EventListener): () => void {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(callback);
    return () => this.off(eventType, callback);
  }

  /** 取消订阅 */
  off(eventType: string, callback: EventListener): void {
    const set = this.listeners.get(eventType);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(eventType);
    }
  }

  /** 订阅连接状态变化 */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.attempts);
    return () => this.statusListeners.delete(listener);
  }

  // ===== 内部实现 =====

  private openSocket(): void {
    try {
      // 每次连接时重新附加 token（用户在设置页更新 token 后重连即生效）
      this.socket = new WebSocket(withWsTokenParam(this.url));
    } catch {
      this.scheduleReconnect();
      return;
    }
    const socket = this.socket;
    this.socket.onopen = () => this.handleOpen();
    this.socket.onclose = () => this.handleClose(socket);
    this.socket.onerror = () => {
      /* 错误由 onclose 兜底处理 */
    };
    this.socket.onmessage = (e) => this.handleMessage(e);
  }

  private handleOpen(): void {
    this.attempts = 0;
    this.setStatus('connected');
    this.startHeartbeat();
  }

  /** 仅当 close 事件来自当前 socket 时才清理（防止被替换的旧 socket 迟到事件误杀新连接） */
  private handleClose(closed: WebSocket): void {
    if (closed !== this.socket) return;
    this.clearHeartbeat();
    this.socket = null;
    if (this.manualClose) {
      this.setStatus('disconnected');
      return;
    }
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  }

  private handleMessage(event: MessageEvent): void {
    let payload: unknown = event.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        /* 非 JSON，忽略 */
        return;
      }
    }
    if (!payload || typeof payload !== 'object') return;
    const wsEvent = payload as { type?: string };
    if (!wsEvent.type) return;
    const typed = payload as WsEvent;
    // 消息去重：相同 key 的事件直接丢弃
    if (this.isDuplicate(typed)) return;
    // 通知特定类型订阅者
    const set = this.listeners.get(typed.type);
    if (set) {
      for (const cb of set) cb(typed);
    }
    // 通知通配订阅者
    const wildcard = this.listeners.get('*');
    if (wildcard) {
      for (const cb of wildcard) cb(typed);
    }
  }

  /** 判断消息是否重复：优先用显式 id 字段，否则对内容做哈希；流式/通知类事件直接放行 */
  private isDuplicate(typed: WsEvent): boolean {
    // 流式增量帧与通知类无状态事件不做去重（见对应集合注释）
    if (STREAM_EVENT_TYPES.has(typed.type) || NON_DEDUP_EVENT_TYPES.has(typed.type)) return false;
    const data = (typed as { data?: Record<string, unknown> }).data;
    const idField =
      data && typeof data === 'object'
        ? (data['id'] ?? data['msgId'] ?? data['callId'] ?? data['approvalId'])
        : undefined;
    const key = `${typed.type}:${idField ?? hashString(JSON.stringify(typed))}`;
    if (this.seenKeys.has(key)) {
      return true;
    }
    this.seenKeys.add(key);
    // LRU 清理：超出上限后淘汰最旧的 key（Set 按插入序迭代）
    while (this.seenKeys.size > WS_MAX_SEEN_MESSAGES) {
      const oldest = this.seenKeys.keys().next().value;
      if (oldest === undefined) break;
      this.seenKeys.delete(oldest);
    }
    return false;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    // 达到最大重连次数上限后停止重连
    if (this.attempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('disconnected');
      return;
    }
    this.attempts += 1;
    const backoff = Math.min(
      WS_RECONNECT_BASE_MS * Math.pow(2, this.attempts - 1),
      WS_RECONNECT_MAX_MS,
    );
    // 加入少量抖动
    const jitter = Math.floor(Math.random() * 500);
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      if (!this.manualClose) this.openSocket();
    }, backoff + jitter);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // 文本层 ping（不依赖 WS ping 帧，兼容 Tauri WebView2）。
      // 后端为 WsAdapter + @SubscribeMessage('ping')，期望消息格式 {event, data}
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ event: 'ping', data: { timestamp: Date.now() } }));
        } catch {
          /* 发送失败由 onclose 兜底重连 */
        }
      }
    }, WS_HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: WsConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) cb(status, this.attempts);
  }
}

/** WebSocket 客户端单例 */
export const wsClient = new WsClientImpl(buildWsUrl());

export type WsClient = WsClientImpl;
