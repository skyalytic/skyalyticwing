import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import type { SessionRestorePoint, SessionStoreItem } from '@skyalyticwing/shared';
import { LoggerService } from '../core/logger/logger.service.js';
import { WebSocketService } from '../core/websocket/websocket.service.js';
import { SessionService } from './session.service.js';

/** 活跃会话恢复点检查间隔（5 分钟） */
const RESTORE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * SessionRestoreService - 会话恢复服务
 *
 * 职责：
 *   - createRestorePoint：为指定会话创建恢复点（含消息计数与内容校验和）
 *   - restore：恢复会话，并通过 WebSocket 广播 session_restored 事件
 *   - 定期（每 5 分钟）为所有活跃会话创建恢复点
 *   - 持久化恢复点到 session-restore.json
 */
@Injectable()
export class SessionRestoreService implements OnModuleInit, OnModuleDestroy {
  /** sessionId → 最新恢复点 */
  private readonly restorePoints = new Map<string, SessionRestorePoint>();
  private restorePath = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionService: SessionService,
    private readonly ws: WebSocketService,
    private readonly logger: LoggerService,
  ) {}

  onModuleInit(): void {
    this.restorePath = this.resolveDataFilePath('session-restore.json');
    this.load();
    this.timer = setInterval(() => this.checkActiveSessions(), RESTORE_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 创建恢复点 */
  createRestorePoint(sessionId: string): SessionRestorePoint {
    const session = this.sessionService.getSession(sessionId);
    const now = Date.now();
    const point: SessionRestorePoint = session
      ? {
          sessionId,
          timestamp: now,
          messageCount: session.messages.length,
          checksum: this.computeChecksum(session),
        }
      : {
          sessionId,
          timestamp: now,
          messageCount: 0,
          checksum: '',
        };
    this.restorePoints.set(sessionId, point);
    this.persist();
    this.logger.debug('Restore point created', {
      sessionId,
      messageCount: point.messageCount,
    });
    return point;
  }

  /** 恢复会话（返回当前会话存储项并广播恢复事件） */
  restore(sessionId: string): SessionStoreItem | null {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return null;
    this.ws.broadcast({
      type: 'session_restored',
      data: { sessionId, messageCount: session.messages.length },
    });
    this.logger.info('Session restored', { sessionId, messageCount: session.messages.length });
    return session;
  }

  /** 定期为所有活跃会话创建恢复点 */
  private checkActiveSessions(): void {
    try {
      const sessions = this.sessionService.listSessions();
      for (const info of sessions) {
        this.createRestorePoint(info.id);
      }
    } catch (err) {
      this.logger.warn('Failed to check active sessions for restore points', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 基于消息内容计算简单 sha256 校验和（取前 16 位） */
  private computeChecksum(session: SessionStoreItem): string {
    const content = session.messages
      .map((m) => `${m.id}:${m.role}:${m.content}`)
      .join('|');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private persist(): void {
    try {
      const dir = dirname(this.restorePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, SessionRestorePoint> = {};
      for (const [k, v] of this.restorePoints) {
        data[k] = v;
      }
      writeFileSync(this.restorePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn('Failed to persist restore points', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.restorePath)) return;
      const content = readFileSync(this.restorePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      this.restorePoints.clear();
      for (const [k, v] of Object.entries(parsed as Record<string, SessionRestorePoint>)) {
        if (v && typeof v === 'object' && typeof v.sessionId === 'string') {
          this.restorePoints.set(k, v);
        }
      }
    } catch (err) {
      this.logger.warn('Failed to load restore points', {
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
        // 忽略
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
