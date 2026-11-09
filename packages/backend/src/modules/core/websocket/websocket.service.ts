import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { WebSocket } from 'ws';
import type { WsEvent } from '@skyalyticwing/shared';

/** 单个客户端连接的内部状态 */
export interface WsClientState {
  /** 客户端唯一 ID（服务端生成） */
  id: string;
  /** 原始 ws 实例 */
  socket: WebSocket;
  /** 连接建立时间戳 */
  connectedAt: number;
  /** 该客户端订阅的会话 ID 集合（用于 broadcastToSession） */
  sessions: Set<string>;
}

/**
 * WebSocketService - WebSocket 广播服务
 *
 * 由 WebSocketGateway 在连接建立/断开时调用 register/unregister 维护客户端表，
 * 业务模块注入本服务进行事件广播。
 *
 * 事件类型遵循 @skyalyticwing/shared 的 WsEvent 联合类型。
 */
@Injectable()
export class WebSocketService {
  constructor(@Optional() private readonly events?: EventEmitter2) {}
  private readonly logger = new Logger(WebSocketService.name);
  /** clientId → 客户端状态 */
  private readonly clients = new Map<string, WsClientState>();
  /** sessionId → 订阅该会话的客户端 ID 集合（反向索引，便于广播） */
  private readonly sessionIndex = new Map<string, Set<string>>();

  /** 由 Gateway 在新连接建立时调用 */
  register(client: WsClientState): void {
    this.clients.set(client.id, client);
  }

  /** 由 Gateway 在连接断开时调用 */
  unregister(clientId: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    // 清理会话反向索引
    for (const sessionId of state.sessions) {
      const set = this.sessionIndex.get(sessionId);
      if (set) {
        set.delete(clientId);
        if (set.size === 0) this.sessionIndex.delete(sessionId);
      }
    }
    this.clients.delete(clientId);
  }

  /** 客户端订阅会话 */
  subscribeSession(clientId: string, sessionId: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.sessions.add(sessionId);
    let set = this.sessionIndex.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionIndex.set(sessionId, set);
    }
    set.add(clientId);
  }

  /** 客户端取消订阅会话；sessionId 缺省则取消该客户端全部订阅 */
  unsubscribeSession(clientId: string, sessionId?: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    if (sessionId) {
      state.sessions.delete(sessionId);
      const set = this.sessionIndex.get(sessionId);
      if (set) {
        set.delete(clientId);
        if (set.size === 0) this.sessionIndex.delete(sessionId);
      }
    } else {
      for (const sid of state.sessions) {
        const set = this.sessionIndex.get(sid);
        if (set) {
          set.delete(clientId);
          if (set.size === 0) this.sessionIndex.delete(sid);
        }
      }
      state.sessions.clear();
    }
  }

  /** 广播给所有已连接客户端 */
  broadcast(event: WsEvent): void {
    this.events?.emit('runtime.observation', event);
    const payload = JSON.stringify(event);
    for (const state of this.clients.values()) {
      this.safeSend(state, payload);
    }
  }

  /** 广播给订阅了指定会话的客户端 */
  broadcastToSession(sessionId: string, event: WsEvent): void {
    const payload = JSON.stringify(event);
    const subscribers = this.sessionIndex.get(sessionId);
    if (!subscribers) return;
    for (const clientId of subscribers) {
      const state = this.clients.get(clientId);
      if (state) this.safeSend(state, payload);
    }
  }

  /** 发送给指定客户端（按 clientId） */
  sendToClient(clientId: string, event: WsEvent): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    this.safeSend(state, JSON.stringify(event));
  }

  /** 当前并发连接数 */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /** 获取全部客户端 ID（用于调试/监控） */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  private safeSend(state: WsClientState, payload: string): void {
    if (state.socket.readyState !== 1 /* WebSocket.OPEN */) return;
    try {
      state.socket.send(payload);
    } catch (err) {
      this.logger.debug(
        `Failed to send to client ${state.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
