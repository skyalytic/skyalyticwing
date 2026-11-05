import { createLogger, type Logger, generateId } from '@skyalyticwing/shared';

export interface ACPSession {
  id: string;
  agentId: string;
  status: 'active' | 'paused' | 'completed';
  createdAt: string;
}

export class ACPManager {
  private logger: Logger;
  private sessions: Map<string, ACPSession> = new Map();

  // Map 最大条目限制，超过时淘汰最旧条目，避免无界增长导致内存泄漏。
  private static readonly MAX_SESSIONS = 10000;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'acp' });
  }

  createSession(agentId: string): ACPSession {
    const session: ACPSession = {
      id: generateId(),
      agentId,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    // TS-11 fix: 使用 logger 消除未使用警告
    this.logger.debug({ sessionId: session.id, agentId }, 'ACP session created');
    // 超过上限时淘汰最旧 session（Map 按插入顺序迭代）
    if (this.sessions.size > ACPManager.MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) this.sessions.delete(oldestKey);
    }
    return session;
  }

  getSession(id: string): ACPSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): ACPSession[] {
    return Array.from(this.sessions.values());
  }

  pauseSession(id: string): ACPSession | undefined {
    const session = this.sessions.get(id);
    if (session && session.status === 'active') {
      session.status = 'paused';
    }
    return session;
  }

  resumeSession(id: string): ACPSession | undefined {
    const session = this.sessions.get(id);
    if (session && session.status === 'paused') {
      session.status = 'active';
    }
    return session;
  }

  completeSession(id: string): ACPSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.status = 'completed';
    }
    return session;
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }
}
