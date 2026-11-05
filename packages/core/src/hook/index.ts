import { createLogger, type Logger, generateId } from '@skyalyticwing/shared';

export type HookEvent = string;
export type HookHandler = (data: unknown) => void | Promise<void>;

export interface HookSubscription {
  id: string;
  event: HookEvent;
  handler: HookHandler;
}

export class HookEngine {
  private logger: Logger;
  private subscriptions: Map<string, HookSubscription[]> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'hooks' });
  }

  on(event: HookEvent, handler: HookHandler): () => void {
    const id = generateId();
    const sub: HookSubscription = { id, event, handler };
    const subs = this.subscriptions.get(event) ?? [];
    subs.push(sub);
    this.subscriptions.set(event, subs);
    return () => this.off(event, id);
  }

  off(event: HookEvent, subscriptionId: string): void {
    const subs = this.subscriptions.get(event);
    if (subs) {
      this.subscriptions.set(event, subs.filter(s => s.id !== subscriptionId));
    }
  }

  async emit(event: HookEvent, data?: unknown): Promise<void> {
    const subs = this.subscriptions.get(event) ?? [];
    // 使用 Promise.resolve().then() 包装，确保同步抛出的异常也被 allSettled 捕获
    const results = await Promise.allSettled(
      subs.map(sub => Promise.resolve().then(() => sub.handler(data)))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ error: result.reason, hook: event }, 'Hook handler error');
      }
    }
  }
}
