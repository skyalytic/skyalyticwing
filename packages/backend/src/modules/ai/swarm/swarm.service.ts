import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { loadJsonFile, resolveWebDataDir, saveJsonFile } from '../../core/utils/web-data.util.js';
import type { CreateSwarmDto } from './dto/swarm.dto.js';

/**
 * SwarmService - 蜂群（多代理协作编排）系统
 *
 * 移植自 start.cjs SwarmSystem（团队编排 / 定向消息 / 广播 / 状态查询）。
 * 团队数据持久化到 packages/web/data/subagents.json 的 `swarmTeams` 键下，
 * 与现有子代理存储共存（保留其余键不动）。
 */

/** 蜂群成员 */
export interface SwarmMember {
  id: string;
  agentId: string;
  role: string;
  status: 'idle' | 'notified' | 'busy';
}

/** 共享上下文条目 */
export interface SharedContextEntry {
  role: string;
  content: string;
  _ts: number;
}

/** 消息日志条目 */
export interface MessageLogEntry {
  from: string;
  message: string;
  ts: number;
}

/** 蜂群团队 */
export interface SwarmTeam {
  id: string;
  name: string;
  mode: string;
  members: SwarmMember[];
  leaderId: string | null;
  createdAt: number;
  status: 'active' | 'paused' | 'stopped';
  sharedContext: SharedContextEntry[];
  messageLog: MessageLogEntry[];
}

/** subagents.json 根结构（宽松类型，保留未知键） */
interface SubagentsStore {
  [key: string]: unknown;
}

/** 消息日志 / 共享上下文容量上限（对齐旧版） */
const MAX_MESSAGE_LOG = 200;
const MAX_SHARED_CONTEXT = 50;

@Injectable()
export class SwarmService implements OnModuleInit {
  private readonly storePath = join(resolveWebDataDir(), 'subagents.json');
  private teams: Record<string, SwarmTeam> = {};
  private teamSeq = 0;

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  onModuleInit(): void {
    if (!this.security.isPathAllowed(this.storePath, 'readwrite')) {
      this.logger.warn(`swarm: 数据文件路径不在允许列表，持久化将被拒绝: ${this.storePath}`);
    }
    const store = loadJsonFile<SubagentsStore>(this.storePath, {});
    const persisted = store['swarmTeams'];
    if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
      const teams = persisted as Record<string, SwarmTeam>;
      for (const [id, team] of Object.entries(teams)) {
        if (team && typeof team === 'object' && Array.isArray(team.members)) {
          this.teams[id] = team;
        }
      }
      this.teamSeq = Object.keys(this.teams).length;
      this.logger.info(`swarm: 已恢复 ${this.teamSeq} 个蜂群团队`);
    }
  }

  /** 创建蜂群团队 */
  createTeam(dto: CreateSwarmDto): SwarmTeam {
    this.teamSeq += 1;
    const teamId = `team-${this.teamSeq}-${Date.now()}`;
    const team: SwarmTeam = {
      id: teamId,
      name: dto.name && dto.name.length > 0 ? dto.name : `Team ${this.teamSeq}`,
      mode: dto.mode ?? 'collaborate',
      members: [],
      leaderId: null,
      createdAt: Date.now(),
      status: 'active',
      sharedContext: [],
      messageLog: [],
    };
    if (dto.members && dto.members.length > 0) {
      for (const m of dto.members) {
        const memberId =
          m.id && m.id.length > 0
            ? m.id
            : `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        team.members.push({
          id: memberId,
          agentId: m.agentId && m.agentId.length > 0 ? m.agentId : 'default',
          role: m.role ?? 'worker',
          status: 'idle',
        });
      }
      team.leaderId = team.members[0]!.id;
    }
    this.teams[teamId] = team;
    this.persist();
    this.logger.info(`swarm: 团队已创建 ${teamId}（${team.members.length} 名成员）`);
    return team;
  }

  /** 团队列表（摘要） */
  listTeams(): Array<Pick<SwarmTeam, 'id' | 'name' | 'mode' | 'status'> & { memberCount: number }> {
    return Object.values(this.teams).map((t) => ({
      id: t.id,
      name: t.name,
      mode: t.mode,
      memberCount: t.members.length,
      status: t.status,
    }));
  }

  /** 定向消息：写入团队消息日志与共享上下文 */
  sendMessage(teamId: string, fromId: string, message: string): { success: true } | { error: string } {
    const team = this.teams[teamId];
    if (!team) return { error: 'Team not found' };
    team.messageLog.push({ from: fromId, message, ts: Date.now() });
    if (team.messageLog.length > MAX_MESSAGE_LOG) team.messageLog.shift();
    team.sharedContext.push({
      role: 'user',
      content: `[${fromId}]: ${message}`,
      _ts: Date.now(),
    });
    if (team.sharedContext.length > MAX_SHARED_CONTEXT) team.sharedContext.shift();
    this.persist();
    return { success: true };
  }

  /** 广播：所有成员置为 notified，记录 system 消息 */
  broadcast(teamId: string, message: string): { success: true; notifiedMembers: number } | { error: string } {
    const team = this.teams[teamId];
    if (!team) return { error: 'Team not found' };
    for (const m of team.members) m.status = 'notified';
    team.messageLog.push({ from: 'system', message, ts: Date.now() });
    if (team.messageLog.length > MAX_MESSAGE_LOG) team.messageLog.shift();
    this.persist();
    return { success: true, notifiedMembers: team.members.length };
  }

  /** 团队状态摘要 */
  getTeamStatus(teamId: string): {
    id: string;
    name: string;
    mode: string;
    status: string;
    memberCount: number;
    leaderId: string | null;
    messageCount: number;
    sharedContextLength: number;
  } | null {
    const team = this.teams[teamId];
    if (!team) return null;
    return {
      id: team.id,
      name: team.name,
      mode: team.mode,
      status: team.status,
      memberCount: team.members.length,
      leaderId: team.leaderId,
      messageCount: team.messageLog.length,
      sharedContextLength: team.sharedContext.length,
    };
  }

  /** 删除团队 */
  deleteTeam(teamId: string): { success: true } | { error: string } {
    if (!this.teams[teamId]) return { error: 'Team not found' };
    delete this.teams[teamId];
    this.persist();
    return { success: true };
  }

  /** 持久化到 subagents.json（保留其他键） */
  private persist(): void {
    if (!this.security.isPathAllowed(this.storePath, 'write')) {
      this.logger.warn('swarm: 写入被路径安全策略拒绝');
      return;
    }
    const store = loadJsonFile<SubagentsStore>(this.storePath, {});
    store['swarmTeams'] = this.teams;
    saveJsonFile(this.storePath, store);
  }
}
