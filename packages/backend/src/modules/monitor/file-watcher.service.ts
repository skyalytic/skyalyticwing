import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { watch, type FSWatcher } from 'node:fs';
import { LoggerService } from '../core/logger/logger.service.js';
import { SecurityManagerService } from '../core/security/security-manager.service.js';

/**
 * FileWatcherService - 文件监控服务
 *
 * 职责：
 *   - watch：监控指定路径的文件变化（基于 fs.watch）
 *   - unwatch：停止监控
 *
 * 安全：所有路径须通过 SecurityManagerService.isPathAllowed 校验，
 * 校验失败时抛错并不建立监控。
 */
@Injectable()
export class FileWatcherService implements OnModuleDestroy {
  /** 监控路径 → FSWatcher */
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  /** 监控文件变化 */
  watch(path: string, callback: (event: string, filename: string) => void): void {
    if (!path || typeof path !== 'string') {
      throw new Error('watch path is required');
    }
    if (!this.security.isPathAllowed(path)) {
      throw new Error(`Path not allowed by security guard: ${path}`);
    }
    // 已存在监控则先停止
    if (this.watchers.has(path)) {
      this.unwatch(path);
    }
    try {
      const watcher = watch(path, (event, filename) => {
        callback(event, filename ?? '');
      });
      watcher.on('error', (err) => {
        this.logger.warn('File watcher error', {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.watchers.set(path, watcher);
      this.logger.info('File watcher started', { path });
    } catch (err) {
      this.logger.warn('Failed to start file watcher', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** 停止监控指定路径 */
  unwatch(path: string): void {
    const watcher = this.watchers.get(path);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // 忽略关闭错误
    }
    this.watchers.delete(path);
    this.logger.info('File watcher stopped', { path });
  }

  onModuleDestroy(): void {
    for (const [path, watcher] of this.watchers) {
      try {
        watcher.close();
      } catch {
        // 忽略
      }
      this.watchers.delete(path);
    }
  }
}
