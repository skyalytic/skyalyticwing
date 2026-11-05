import { createLogger, type Logger, generateId } from '@skyalyticwing/shared';

export interface MemoryEntry {
  id: string;
  content: string;
  type: 'fact' | 'preference' | 'instruction' | 'context';
  agentId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  entries: MemoryEntry[];
  total: number;
}

// Map 最大条目限制，超过时淘汰最旧条目（Map 保留插入顺序，迭代从最旧开始）。
// 避免 memory/state/agent/acp 等 Map 长期运行后无界增长导致内存泄漏。
const MAX_ENTRIES = 10000;

interface IndexedMemoryEntry extends MemoryEntry {
  // 在存储时预计算 content 的小写形式，避免 search() 在循环中
  // 对每个 entry 重复调用 toLowerCase（每次 O(N) 字符串拷贝，N 次搜索即 N*M 次）。
  _contentLower: string;
}

export class MemoryStore {
  private logger: Logger;
  private entries: Map<string, IndexedMemoryEntry> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'memory' });
  }

  // TS-14 fix: 剥离内部字段 _contentLower，避免泄漏给调用方
  private stripInternal(entry: IndexedMemoryEntry): MemoryEntry {
    const { _contentLower: _, ...rest } = entry;
    return rest;
  }

  async store(agentId: string, content: string, type: MemoryEntry['type'] = 'fact', metadata?: Record<string, unknown>): Promise<MemoryEntry> {
    const entry: IndexedMemoryEntry = {
      id: generateId(),
      content,
      type,
      agentId,
      timestamp: new Date().toISOString(),
      // TS-11 fix: metadata 为 undefined 时不赋值，满足 exactOptionalPropertyTypes
      // 存储时一次性预计算小写索引，search 时直接复用
      _contentLower: content.toLowerCase(),
    };
    if (metadata !== undefined) entry.metadata = metadata;
    this.entries.set(entry.id, entry);
    // 超过上限时淘汰最旧条目（Map 迭代顺序按插入顺序，keys().next() 返回最旧 key）
    if (this.entries.size > MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.logger.debug({ id: entry.id, type, agentId }, 'Memory stored');
    return this.stripInternal(entry);
  }

  async search(query: string, agentId?: string, limit = 10): Promise<MemorySearchResult> {
    if (!query) return { entries: [], total: 0 };
    // query 小写只计算一次，entry content 小写已在 store 时预计算（_contentLower）
    const queryLower = query.toLowerCase();
    let results = Array.from(this.entries.values());
    if (agentId) results = results.filter(e => e.agentId === agentId);
    // Simple text matching - will integrate with vector search
    results = results.filter(e => e._contentLower.includes(queryLower));
    // TS-14 fix: 返回前剥离内部字段 _contentLower
    return { entries: results.slice(0, limit).map(e => this.stripInternal(e)), total: results.length };
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    // TS-14 fix: 返回前剥离内部字段 _contentLower
    const entry = this.entries.get(id);
    return entry ? this.stripInternal(entry) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async list(agentId?: string): Promise<MemoryEntry[]> {
    let results = Array.from(this.entries.values());
    if (agentId) results = results.filter(e => e.agentId === agentId);
    // TS-14 fix: 返回前剥离内部字段 _contentLower
    return results.map(e => this.stripInternal(e));
  }
}
