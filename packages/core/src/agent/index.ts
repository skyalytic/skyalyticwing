import type { AgentConfig, AppConfig } from '../types/index.js';
import { createLogger, type Logger, generateId } from '@skyalyticwing/shared';

export interface AgentRunOptions {
  message: string;
  agentId?: string;
  sessionId?: string;
  channel?: string;
  tools?: string[];
}

export interface AgentRunResult {
  response: string;
  sessionId: string;
  toolCalls?: ToolCallResult[];
}

export interface ToolCallResult {
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
}

export class AgentEngine {
  private config: AppConfig;
  private logger: Logger;
  private sessions: Map<string, AgentSession> = new Map();

  // Map 最大条目限制，超过时淘汰最旧条目，避免无界增长导致内存泄漏。
  private static readonly MAX_SESSIONS = 10000;

  constructor(config: AppConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? createLogger({ name: 'agent' });
  }

  resolveAgent(agentId?: string): AgentConfig {
    const id = agentId ?? 'default';
    const agents = this.config.agents as Record<string, AgentConfig>;
    if (agents[id]) return { ...agents[id], id, name: agents[id].name ?? id };
    // Only fallback to default when no specific agentId was requested
    // TS-11 fix: 使用索引签名访问 'default' 键，满足 noPropertyAccessFromIndexSignature
    if (!agentId && agents['default']) return { ...agents['default'], id: 'default', name: agents['default'].name ?? 'default' };
    throw new Error(`Agent not found: ${id}`);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const agent = this.resolveAgent(options.agentId);
    const sessionId = options.sessionId ?? generateId();

    this.logger.info({ agent: agent.id, session: sessionId }, 'Agent run started');

    // TS-7 fix: 抛出未实现错误而非静默返回空响应
    throw new Error('AgentEngine.run not implemented yet');
  }

  createSession(agentId?: string): string {
    const id = generateId();
    const agent = this.resolveAgent(agentId);
    this.sessions.set(id, {
      id,
      agentId: agent.id,
      createdAt: new Date().toISOString(),
      messages: [],
    });
    // 超过上限时淘汰最旧 session（Map 按插入顺序迭代）
    if (this.sessions.size > AgentEngine.MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) this.sessions.delete(oldestKey);
    }
    return id;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}

interface AgentSession {
  id: string;
  agentId: string;
  createdAt: string;
  messages: Array<{ role: string; content: string; timestamp: string }>;
}
