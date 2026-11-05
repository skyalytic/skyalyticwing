/**
 * ChatControlRegistry - 聊天控制注册表（进程级单例）
 *
 * 移植自 start.cjs 的 _chatAbortFlags / _steeringQueues（行 33850-33868）。
 *
 * 职责：
 *   - 中断标志：POST /api/chat/stop 设置标志位，AgentLoopService 每轮迭代
 *     检查并消费（读取即清除），实现"停止当前生成"
 *   - 引导队列：POST /api/steer 入队，AgentLoopService 在迭代边界弹出并
 *     注入为新的用户指令，实现"会话引导"
 *
 * 采用模块级单例而非 Nest provider，避免 AgentModule 与 ChatModule
 * 之间的循环依赖（AgentLoopService 直接 import 本注册表）。
 */

/** 引导队列条目 */
export interface SteerEntry {
  message: string;
  timestamp: number;
}

class ChatControlRegistryImpl {
  private readonly inactiveListeners = new Set<(sessionId: string) => void>();
  onInactive(listener: (sessionId: string) => void): () => void {
    this.inactiveListeners.add(listener);
    return () => this.inactiveListeners.delete(listener);
  }
  private readonly abortListeners = new Set<(sessionId?: string) => void>();
  onAbort(listener: (sessionId?: string) => void): () => void {
    this.abortListeners.add(listener);
    return () => this.abortListeners.delete(listener);
  }
  /** sessionId → 中断标志 */
  private readonly abortFlags = new Map<string, boolean>();
  /** sessionId → 引导队列 */
  private readonly steerQueues = new Map<string, SteerEntry[]>();
  /** 正在生成中的会话集合（AgentLoopService.run 开始/结束时登记/注销） */
  private readonly activeSessions = new Set<string>();

  /** 请求中断指定会话（sessionId 为空时中断全部活跃会话） */
  requestAbort(sessionId?: string): string[] {
    for (const listener of this.abortListeners) listener(sessionId);
    if (sessionId) {
      this.abortFlags.set(sessionId, true);
      return [sessionId];
    }
    // 中断标志是"读取即清除"语义，生成中的会话通常不在 abortFlags 里；
    // 因此"停止全部"必须以 activeSessions 为准，否则无人可中断。
    const keys = this.activeSessions.size > 0
      ? Array.from(this.activeSessions)
      : Array.from(this.abortFlags.keys());
    for (const k of keys) this.abortFlags.set(k, true);
    return keys;
  }

  /** 标记会话为生成中（AgentLoopService.run 开始时调用） */
  markActive(sessionId: string): void {
    if (sessionId) this.activeSessions.add(sessionId);
  }

  /** 标记会话生成结束（run 正常结束/异常/被关闭时调用） */
  markInactive(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    for (const listener of this.inactiveListeners) listener(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /** 检查会话是否被请求中断（消费语义：读取后清除） */
  consumeAbort(sessionId: string): boolean {
    const flagged = this.abortFlags.get(sessionId) === true;
    if (flagged) this.abortFlags.delete(sessionId);
    return flagged;
  }

  /** 清除中断标志 */
  clearAbort(sessionId: string): void {
    this.abortFlags.delete(sessionId);
  }

  /** 入队引导消息 */
  pushSteer(sessionId: string, message: string): void {
    let queue = this.steerQueues.get(sessionId);
    if (!queue) {
      queue = [];
      this.steerQueues.set(sessionId, queue);
    }
    queue.push({ message, timestamp: Date.now() });
  }

  /** 弹出最早的引导消息（无则返回 null） */
  popSteer(sessionId: string): SteerEntry | null {
    const queue = this.steerQueues.get(sessionId);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  /** 清空引导队列 */
  clearSteers(sessionId: string): void {
    this.steerQueues.delete(sessionId);
  }
}

/** 进程级单例：ChatControlService 与 AgentLoopService 共享 */
export const ChatControlRegistry = new ChatControlRegistryImpl();
