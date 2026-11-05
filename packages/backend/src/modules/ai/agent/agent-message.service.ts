import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { WebSocketService } from '../../core/websocket/websocket.service.js';
import { resolveWebDataDir } from '../../core/utils/web-data.util.js';

/**
 * AgentMessageService - Agent 消息互通服务
 *
 * 移植自 start.cjs AgentMessenger（/agents/message、/agents/inbox、
 * /agents/conversation、/agents/markread）及 /agents/:id/workspace 文件操作。
 *
 * 核心能力：
 *   - 代理间消息路由（send）
 *   - 收件箱（inbox）：Map<agentId, Message[]>，最多保留 500 条
 *   - 未读查询 / 标记已读
 *   - 对话历史（双向合并，按时间排序，最近 100 条）
 *   - Agent 工作区文件操作（read/write/delete，路径白名单校验）
 *
 * 安全：
 *   - 工作区根目录在启动时加入 SecurityManager 允许路径
 *   - 每次 FS 操作前调用 isPathAllowed 校验
 *   - 文件路径必须位于 ${workspaceRoot}/${agentId}/ 之下
 */

/** 单代理 mailbox 最大保留条数 */
const MAILBOX_MAX = 500;
/** mailbox 裁剪目标条数 */
const MAILBOX_TRIM_TO = 400;
/** inbox 默认返回最近条数 */
const INBOX_DEFAULT_LIMIT = 50;
/** 对话历史最大返回条数 */
const CONVERSATION_LIMIT = 100;

/** Agent 间消息 */
export interface AgentMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  content: string;
  type: string;
  timestamp: number;
  read: boolean;
  /** 回复所针对的原消息 ID */
  inReplyTo?: string;
}

/** 发送消息结果 */
export interface SendResult {
  success: boolean;
  msgId?: string;
  delivered?: boolean;
  error?: string;
}

/** 标记已读结果 */
export interface MarkReadResult {
  success: boolean;
  marked: number;
}

/** 工作区文件写入 DTO */
export interface WorkspaceWriteDto {
  path: string;
  content: string;
}

@Injectable()
export class AgentMessageService implements OnModuleInit {
  /** 代理 mailbox：agentId -> 消息列表 */
  private readonly mailbox = new Map<string, AgentMessage[]>();
  /** 工作区根目录 */
  private readonly workspaceRoot: string;

  constructor(
    private readonly logger: LoggerService,
    private readonly ws: WebSocketService,
    private readonly security: SecurityManagerService,
  ) {
    this.workspaceRoot = this.resolveWorkspaceRoot();
  }

