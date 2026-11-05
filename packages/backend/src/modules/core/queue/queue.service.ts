import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import { LoggerService } from '../logger/logger.service.js';
import { SecurityManagerService } from '../security/security-manager.service.js';
import { loadJsonFile, resolveWebDataDir, saveJsonFile } from '../utils/web-data.util.js';

/**
 * QueueService - 消息队列系统（GW-008 可靠投递）
 *
 * 移植自 start.cjs MessageQueue：
 *   - 最大队列长度 1000（满时淘汰最旧消息）
 *   - high 优先级消息插队（unshift）
 *   - 持久化 packages/web/data/queue.json
 *   - 手动出队（dequeue）触发执行并标记完成
 */

/** 队列项 */
export interface QueueItem {
  id: string;
  message: unknown;
  priority: 'normal' | 'high';
  timestamp: number;
  attempts: number;
  maxAttempts: number;
  status: 'queued' | 'processing' | 'completed' | 'retrying' | 'failed';
  completedAt?: number;
  error?: string;
}

/** 队列统计 */
export interface QueueStats {
  queueSize: number;
  isProcessing: boolean;
  maxSize: number;
}

/** 最大队列长度 */
const MAX_QUEUE_SIZE = 1000;

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly storePath = join(resolveWebDataDir(), 'queue.json');
  private queue: QueueItem[] = [];
  private processing = false;
  readonly maxSize = MAX_QUEUE_SIZE;

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  onModuleInit(): void {
    if (!this.security.isPathAllowed(this.storePath, 'readwrite')) {
      this.logger.warn(`queue: 数据文件路径不在允许列表: ${this.storePath}`);
    }
    const persisted = loadJsonFile<QueueItem[]>(this.storePath, []);
    if (Array.isArray(persisted)) {
      this.queue = persisted.filter((i) => i && typeof i.id === 'string');
    }
  }

  /** 入队（队列满时淘汰最旧；high 优先级插队） */
  enqueue(message: unknown, priority?: 'normal' | 'high'): QueueItem {
    if (this.queue.length >= this.maxSize) {
      this.logger.warn('queue: 队列已满，淘汰最旧消息');
      this.queue.shift();
    }
    const item: QueueItem = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message,
      priority: priority ?? 'normal',
      timestamp: Date.now(),
      attempts: 0,
      maxAttempts: 3,
      status: 'queued',
    };
    if (item.priority === 'high') this.queue.unshift(item);
    else this.queue.push(item);
    this.persist();
    this.logger.debug(`queue: 消息入队 ${item.id}（当前长度 ${this.queue.length}）`);
    return item;
  }

  /** 任务列表（最多 50 条） */
  list(): { items: QueueItem[]; total: number } {
    return { items: this.queue.slice(0, 50), total: this.queue.length };
  }

  /** 统计 */
  getStats(): QueueStats {
    return {
      queueSize: this.queue.length,
      isProcessing: this.processing,
      maxSize: this.maxSize,
    };
  }

  /** 清空队列 */
  clear(): { success: true } {
    this.queue = [];
    this.processing = false;
    this.persist();
    this.logger.info('queue: 队列已清空');
    return { success: true };
  }

  /** 出队执行：取出队首消息，标记 processing → completed */
  dequeue(): { success: true; item: QueueItem } | { success: false; error: string } {
    if (this.queue.length === 0) return { success: false, error: '队列为空' };
    this.processing = true;
    const item = this.queue.shift()!;
    item.status = 'processing';
    item.attempts += 1;
    try {
      item.status = 'completed';
      item.completedAt = Date.now();
      this.logger.debug(`queue: 消息已出队执行 ${item.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      item.error = message;
      item.status = item.attempts < item.maxAttempts ? 'retrying' : 'failed';
      if (item.status === 'retrying') this.queue.push(item);
    } finally {
      this.processing = false;
    }
    this.persist();
    return { success: true, item };
  }

  /** 持久化 */
  private persist(): void {
    if (!this.security.isPathAllowed(this.storePath, 'write')) {
      this.logger.warn('queue: 写入被路径安全策略拒绝');
      return;
    }
    saveJsonFile(this.storePath, this.queue);
  }
}
