// TS-11 fix: 移除未使用的 generateId 导入（TS6133）
import { createLogger, type Logger } from '@skyalyticwing/shared';

export interface StateEntry {
  key: string;
  value: unknown;
  namespace: string;
  updatedAt: string;
}

// Map 最大条目限制，超过时淘汰最旧条目，避免无界增长导致内存泄漏。
const MAX_STATE_ENTRIES = 10000;

export class StateStore {
  private logger: Logger;
  private store: Map<string, StateEntry> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'state' });
  }

  private key(namespace: string, key: string): string {
    return `${namespace}\0${key}`;
  }

  get<T = unknown>(namespace: string, key: string): T | undefined {
    const entry = this.store.get(this.key(namespace, key));
    return entry?.value as T | undefined;
  }

  set(namespace: string, key: string, value: unknown): void {
    this.store.set(this.key(namespace, key), {
      key,
      value,
      namespace,
      updatedAt: new Date().toISOString(),
    });
    // TS-11 fix: 使用 logger 消除未使用警告
    this.logger.debug({ namespace, key }, 'State updated');
    // 超过上限时淘汰最旧条目（Map 按插入顺序迭代）
    if (this.store.size > MAX_STATE_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
  }

  delete(namespace: string, key: string): boolean {
    return this.store.delete(this.key(namespace, key));
  }

  list(namespace: string): StateEntry[] {
    return Array.from(this.store.values()).filter(e => e.namespace === namespace);
  }
}
