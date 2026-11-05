import { Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir, platform } from 'node:os';
import { LoggerService } from '../core/logger/logger.service.js';

/**
 * BindingService - 路由绑定服务
 *
 * 移植自 start.cjs BindingRouter（行 9184-9355）。
 *
 * 维护一组 binding 规则，按 8 层优先级（精确对端 > 通配对端 > Guild+角色 > Guild > Team > Account > Channel > 通配 Channel）
 * 累加优先级分数，选出最高分匹配项；无匹配时返回 defaultAgent。
 *
 * 优先级累加（与 .cjs 一致）：
 *   精确对端（peer.id + peer.kind 均匹配）       +80
 *   Guild + 角色匹配                              +70
 *   Guild 匹配（无 roles 约束）                    +60
 *   通配对端（peer.kind="*"） OR Team 匹配          +50
 *   Account 匹配                                  +40
 *   Channel 精确匹配                              +30
 *   Channel 通配（"*"）                           +10
 *
 * 持久化：${dataDir}/bindings.json
 */

/** 对端匹配条件 */
export interface PeerMatch {
  id?: string;
  kind?: string;
}

/** binding.match 子结构 */
export interface BindingMatch {
  channel?: string;
  accountId?: string;
  peer?: PeerMatch;
  guildId?: string;
  teamId?: string;
  roles?: string[];
}

/** 一条绑定规则 */
export interface Binding {
  id: string;
  agentId: string;
  match?: BindingMatch;
  createdAt: number;
  /** 兼容旧版扁平字段（POST 时可传入，addBinding 时折叠到 match） */
  matchChannel?: string;
  matchAccountId?: string;
  matchPeerId?: string;
  matchPeerKind?: string;
  matchGuildId?: string;
  matchTeamId?: string;
  matchRoles?: string[];
}

/** resolve 上下文 */
export interface BindingContext {
  channel?: string;
  accountId?: string;
  peerId?: string;
  peerKind?: string;
  guildId?: string;
  teamId?: string;
  roles?: string[];
}

/** resolve 返回结果 */
export interface BindingResolveResult {
  agentId: string;
  matchedBy: string;
  binding: Binding | null;
}

/** 默认 agentId */
const DEFAULT_AGENT_ID = 'main';

@Injectable()
export class BindingService implements OnModuleInit {
  private readonly bindings: Binding[] = [];
  private filePath = '';

  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.filePath = this.resolveFilePath('bindings.json');
    this.load();
  }

  /** 新增绑定。兼容 .cjs 扁平字段：matchChannel/matchAccountId/... 折叠到 match */
  addBinding(input: Partial<Binding>): Binding {
    const binding: Binding = {
      id: input.id || `bind-${Date.now()}`,
      agentId: input.agentId || DEFAULT_AGENT_ID,
      createdAt: Date.now(),
    };
    if (input.match) {
      binding.match = input.match;
    } else {
      // 折叠扁平字段到 match
      const match: BindingMatch = {};
      if (input.matchChannel) match.channel = input.matchChannel;
      if (input.matchAccountId) match.accountId = input.matchAccountId;
      if (input.matchPeerId) {
        match.peer = {
          id: input.matchPeerId,
          kind: input.matchPeerKind || '*',
        };
      }
      if (input.matchGuildId) match.guildId = input.matchGuildId;
      if (input.matchTeamId) match.teamId = input.matchTeamId;
      if (input.matchRoles) match.roles = input.matchRoles;
      binding.match = match;
    }
    this.bindings.push(binding);
    this.persist();
    this.logger.info('BindingService: added binding', {
      agentId: binding.agentId,
      match: JSON.stringify(binding.match),
    });
    return binding;
  }

  /** 删除绑定 */
  removeBinding(id: string): boolean {
    const idx = this.bindings.findIndex((b) => b.id === id);
    if (idx < 0) return false;
    this.bindings.splice(idx, 1);
    this.persist();
    return true;
  }

  /** 列出全部绑定（返回副本） */
  listBindings(): Binding[] {
    return this.bindings.slice();
  }

  /**
   * 解析上下文，返回最佳匹配的 agentId。
   * 与 .cjs resolve 行为一致：累加 priority，取最高分；无匹配返回 defaultAgent。
   */
  resolve(ctx: BindingContext, defaultAgent: string = DEFAULT_AGENT_ID): BindingResolveResult {
    const channel = ctx.channel || '';
    const accountId = ctx.accountId || '';
    const peerId = ctx.peerId || '';
    const peerKind = ctx.peerKind || '';
    const guildId = ctx.guildId || '';
    const teamId = ctx.teamId || '';
    const roles = ctx.roles || [];

    let best: Binding | null = null;
    let bestPriority = -1;

    for (const b of this.bindings) {
      const m = b.match || {};
      let matched = true;
      let priority = 0;

      // 对端匹配：精确对端 +80 / 通配对端 +50
      if (m.peer) {
        if (
          m.peer.id &&
          m.peer.id === peerId &&
          m.peer.kind &&
          m.peer.kind === peerKind
        ) {
          priority += 80;
        } else if (
          m.peer.kind === '*' &&
          (!m.peer.id || m.peer.id === peerId) &&
          peerId
        ) {
          priority += 50;
        } else {
          matched = false;
        }
      }

      // Guild 匹配：Guild+角色 +70 / Guild +60
      if (m.guildId) {
        if (m.guildId === guildId) {
          if (
            m.roles &&
            m.roles.length > 0 &&
            roles.length > 0 &&
            m.roles.some((r) => roles.indexOf(r) >= 0)
          ) {
            priority += 70;
          } else if (!m.roles || m.roles.length === 0) {
            priority += 60;
          } else {
            matched = false;
          }
        } else {
          matched = false;
        }
      }

      // Team 匹配：+50
      if (m.teamId) {
        if (m.teamId === teamId) {
          priority += 50;
        } else {
          matched = false;
        }
      }

      // Account 匹配：+40
      if (m.accountId) {
        if (m.accountId === accountId) {
          priority += 40;
        } else {
          matched = false;
        }
      }

      // Channel 匹配：精确 +30 / 通配 +10
      if (m.channel) {
        if (m.channel === channel) {
          priority += 30;
        } else if (m.channel === '*') {
          priority += 10;
        } else {
          matched = false;
        }
      }

      if (!matched || priority === 0) continue;
      if (priority > bestPriority) {
        bestPriority = priority;
        best = b;
      }
    }

    const agentId = best ? best.agentId : defaultAgent;
    const matchedBy = best
      ? `binding(priority=${bestPriority})`
      : 'default';
    return { agentId, matchedBy, binding: best };
  }

  // ─── 内部工具 ────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
        if (Array.isArray(raw)) {
          this.bindings.length = 0;
          for (const b of raw) {
            this.bindings.push(b as Binding);
          }
        }
      }
    } catch (err) {
      this.logger.warn('BindingService: failed to load bindings', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.logger.info('BindingService: loaded', { count: this.bindings.length });
  }

  private persist(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.bindings, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn('BindingService: failed to persist bindings', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveFilePath(filename: string): string {
    const dataDir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    return resolvePath(dataDir, filename);
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
