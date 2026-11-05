import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { ChatMessage } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { SessionService } from './session.service.js';

/**
 * SessionSnapshotService - 会话快照服务
 *
 * 移植自 start.cjs 的 SessionRestore（行 13789-13882）：
 *   - saveSession：将完整会话消息保存为 <dataDir>/snapshots/<sessionId>.json
 *   - restoreSession：从快照文件恢复会话消息
 *   - listSnapshots：列出全部快照（按保存时间倒序）
 */

/** 快照文件结构（与旧版对齐） */
interface SessionSnapshot {
  id: string;
  messages: ChatMessage[];
  agentId: string;
  model: string;
  createdAt: number;
  savedAt: number;
  title: string;
}

/** 快照列表条目 */
export interface SnapshotListItem {
  id: string;
  title: string;
  savedAt: number;
  messageCount: number;
}

@Injectable()
export class SessionSnapshotService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly logger: LoggerService,
  ) {}

  /** 保存完整会话快照。 */
  saveSession(sessionId: string): boolean {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return false;
    const snapshot: SessionSnapshot = {
      id: sessionId,
      messages: [...(session.messages || [])],
      agentId: session.agent || 'default',
      model: session.model || '',
      createdAt: session.createdAt || Date.now(),
      savedAt: Date.now(),
      title:
        session.messages && session.messages[0]
          ? String(session.messages[0].content || '').substring(0, 60)
          : 'untitled',
    };
    try {
      const snapDir = this.getSnapshotsDir();
      if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, `${sessionId}.json`), JSON.stringify(snapshot), 'utf-8');
      this.logger.info('Session snapshot saved', { sessionId });
      return true;
    } catch (err) {
      this.logger.warn('Failed to save session snapshot', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** 从快照恢复会话（快照不存在返回 null） */
  restoreSession(sessionId: string): SessionSnapshot | null {
    const snapFile = join(this.getSnapshotsDir(), `${sessionId}.json`);
    if (!existsSync(snapFile)) return null;
    try {
      const snapshot = JSON.parse(readFileSync(snapFile, 'utf-8')) as SessionSnapshot;
      const messages = snapshot.messages || [];
      if (this.sessionService.getSession(sessionId)) {
        this.sessionService.replaceMessages(sessionId, messages);
      } else {
        // addMessage 对不存在的会话自动按原 id 建会话
        for (const m of messages) this.sessionService.addMessage(sessionId, m);
      }
      this.sessionService.updateSessionMeta(sessionId, {
        ...(snapshot.model ? { model: snapshot.model } : {}),
        ...(snapshot.agentId && snapshot.agentId !== 'default' ? { agent: snapshot.agentId } : {}),
      });
      this.logger.info('Session restored from snapshot', {
        sessionId,
        messageCount: messages.length,
      });
      return snapshot;
    } catch (err) {
      this.logger.warn('Restore failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** 列出全部快照（按 savedAt 倒序，解析失败的文件跳过） */
  listSnapshots(): SnapshotListItem[] {
    const snapDir = this.getSnapshotsDir();
    if (!existsSync(snapDir)) return [];
    const items: SnapshotListItem[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(snapDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    for (const f of files) {
      try {
        const d = JSON.parse(readFileSync(join(snapDir, f), 'utf-8')) as SessionSnapshot;
        items.push({
          id: d.id,
          title: d.title || 'untitled',
          savedAt: d.savedAt || 0,
          messageCount: (d.messages || []).length,
        });
      } catch {
        // 单文件损坏跳过
      }
    }
    return items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }

  private getSnapshotsDir(): string {
    return join(this.getDataDir(), 'snapshots');
  }

  private getDataDir(): string {
    return process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
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
