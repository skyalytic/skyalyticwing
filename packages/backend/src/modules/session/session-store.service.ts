import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import type { ChatMessage, SessionInfo, SessionStoreItem } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';

/**
 * SessionStoreService - 会话存储服务
 *
 * 聚焦于会话消息的存储与持久化，对应 start.cjs 中的 `sessionsStore` 全局对象。
 *
 * 职责：
 *   - 内存缓存 `Map<sessionId, SessionStoreItem>`
 *   - 持久化到 `sessions.json`（位于数据目录）
 *   - 完整保留会话消息，模型上下文窗口独立管理
 *   - 会话创建/删除/列表
 *   - 写入锁：通过 Promise 队列串行化所有持久化操作，避免并发写入导致 JSON 文件损坏
 *
 * 与 SessionService 的区别：本服务专注于存储层与并发安全，
 * 不实现 AI 域 ISessionService 接口，也不负责会话元数据更新。
 */
@Injectable()
export class SessionStoreService implements OnModuleInit {
  private readonly sessions = new Map<string, SessionStoreItem>();
  private sessionsPath = '';
  /** 写入锁：串行化所有持久化操作，避免并发写入相互覆盖 */
  private writeLock: Promise<void> = Promise.resolve();
  private persistQueued = false;

  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.sessionsPath = this.resolveDataFilePath('sessions.json');
    this.load();
  }

  /** 创建新会话 */
  createSession(title?: string): SessionInfo {
    const now = Date.now();
    const id = randomUUID();
    const item: SessionStoreItem = {
      id,
      title: title && title.length > 0 ? title : `Session ${new Date(now).toLocaleString()}`,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, item);
    void this.persist();
    this.logger.info('Session created', { sessionId: id });
    return this.toInfo(item);
  }

  /** 获取会话存储项 */
  getSession(id: string): SessionStoreItem | undefined {
    return this.sessions.get(id);
  }

  /** 列出所有会话（按更新时间倒序） */
  listSessions(): SessionInfo[] {
    const items = Array.from(this.sessions.values());
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items.map((i) => this.toInfo(i));
  }

  /** 删除会话 */
  deleteSession(id: string): void {
    if (this.sessions.delete(id)) {
      void this.persist();
      this.logger.info('Session deleted', { sessionId: id });
    }
  }

  /** 获取会话消息（支持 limit 从最新开始截取） */
  getMessages(sessionId: string, limit?: number): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const msgs = session.messages;
    if (limit !== undefined && limit > 0) {
      const start = Math.max(0, msgs.length - limit);
      return msgs.slice(start);
    }
    return [...msgs];
  }

  /** 添加消息，保留完整历史；会话不存在则自动创建。 */
  addMessage(sessionId: string, message: ChatMessage): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = Date.now();
      session = {
        id: sessionId,
        title: `Session ${new Date(now).toLocaleString()}`,
        messages: [],
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(sessionId, session);
    }
    session.messages.push(message);
    session.updatedAt = Date.now();
    void this.persist();
  }

  private toInfo(item: SessionStoreItem): SessionInfo {
    const info: SessionInfo = {
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messages.length,
    };
    if (item.model !== undefined) info.model = item.model;
    if (item.agent !== undefined) info.agent = item.agent;
    return info;
  }

  /**
   * 持久化到磁盘。
   *
   * 通过 writeLock Promise 链串行化写入：每次调用都接在上一次写入之后执行，
   * 避免并发 addMessage/createSession/deleteSession 导致的 JSON 文件损坏。
   * 写入本身使用同步 writeFileSync，确保单次写入原子可见。
   */
  private persist(): Promise<void> {
    if (this.persistQueued) return this.writeLock;
    this.persistQueued = true;
    const run = (): void => {
      try {
        const dir = dirname(this.sessionsPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        const data: Record<string, SessionStoreItem> = {};
        for (const [k, v] of this.sessions) {
          data[k] = v;
        }
        writeJsonAtomicSync(this.sessionsPath, data);
      } catch (err) {
        this.logger.warn('Failed to persist sessions', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.persistQueued = false;
      }
    };
    // 写入锁：将本次写入接在上一次写入之后，串行化所有持久化操作
    this.writeLock = this.writeLock.then(run, run);
    return this.writeLock;
  }

  private load(): void {
    try {
      const parsed = readJsonRecover(this.sessionsPath, {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      this.sessions.clear();
      for (const [k, v] of Object.entries(parsed as Record<string, SessionStoreItem>)) {
        if (v && typeof v === 'object' && Array.isArray(v.messages)) {
          this.sessions.set(k, v);
        }
      }
    } catch (err) {
      this.logger.warn('Failed to load sessions', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveDataFilePath(filename: string): string {
    const dir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // 忽略，后续 persist 会再次尝试
      }
    }
    return join(dir, filename);
  }

  private getDefaultDataDir(): string {
    const plat = platform();
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
