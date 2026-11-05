import { createLogger, type Logger } from '@skyalyticwing/shared';
import type { DatabaseConfig } from '../types/index.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
// TS-11 fix: 移除未使用的 join 导入（TS6133）
import { dirname } from 'node:path';

export interface StorageProvider {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  // 增加 close() 方法，关闭时同步刷新未写入数据并清理定时器
  close(): void;
}

export class StorageFactory {
  static create(config: DatabaseConfig, logger?: Logger): StorageProvider {
    const log = logger ?? createLogger({ name: 'storage' });
    // M22: 根据 config.type 选择存储后端
    if (config.type === 'sqlite' && config.path) {
      return new FileStorageProvider(config.path, log);
    }
    // TODO: 集成 SQLite (Kysely) 或 PostgreSQL 以支持生产环境
    log.warn({ config }, 'Using in-memory storage — data will not persist after restart');
    return new MemoryStorageProvider();
  }
}

class MemoryStorageProvider implements StorageProvider {
  private data: Map<string, unknown> = new Map();
  // TS-11 fix: 移除未使用的 logger 字段（TS6133），FileStorageProvider 中的 logger 仍保留使用

  

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.data.keys()).filter(k => k.startsWith(prefix));
  }

  // 内存实现无需刷新，提供 noop close
  close(): void {
    /* no-op for in-memory provider */
  }
}

/** M22: 基于文件 JSON 的持久化存储，适用于开发和单机部署 */
class FileStorageProvider implements StorageProvider {
  private filePath: string;
  private data: Map<string, unknown> = new Map();
  private logger: Logger;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // TS-9 fix: 保存 exit 监听器引用，在 close() 中移除，避免重复调用与监听器泄漏
  private exitHandler: (() => void) | null = null;

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.load();
    // TS-9 fix: 使用 process.once 并保存引用，在 close() 中移除
    this.exitHandler = () => this.close();
    try {
      process.once('exit', this.exitHandler);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to register process exit hook for storage flush');
    }
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          this.data.set(k, v);
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load storage file, starting empty');
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1000);
  }

  private flush(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj: Record<string, unknown> = {};
      for (const [k, v] of this.data) obj[k] = v;
      // 采用 tmp + rename 原子写入，避免并发读取时读到半写文件或写入失败导致损坏
      const tmpPath = this.filePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf-8');
      renameSync(tmpPath, this.filePath);
      this.dirty = false;
    } catch (err) {
      this.logger.error({ err }, 'Failed to flush storage to file');
    }
  }

  // 关闭时清理定时器并同步 flush 一次，避免进程退出时丢失未写入数据
  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      this.flush();
    }
    // TS-9 fix: 移除 exit 监听器，避免重复调用
    if (this.exitHandler) {
      try { process.off('exit', this.exitHandler); } catch { /* ignore */ }
      this.exitHandler = null;
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    this.dirty = true;
    this.scheduleFlush();
  }

  async delete(key: string): Promise<boolean> {
    const result = this.data.delete(key);
    if (result) {
      this.dirty = true;
      this.scheduleFlush();
    }
    return result;
  }

  async list(prefix: string): Promise<string[]> {
    return Array.from(this.data.keys()).filter(k => k.startsWith(prefix));
  }
}
