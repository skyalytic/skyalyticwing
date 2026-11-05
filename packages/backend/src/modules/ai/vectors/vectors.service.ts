import { existsSync } from 'node:fs';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { readJsonRecover } from '../../core/utils/atomic-json.util.js';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { getDefaultDataDir, resolveWebDataDir, saveJsonFile } from '../../core/utils/web-data.util.js';

/** 可选依赖统一经 dynamicRequire 加载（便于降级与审计） */
const dynamicRequire = createRequire(__filename);

/**
 * VectorsService - 向量存储 / 知识检索系统
 *
 * 移植自 start.cjs VectorKnowledgeSystem（KN-002 / KN-004）：
 *   - 哈希嵌入（256 维，中英文分词 + 双哈希签名投影 + L2 归一化）
 *   - 倒排索引候选召回 + 余弦相似度排序
 *   - 无向量命中时回退关键词匹配
 *   - 持久化 packages/web/data/vectors.json
 *
 * 若 @lancedb/lancedb 可用则优先使用 LanceDB 存储；否则降级为内存 + JSON 持久化。
 */

/** 向量条目 */
export interface VectorEmbedding {
  id: string;
  content: string;
  vector: number[];
  metadata: Record<string, unknown>;
  createdAt: number;
  tokens: number;
}

/** 搜索结果 */
export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  matchType: 'vector' | 'keyword';
}

/** 向量库统计 */
export interface VectorStats {
  totalEmbeddings: number;
  totalTerms: number;
  knowledgeEntries: number;
  lastSync: string | null;
  version: string;
  backend: 'lancedb' | 'json';
}

/** 向量库文件结构 */
interface VectorStoreFile {
  metadata: { version: string; dims: number; lastSync: string | null };
  embeddings: VectorEmbedding[];
}

/** 嵌入维度 */
const DIMS = 256;