  onModuleInit(): void {
    try {
      if (!existsSync(this.workspaceRoot)) {
        mkdirSync(this.workspaceRoot, { recursive: true });
      }
      this.security.addAllowedPath(this.workspaceRoot, 'readwrite');
    } catch (err) {
      this.logger.warn('AgentMessageService: failed to init workspace root', {
        root: this.workspaceRoot,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.loadLegacyMailbox();
  }

  /**
   * 启动时从旧版 agent-mailbox.json（用户数据目录优先，回退 packages/web/data）
   * 恢复代理信箱。幂等：内存中已有的 agentId 不覆盖。
   */
  private loadLegacyMailbox(): void {
    const dataDir =
      process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    const candidates = [
      join(dataDir, 'agent-mailbox.json'),
      join(resolveWebDataDir(), 'agent-mailbox.json'),
    ];
    let raw: unknown = null;
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        raw = JSON.parse(readFileSync(p, 'utf-8'));
        break;
      } catch {
        // 解析失败尝试下一个候选
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

    let restored = 0;
    for (const [agentId, msgs] of Object.entries(raw as Record<string, unknown>)) {
      if (this.mailbox.has(agentId)) continue;
      if (!Array.isArray(msgs)) continue;
      const valid = msgs.filter(
        (m): m is AgentMessage =>
          !!m && typeof m === 'object' && typeof (m as AgentMessage).content === 'string',
      );
      if (valid.length === 0) continue;
      this.mailbox.set(agentId, valid.slice(-MAILBOX_MAX));
      restored += valid.length;
    }
    if (restored > 0) {
      this.logger.info('agent-message: restored legacy mailbox', { restored });
    }
  }

  /**
   * 发送消息：fromAgentId -> toAgentId
   * - 禁止向自己发送
   * - 写入接收方 mailbox（超 500 条裁剪到 400）
   * - 通过 WebSocket 广播 agent_message 事件
   */
  send(
    fromAgentId: string,
    toAgentId: string,
    message: string,
    msgType = 'text',
  ): SendResult {
    if (!fromAgentId || !toAgentId) {
      return { success: false, error: 'from 和 to 必填' };
    }
    if (fromAgentId === toAgentId) {
      return { success: false, error: '不能向自己发送消息' };
    }
    if (!message || typeof message !== 'string') {
      return { success: false, error: 'message 必填' };
    }

    const msg: AgentMessage = {
      id: `msg-${Date.now()}-${randomBytes(3).toString('hex').slice(0, 6)}`,
      from: fromAgentId,
      fromName: fromAgentId,
      to: toAgentId,
      toName: toAgentId,
      content: message,
      type: msgType,
      timestamp: Date.now(),
      read: false,
    };

    let inbox = this.mailbox.get(toAgentId);
    if (!inbox) {
      inbox = [];
      this.mailbox.set(toAgentId, inbox);
    }
    inbox.push(msg);
    if (inbox.length > MAILBOX_MAX) {
      this.mailbox.set(toAgentId, inbox.slice(-MAILBOX_TRIM_TO));
    }

    this.ws.broadcast({
      type: 'agent_message',
      data: {
        from: fromAgentId,
        fromName: msg.fromName,
        to: toAgentId,
        toName: msg.toName,
        content: message,
        msgId: msg.id,
        timestamp: msg.timestamp,
      },
    });

    this.logger.info('agent-message: sent', {
      from: fromAgentId,
      to: toAgentId,
      preview: message.substring(0, 80),
    });
    return { success: true, msgId: msg.id, delivered: true };
  }

  /** 获取收件箱（最近 INBOX_DEFAULT_LIMIT 条） */
  getInbox(agentId: string): { agentId: string; messages: AgentMessage[]; unreadCount: number } {
    const all = this.mailbox.get(agentId) || [];
    return {
      agentId,
      messages: all.slice(-INBOX_DEFAULT_LIMIT),
      unreadCount: all.filter((m) => !m.read).length,
    };
  }

  /** 获取未读消息 */
  getUnread(agentId: string): AgentMessage[] {
    return (this.mailbox.get(agentId) || []).filter((m) => !m.read);
  }

  /**
   * 标记已读
   * - 指定 msgId：仅标记该消息
   * - 未指定 msgId：标记全部未读为已读
   */
  markRead(agentId: string, msgId?: string): MarkReadResult {
    const msgs = this.mailbox.get(agentId) || [];
    let marked = 0;
    for (const m of msgs) {
      if (msgId) {
        if (m.id === msgId && !m.read) {
          m.read = true;
          marked++;
        }
      } else if (!m.read) {
        m.read = true;
        marked++;
      }
    }
    return { success: true, marked };
  }

  /**
   * 获取两个代理之间的会话历史
   * - 合并双向 mailbox 中相关消息
   * - 按时间排序，返回最近 CONVERSATION_LIMIT 条
   */
  getConversation(agentId1: string, agentId2: string): { agent1: string; agent2: string; messages: AgentMessage[] } {
    const msgs1 = this.mailbox.get(agentId1) || [];
    const msgs2 = this.mailbox.get(agentId2) || [];
    const all: AgentMessage[] = [];
    for (const m of msgs1) {
      if (m.from === agentId2 || m.to === agentId2) all.push(m);
    }
    for (const m of msgs2) {
      if (m.from === agentId1 || m.to === agentId1) all.push(m);
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    return { agent1: agentId1, agent2: agentId2, messages: all.slice(-CONVERSATION_LIMIT) };
  }

  // ─── Agent 工作区文件操作 ──────────────────────────────────

  /** 读取 Agent 工作区文件 */
  readWorkspaceFile(agentId: string, relPath: string): { content: string; path: string } {
    const fullPath = this.resolveWorkspacePath(agentId, relPath);
    this.assertWorkspacePath(agentId, fullPath, 'read');
    if (!existsSync(fullPath)) {
      throw new Error(`文件不存在: ${relPath}`);
    }
    const content = readFileSync(fullPath, 'utf8');
    return { content, path: fullPath };
  }

  /** 写入 Agent 工作区文件 */
  writeWorkspaceFile(agentId: string, relPath: string, content: string): { path: string; bytes: number } {
    const fullPath = this.resolveWorkspacePath(agentId, relPath);
    this.assertWorkspacePath(agentId, fullPath, 'write');
    const dir = fullPath.substring(0, fullPath.lastIndexOf(sep));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content || '', 'utf8');
    this.logger.info('agent-message: workspace file written', { agentId, path: relPath });
    return { path: fullPath, bytes: Buffer.byteLength(content || '', 'utf8') };
  }

  /** 删除 Agent 工作区文件 */
  deleteWorkspaceFile(agentId: string, relPath: string): { deleted: boolean; path: string } {
    const fullPath = this.resolveWorkspacePath(agentId, relPath);
    this.assertWorkspacePath(agentId, fullPath, 'write');
    if (!existsSync(fullPath)) {
      return { deleted: false, path: fullPath };
    }
    rmSync(fullPath, { force: true });
    this.logger.info('agent-message: workspace file deleted', { agentId, path: relPath });
    return { deleted: true, path: fullPath };
  }

  // ─── 内部工具 ──────────────────────────────────────────────

  /** 解析工作区文件路径（绝对路径） */
  private resolveWorkspacePath(agentId: string, relPath: string): string {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId required');
    }
    if (!relPath || typeof relPath !== 'string') {
      throw new Error('path required');
    }
    // 禁止路径穿越
    if (relPath.indexOf('..') >= 0) {
      throw new Error('路径不允许包含 ".."');
    }
    const agentDir = resolvePath(this.workspaceRoot, agentId);
    return resolvePath(agentDir, relPath);
  }

  /** 校验路径位于 agent 工作区目录之下且通过白名单 */
  private assertWorkspacePath(agentId: string, fullPath: string, mode: 'read' | 'write'): void {
    const agentDir = resolvePath(this.workspaceRoot, agentId);
    const base = agentDir.endsWith(sep) ? agentDir : agentDir + sep;
    if (fullPath !== agentDir && fullPath.indexOf(base) !== 0) {
      throw new Error('路径不允许超出 Agent 工作区目录');
    }
    if (!this.security.isPathAllowed(fullPath, mode === 'write' ? 'write' : 'read')) {
      throw new Error('路径未在白名单内：' + fullPath);
    }
  }

  /** 解析工作区根目录：${dataDir}/workspaces */
  private resolveWorkspaceRoot(): string {
    const dataDir =
      process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    return join(dataDir, 'workspaces');
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
