import { readJsonRecover, writeJsonAtomic, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { getSessionProjectDir, setSessionProjectDir, removeSessionProjectDir } from '../core/config/session-project.store.js';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, constants } from 'node:fs';

import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import type { ChatMessage, SessionInfo, SessionStoreItem } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { ISessionService } from '../ai/types.js';

/**
 * SessionService - 会话管理服务
 *
 * 实现 AI 域定义的 ISessionService 接口（最小子集），并扩展完整的会话生命周期管理：
 *   - 内存缓存 Map<sessionId, SessionStoreItem>
 *   - 持久化到 sessions.json（位于数据目录）
 *   - 原始消息完整保留；模型压缩结果单独保存
 *   - 会话元数据更新（title/model/agent/pinned）
 *
 * 通过 SessionModule 以 SESSION_SERVICE token 提供，供 ChatService 等注入。
 */
@Injectable()
export class SessionService implements ISessionService, OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, SessionStoreItem>();
  private sessionsPath = '';
  private recoveryNotice: { recoveredAt: number; archiveDirectory: string } | null = null;
  /** 防抖写盘定时器：P0 修复——此前每条消息同步 writeFileSync 全量 sessions.json，
   * 一次 AgentLoop run 落库 3~10+ 次，含 base64 附件时单次几十 MB，
   * 事件循环被反复冻结（WS 推送/HTTP 全部卡死，UI"打嗝"的直接根因）。
   * 改为 500ms 防抖合并 + 异步写盘，退出时 flush 兜底 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 进行中的异步写盘 Promise（退出 flush 时等待完成） */
  private persistPromise: Promise<void> = Promise.resolve();
  private persistenceError: Error | undefined;

  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.sessionsPath = this.resolveDataFilePath('sessions.json');
    try {
      this.recoveryNotice = readJsonRecover(join(dirname(this.sessionsPath), 'session-recovery.json'), null);
    } catch { /* A damaged notification must not prevent application startup. */ }
    this.load();
  }

  getRecoveryNotice(): { recoveredAt: number; archiveDirectory: string } | null {
    return this.recoveryNotice;
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  /** Await durable ordered persistence before shutdown or task checkpoints. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
    await this.persistPromise;
    if (this.persistenceError) throw this.persistenceError;
  }

  /** 创建新会话 */
  createSession(title?: string): SessionInfo {
    const now = Date.now();
    const id = randomUUID();
    const item: SessionStoreItem = {
      id,
      title: title?.trim() || 'New chat',
      titleCustomized: !!title?.trim(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, item);
    this.persist();
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
      removeSessionProjectDir(id);
      this.persist();
      this.logger.info('Session deleted', { sessionId: id });
    }
  }

  /** 批量删除全部会话（可保留指定 id 集合），返回删除数量 */
  deleteAllSessions(keepIds: string[] = []): number {
    const keep = new Set(keepIds);
    let deleted = 0;
    for (const id of Array.from(this.sessions.keys())) {
      if (keep.has(id)) continue;
      if (this.sessions.delete(id)) deleted++;
    }
    if (deleted > 0) {
      this.persist();
      this.logger.info('Sessions cleared', { deleted, kept: keepIds });
    }
    return deleted;
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

  /** 添加消息并保留完整历史；模型上下文压缩不应删除持久化记录。 */
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
    if (message.role === 'user' && !session.messages.some(m => m.role === 'user') &&
        !session.titleCustomized && (session.title === 'New chat' || session.title.startsWith('Session '))) {
      const text = typeof message.content === 'string' ? message.content.replace(/\s+/g, ' ').trim() : '';
      if (text) session.title = Array.from(text).slice(0, 40).join('') + (Array.from(text).length > 40 ? '…' : '');
    }
    session.messages.push(message);
    session.updatedAt = Date.now();
    this.persist();
  }

  /** Read the model checkpoint plus messages appended after it. */
  getContextMessages(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const checkpoint = session.contextCheckpoint;
    if (!checkpoint || checkpoint.sourceCount < 1 ||
        session.messages[checkpoint.sourceCount - 1]?.id !== checkpoint.lastMessageId) {
      return [...session.messages];
    }
    return [...checkpoint.messages, ...session.messages.slice(checkpoint.sourceCount)];
  }

  /** Compare-and-set: a summary generated asynchronously must not replace newer context. */
  setContextMessages(sessionId: string, expectedHistory: ChatMessage[], messages: ChatMessage[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !expectedHistory.length ||
        JSON.stringify(session.messages) !== JSON.stringify(expectedHistory)) return false;
    session.contextCheckpoint = {
      sourceCount: expectedHistory.length,
      lastMessageId: expectedHistory[expectedHistory.length - 1]!.id,
      messages: structuredClone(messages),
    };
    this.persist();
    return true;
  }

  /** Replace history for editing/restoring a conversation, invalidating its old checkpoint. */
  replaceMessages(sessionId: string, messages: ChatMessage[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.messages = Array.isArray(messages) ? [...messages] : [];
    delete session.contextCheckpoint;
    session.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /** 更新会话元数据 */
  updateSessionMeta(
    id: string,
    meta: Partial<Pick<SessionStoreItem, 'title' | 'model' | 'agent' | 'pinned' | 'archived'>>,
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (meta.title !== undefined && meta.title.trim()) {
      session.title = meta.title.trim().slice(0, 120);
      session.titleCustomized = true;
    }
    if (meta.model !== undefined) session.model = meta.model;
    if (meta.agent !== undefined) session.agent = meta.agent;
    if (meta.pinned !== undefined) session.pinned = meta.pinned;
    if (meta.archived !== undefined) session.archived = meta.archived;
    session.updatedAt = Date.now();
    this.persist();
  }

  private toInfo(item: SessionStoreItem): SessionInfo {
    const info: SessionInfo = {
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messages.length,
      projectDir: getSessionProjectDir(item.id),
      titleCustomized: item.titleCustomized === true,
    };
    if (item.model !== undefined) info.model = item.model;
    if (item.agent !== undefined) info.agent = item.agent;
    if (item.pinned !== undefined) info.pinned = item.pinned;
    if (item.archived !== undefined) info.archived = item.archived;
    return info;
  }

  /**
   * Fork 会话：复制 timestamp <= uptoTs 的消息到新会话（从某条消息处分叉出独立分支）。
   * 新会话标题默认 "<原标题> (Fork)"。原会话不受影响。
   */
  forkSession(sessionId: string, uptoTs: number, title?: string): SessionInfo | null {
    const source = this.sessions.get(sessionId);
    if (!source) return null;
    const copied = source.messages.filter((m) => (m.timestamp ?? 0) <= uptoTs);
    const now = Date.now();
    const fork: SessionStoreItem = {
      id: randomUUID(),
      title: title && title.length > 0 ? title : `${source.title} (Fork)`,
      messages: copied.map((m) => ({ ...m })),
      createdAt: now,
      updatedAt: now,
      ...(source.model !== undefined ? { model: source.model } : {}),
      ...(source.agent !== undefined ? { agent: source.agent } : {}),
    };
    this.sessions.set(fork.id, fork);
    const project = getSessionProjectDir(sessionId);
    if (project) setSessionProjectDir(fork.id, project);
    this.persist();
    this.logger.info('Session forked', { sessionId, forkId: fork.id, messages: copied.length });
    return this.toInfo(fork);
  }

  /**
   * 会话搜索：标题命中（优先）+ 消息内容命中（带摘要片段），最多返回 limit 条。
   * 用于侧栏搜索框（标题即时匹配 + 内容防抖搜索）。
   */
  searchSessions(
    query: string,
    limit = 20,
  ): Array<{
    sessionId: string;
    title: string;
    updatedAt: number;
    messageCount: number;
    /** 命中来源：title=标题命中；content=消息内容命中 */
    match: 'title' | 'content';
    /** 内容命中时的消息片段（高亮关键词前带上下文） */
    snippet?: string;
  }> {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const results: Array<{
      sessionId: string;
      title: string;
      updatedAt: number;
      messageCount: number;
      match: 'title' | 'content';
      snippet?: string;
    }> = [];
    for (const item of this.sessions.values()) {
      if (item.id.startsWith('bg-task-')) continue;
      const titleHit = item.title.toLowerCase().includes(q);
      let snippet: string | undefined;
      if (!titleHit) {
        for (let i = item.messages.length - 1; i >= 0; i--) {
          const c = typeof item.messages[i]?.content === 'string' ? item.messages[i]!.content : '';
          const idx = c.toLowerCase().indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(c.length, idx + q.length + 80);
            snippet = `${start > 0 ? '…' : ''}${c.slice(start, end)}${end < c.length ? '…' : ''}`;
            break;
          }
        }
      }
      if (titleHit || snippet) {
        results.push({
          sessionId: item.id,
          title: item.title,
          updatedAt: item.updatedAt,
          messageCount: item.messages.length,
          match: titleHit ? 'title' : 'content',
          ...(snippet !== undefined ? { snippet } : {}),
        });
      }
      if (results.length >= limit) break;
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  /** 防抖持久化：500ms 内多次写盘合并为一次，异步执行不阻塞事件循环 */
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
    // 防抖定时器不阻止进程退出（退出由 onModuleDestroy flush 兜底）
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  /** 立即持久化（异步写盘；同步序列化在 JSON.stringify，数据量大时仍有一定开销，
   *  但相比同步 writeFileSync 冻结事件循环已大幅缓解） */
  private persistNow(): void {
    const dir = dirname(this.sessionsPath);
    const data: Record<string, SessionStoreItem> = {};
    for (const [k, v] of this.sessions) {
      data[k] = v;
    }
    let json: string;
    try {
      json = JSON.stringify(data, null, 2);
    } catch (err) {
      this.logger.warn('Failed to serialize sessions', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const run = async (): Promise<void> => {
      try {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        await writeJsonAtomic(this.sessionsPath, JSON.parse(json));
        this.persistenceError = undefined;
      } catch (err) {
        this.persistenceError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn('Failed to persist sessions', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    this.persistPromise = this.persistPromise.then(run, run);
  }

  private load(): void {
    try {
      const parsed = readJsonRecover(this.sessionsPath, {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid session store format');
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
      // Retain exact original bytes before opening a fresh store. A broken
      // conversation file must not take down login, settings, and every tool.
      // If preservation fails, propagate the error instead of overwriting data.
      const archiveDirectory = join(dirname(this.sessionsPath), 'recovery', `sessions-${Date.now()}-${randomUUID()}`);
      mkdirSync(archiveDirectory, { recursive: true });
      for (const suffix of ['', '.bak']) {
        const source = this.sessionsPath + suffix;
        if (existsSync(source)) copyFileSync(source, join(archiveDirectory, 'sessions.json' + suffix), constants.COPYFILE_EXCL);
      }
      const notice = { recoveredAt: Date.now(), archiveDirectory };
      writeJsonAtomicSync(join(dirname(this.sessionsPath), 'session-recovery.json'), notice);
      writeJsonAtomicSync(this.sessionsPath, {});
      this.recoveryNotice = notice;
      this.sessions.clear();
      this.logger.warn('Unreadable session files preserved; started a new session store', notice);
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