@Injectable()
export class VectorsService implements OnModuleInit {
  private storePath = '';
  private get root(): string { const base=getDefaultDataDir(); return this.policy?.localMemoryRoot(base) ?? base; }
  private get lancedbDir(): string { return join(this.root, 'lancedb'); }
  private embeddings: VectorEmbedding[] = [];
  private index: Record<string, string[]> = {};
  private metadata: { version: string; dims: number; lastSync: string | null } = {
    version: '1.0.0',
    dims: DIMS,
    lastSync: null,
  };
  private backend: 'lancedb' | 'json' = 'json';
  private lancedb: {
    table: {
      add: (rows: Array<Record<string, unknown>>) => Promise<void>;
      delete: (predicate: string) => Promise<void>;
      search: (vector: number[]) => { limit: (n: number) => { toArray: () => Promise<Array<Record<string, unknown>>> } };
      countRows: () => Promise<number>;
    };
  } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
    @Optional() private readonly policy?: LocalResourcePolicy,
  ) {}

  async onModuleInit(): Promise<void> {
    try { this.ensureScope(); }
    catch(err) { this.logger.warn('Vector data unavailable; preserving files', {error:String(err)}); }
  }

  private ensureScope(): void {
    const path=join(this.root,'vectors.json');
    if (path!==this.storePath) {
      const legacy=join(resolveWebDataDir(),'vectors.json');
      const source=!existsSync(path) && !existsSync(path+'.bak') && this.root===getDefaultDataDir() && existsSync(legacy) ? legacy : path;
      const file=readJsonRecover<Partial<VectorStoreFile>>(source,{});
      const entries=file.embeddings ?? [];
      if (!Array.isArray(entries) || entries.some(e=>!e || typeof e.id!=='string' || typeof e.content!=='string' || !Array.isArray(e.vector))) throw new Error('向量文件损坏，已保留原文件');
      this.embeddings=entries;
      this.metadata={version:'1.0.0',dims:DIMS,lastSync:null,...file.metadata};
      this.storePath=path;
      this.lancedb=null; this.backend='json';
      this.rebuildIndex();
      void this.initLanceDb(path);
    }
    // A durable deletion marker takes precedence over an old, independently persisted index.
    const memory=readJsonRecover<{deletedKnowledgeIds?:string[]}>(join(this.root,'memory.json'),{});
    const deleted=new Set(memory.deletedKnowledgeIds ?? []);
    if (deleted.size) {
      const filtered=this.embeddings.filter(e=>!deleted.has(String(e.metadata?.['knowledgeId'] ?? '')));
      if (filtered.length!==this.embeddings.length) { this.embeddings=filtered; this.rebuildIndex(); }
    }
  }
  /** 尝试加载 LanceDB（不可用则降级 JSON） */
  private async initLanceDb(scope: string): Promise<void> {
    try {
      const mod = dynamicRequire('@lancedb/lancedb') as {
        connect: (uri: string) => Promise<{
          openTable: (name: string) => Promise<unknown>;
          createTable: (name: string, data: Array<Record<string, unknown>>) => Promise<unknown>;
        }>;
      };
      const db = await mod.connect(this.lancedbDir);
      let table: unknown;
      try {
        table = await db.openTable('vectors');
      } catch {
        table = await db.createTable('vectors', []);
      }
      if (this.storePath !== scope) return;
      this.lancedb = { table: table as never };
      this.backend = 'lancedb';
      this.logger.info('vectors: LanceDB 后端已启用');
    } catch {
      if (this.storePath === scope) this.backend = 'json';
    }
  }

  /** 添加向量（content ≤ 50000 字符） */
  addEmbedding(content: string, metadata: Record<string, unknown>): VectorEmbedding {
    this.ensureScope();
    if (!content || typeof content !== 'string') throw new Error('content不能为空且必须是字符串');
    if (content.length > 50000) throw new Error('内容过长，最大50000字符');
    const id = `vec-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const vector = this.textToVector(content);
    const embedding: VectorEmbedding = {
      id,
      content,
      vector,
      metadata: metadata ?? {},
      createdAt: Date.now(),
      tokens: content.split(/\s+/).length,
    };
    const next = [...this.embeddings, embedding];
    const meta = {...this.metadata, lastSync:new Date().toISOString()};
    this.persist({metadata:meta, embeddings:next});
    this.embeddings=next; this.metadata=meta;
    this.buildIndex(embedding);
    if (this.lancedb) {
      this.lancedb.table
        .add([{ id, vector, content, metadata: JSON.stringify(metadata), createdAt: embedding.createdAt, tokens: embedding.tokens }])
        .catch(() => undefined);
    }
    this.logger.info(`vectors: 已添加向量 ${id}（${embedding.tokens} tokens）`);
    return structuredClone(embedding);
  }

  /** 相似搜索（向量召回 → 关键词回退） */
  search(query: string, options?: { topK?: number; threshold?: number }): VectorSearchResult[] {
    this.ensureScope();
    if (!query.trim()) return [];
    const topK = Math.max(1, Math.min(options?.topK ?? 10, 100));
    const threshold = options?.threshold ?? 0.15;

    const queryVector = this.textToVector(query);
    const queryLower = query.toLowerCase();
    const asciiQuery = queryLower.match(/[a-zA-Z0-9_]+/g) ?? [];
    const cjkQuery = queryLower.match(/[\u4e00-\u9fff]{1,3}/g) ?? [];
    const queryWords: string[] = [...asciiQuery, ...cjkQuery];

    const candidateIds = new Set<string>();
    for (const word of queryWords) {
      for (const id of this.index[word] ?? []) candidateIds.add(id);
    }
    const candidates = this.embeddings.filter((e) => candidateIds.has(e.id));

    const vectorResults = candidates
      .map((embedding) => ({
        id: embedding.id,
        content: embedding.content.slice(0, 500),
        score: this.cosineSimilarity(queryVector, embedding.vector),
        metadata: structuredClone(embedding.metadata),
        createdAt: embedding.createdAt,
        matchType: 'vector' as const,
      }))
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score);

    if (vectorResults.length > 0) return vectorResults.slice(0, topK);

    return this.embeddings
      .filter((e) => {
        const text = `${String(e.metadata?.['title'] ?? '')} ${e.content ?? ''}`;
        return text.toLowerCase().includes(queryLower);
      })
      .map((e) => {
        const text = `${String(e.metadata?.['title'] ?? '')} ${e.content ?? ''}`;
        const idx = text.toLowerCase().indexOf(queryLower);
        return {
          id: e.id,
          content: e.content.slice(0, 500),
          score: Math.min(0.99, 0.1 + 0.5 / (idx + 1)),
          metadata: structuredClone(e.metadata),
          createdAt: e.createdAt,
          matchType: 'keyword' as const,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** 统计 */
  getStats(): VectorStats {
    this.ensureScope();
    let knowledgeCount = 0;
    for (const e of this.embeddings) {
      if (e.metadata?.['type'] === 'knowledge') knowledgeCount += 1;
    }
    return {
      totalEmbeddings: this.embeddings.length,
      totalTerms: Object.keys(this.index).length,
      knowledgeEntries: knowledgeCount,
      lastSync: this.metadata.lastSync,
      version: this.metadata.version,
      backend: this.backend,
    };
  }

  /** 列表（内容截断 300 字符，不含向量） */
  list(): { total: number; entries: Array<Omit<VectorEmbedding, 'vector'>> } {
    this.ensureScope();
    const entries = this.embeddings.map((e) => ({
      id: e.id,
      content: e.content.slice(0, 300),
      metadata: structuredClone(e.metadata),
      createdAt: e.createdAt,
      tokens: e.tokens,
    }));
    return { total: entries.length, entries };
  }

  /** 删除向量 */
  deleteEmbedding(id: string): { success: boolean; error?: string } {
    this.ensureScope();
    const next = this.embeddings.filter((e) => e.id !== id);
    if (next.length === this.embeddings.length) return { success: false, error: '向量不存在' };
    this.persist({metadata:this.metadata,embeddings:next});
    this.embeddings=next;
    this.rebuildIndex();
    if (this.lancedb) {
      this.lancedb.table.delete(`id = '${id.replace(/'/g, "''")}'`).catch(() => undefined);
    }
    return { success: true };
  }

  /** 文本 → 256 维哈希嵌入 */
  private textToVector(text: string): number[] {
    const words: string[] = [];
    const asciiWords = text.toLowerCase().split(/\W+/).filter(Boolean);
    const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
    words.push(...asciiWords);
    if (chineseChars.length > 0) {
      for (let ci = 0; ci < chineseChars.length; ci += 2) {
        words.push(chineseChars.slice(ci, Math.min(ci + 3, chineseChars.length)).join(''));
      }
      if (chineseChars.length === 1) words.push(chineseChars[0]!);
    }
    if (words.length === 0) words.push(text.slice(0, 20));

    const wordFreq: Record<string, number> = {};
    for (const w of words) wordFreq[w] = (wordFreq[w] ?? 0) + 1;

    const vector = new Array<number>(DIMS).fill(0);
    for (const [word, freq] of Object.entries(wordFreq)) {
      const tf = freq / words.length;
      const hash1 = createHash('sha256').update(word).digest();
      const hash2 = createHash('sha256').update(`${word}_v2`).digest();
      const numPositions = Math.min(8, DIMS);
      for (let pi = 0; pi < numPositions; pi++) {
        const idx = (hash1[pi % 32]! + hash2[pi % 32]!) % DIMS;
        const sign = (hash1[(pi + 16) % 32]! & 1) === 1 ? 1 : -1;
        vector[idx] += sign * tf;
      }
    }
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vector.map((v) => v / norm) : vector;
  }

  /** 余弦相似度（向量已归一化时等价于点积） */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
    const len = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /** 为单条向量构建倒排索引 */
  private buildIndex(embedding: VectorEmbedding): void {
    let allText = embedding.content ?? '';
    if (embedding.metadata) {
      if (typeof embedding.metadata['title'] === 'string') allText += ` ${embedding.metadata['title']}`;
      if (Array.isArray(embedding.metadata['tags'])) allText += ` ${embedding.metadata['tags'].join(' ')}`;
      if (typeof embedding.metadata['source'] === 'string') allText += ` ${embedding.metadata['source']}`;
    }
    const asciiWords = allText.match(/[a-zA-Z0-9_]+/g) ?? [];
    const cjkWords = allText.match(/[\u4e00-\u9fff]{1,3}/g) ?? [];
    const words: string[] = [...asciiWords, ...cjkWords];
    for (const word of words) {
      if (!this.index[word]) this.index[word] = [];
      this.index[word].push(embedding.id);
    }
  }

  /** 重建倒排索引 */
  private rebuildIndex(): void {
    this.index = {};
    for (const e of this.embeddings) this.buildIndex(e);
  }

  /** 持久化 */
  private persist(store: VectorStoreFile): void {
    if (!this.security.isPathAllowed(this.storePath, 'write')) {
      this.logger.warn('vectors: 写入被路径安全策略拒绝');
      throw new Error('向量索引未保存：写入被路径安全策略拒绝');
    }
    saveJsonFile(this.storePath, store);
  }
}

