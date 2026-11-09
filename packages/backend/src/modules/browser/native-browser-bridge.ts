import { randomUUID } from 'node:crypto';

export interface NativeCommand {
  id: string;
  sessionId: string;
  op: string;
  args: Record<string, unknown>;
}
interface Pending {
  command: NativeCommand;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
  claimed: boolean;
}

/** The trusted desktop UI relays commands to system webviews. Web pages never get this channel. */
export class NativeBrowserBridge {
  enabled = false;
  private owner = '';
  private heartbeat = 0;
  private pending = new Map<string, Pending>();
  private states = new Map<string, any>();

  connect(owner: string) {
    if (!/^[\w-]{16,100}$/.test(owner)) throw new Error('无效的桌面浏览器连接');
    if (this.owner && this.owner !== owner && Date.now() - this.heartbeat < 5000)
      throw new Error('桌面浏览器已有活动连接');
    if (owner !== this.owner) {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('桌面浏览器连接已更新'));
      }
      this.pending.clear();
      this.states.clear();
    }
    this.owner = owner;
    this.heartbeat = Date.now();
    this.enabled = true;
    return { connected: true };
  }
  poll(owner: string, states?: Record<string, unknown>) {
    if (owner !== this.owner) throw new Error('桌面浏览器连接已失效');
    this.heartbeat = Date.now();
    if (states)
      for (const [key, state] of Object.entries(states).slice(0, 12)) this.states.set(key, state);
    const commands: NativeCommand[] = [];
    for (const p of this.pending.values())
      if (!p.delivered) {
        p.delivered = true;
        commands.push(p.command);
      }
    return { commands };
  }
  finish(owner: string, id: string, result: unknown, error?: string) {
    if (owner !== this.owner) throw new Error('桌面浏览器连接已失效');
    const p = this.pending.get(id);
    if (!p?.claimed) return { accepted: false };
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(String(error).slice(0, 1000)));
    else p.resolve(result);
    return { accepted: true };
  }
  state(sessionId: string) {
    return this.states.get(sessionId);
  }
  claim(owner: string, id: string) {
    const pending = this.pending.get(id);
    if (owner !== this.owner || !pending?.delivered || pending.claimed) return { allowed: false };
    pending.claimed = true;
    return { allowed: true };
  }
  cancel(sessionId: string) {
    for (const [id, p] of this.pending)
      if (p.command.sessionId === sessionId) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error('用户已接管浏览器，AI 操作已取消'));
      }
  }
  request<T>(
    sessionId: string,
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = 24000,
  ): Promise<T> {
    if (!this.enabled || Date.now() - this.heartbeat > 5000)
      return Promise.reject(new Error('桌面浏览器未连接，请保持 Wing 窗口打开'));
    if (this.pending.size >= 48) return Promise.reject(new Error('浏览器操作队列已满'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error('桌面浏览器响应超时'));
        },
        Number.isFinite(timeoutMs) ? Math.min(24000, Math.max(1, timeoutMs)) : 24000,
      );
      this.pending.set(id, {
        command: { id, sessionId, op, args },
        resolve,
        reject,
        timer,
        delivered: false,
        claimed: false,
      });
    });
  }
}
