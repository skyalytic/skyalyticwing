import { SchedulerService } from '../../core/scheduler/scheduler.service.js';
import { RevisionConflict } from '../../core/scheduler/scheduler-store.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readJsonRecover, writeJsonAtomicSync } from '../../core/utils/atomic-json.util.js';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type {
  AgentInfo,
  AgentMemory,
  CreateAgentDto,
  TeamInfo,
  CreateTeamDto,
  UpdateAgentDto,
  UpdateTeamDto,
} from '../types.js';

/**
 * AgentService - 智能体管理服务（内置智能体 + 自定义智能体 CRUD + 团队 + 记忆 + 持久化）
 *
 * SkyalyticWing 智能体体系：
 *   1. 内置智能体：首次启动仅有一个 —— Agent（id='agent'，builtin=true）。
 *      内置智能体只能编辑、不能删除；编辑内容以 override 形式持久化到
 *      custom-agents.json（重启后覆盖种子默认值）。
 *   2. 自定义智能体：用户创建，持久化到 ${dataDir}/custom-agents.json。
 *      多智能体协作字段：slug（被调用时的唯一英文标识）、callable（是否可被
 *      其他智能体委派，缺省 true）、invocationHint（何时调用的场景描述）。
 *   3. 团队：把多个智能体拉进一个团队形成多智能体协作单元（agent-teams.json）。
 *      对话选中团队时，队长（内置 Agent）按成员的 slug/invocationHint 通过
 *      subagent_spawn_swarm 工具委派协作。
 */

/** 内置智能体固定 id（团队协作时的默认队长） */
export const BUILTIN_AGENT_ID = 'agent';

@Injectable()
export class AgentService implements OnModuleInit {
  constructor(
    @Optional() private readonly memoryPolicy?: LocalResourcePolicy,
    @Optional() private readonly scheduler?: SchedulerService,
  ) {}
  private readonly agents = new Map<string, AgentInfo>();
  private readonly memories = new Map<string, AgentMemory>();
  private customAgentsFile = '';
  private teamsFile = '';
  private memoriesFile = '';
  private memoryInitialized = false;
  private readonly teams = new Map<string, TeamInfo>();

  // ─── 初始化：内置种子 + 持久化数据加载 ─────────────────────────────

  onModuleInit(): void {
    const dataDir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    this.customAgentsFile = join(dataDir, 'custom-agents.json');
    this.teamsFile = join(dataDir, 'agent-teams.json');

    // 1. 内置智能体种子：仅一个 Agent（清空旧版 6 个 .agents 预设——产品决策）
    const seed = this.buildBuiltinSeed();
    this.agents.set(seed.id, seed);

    // 2. 持久化数据：自定义智能体 + 内置智能体的编辑 override
    const persisted = this.readPersistedAgents();
    for (const ca of persisted) {
      if (!ca || typeof ca['id'] !== 'string' || !ca['id']) continue;
      const id = ca['id'];
      const isBuiltinOverride = id === BUILTIN_AGENT_ID;
      if (!isBuiltinOverride && this.agents.has(id)) continue;
      const base = isBuiltinOverride ? this.agents.get(id)! : undefined;
      this.agents.set(id, {
        id,
        name: typeof ca['name'] === 'string' && ca['name'] ? ca['name'] : (base?.name ?? id),
        description:
          typeof ca['description'] === 'string' ? ca['description'] : (base?.description ?? ''),
        model: typeof ca['model'] === 'string' ? ca['model'] : (base?.model ?? ''),
        systemPrompt:
          typeof ca['systemPrompt'] === 'string' ? ca['systemPrompt'] : (base?.systemPrompt ?? ''),
        tools: Array.isArray(ca['tools']) ? (ca['tools'] as string[]) : (base?.tools ?? []),
        toolsMode:
          ca['toolsMode'] === 'none' || ca['toolsMode'] === 'selected'
            ? ca['toolsMode']
            : 'inherit',
        createdAt:
          typeof ca['createdAt'] === 'number' ? ca['createdAt'] : (base?.createdAt ?? Date.now()),
        updatedAt:
          typeof ca['updatedAt'] === 'number' ? ca['updatedAt'] : (base?.updatedAt ?? Date.now()),
        type: typeof ca['type'] === 'string' ? ca['type'] : (base?.type ?? 'specialist'),
        emoji: typeof ca['emoji'] === 'string' ? ca['emoji'] : (base?.emoji ?? 'agent'),
        capabilities: Array.isArray(ca['capabilities'])
          ? (ca['capabilities'] as string[])
          : (base?.capabilities ?? []),
        status: 'idle',
        defaultModel: typeof ca['model'] === 'string' ? ca['model'] : (base?.defaultModel ?? ''),
        tasksCompleted: base?.tasksCompleted ?? 0,
        tokensUsed: base?.tokensUsed ?? '0B',
        builtin: isBuiltinOverride ? true : false,
        slug:
          typeof ca['slug'] === 'string'
            ? ca['slug']
            : (base?.slug ?? (isBuiltinOverride ? 'agent' : '')),
        callable: typeof ca['callable'] === 'boolean' ? ca['callable'] : (base?.callable ?? true),
        invocationHint:
          typeof ca['invocationHint'] === 'string'
            ? ca['invocationHint']
            : (base?.invocationHint ?? ''),
        avatar: typeof ca['avatar'] === 'string' ? ca['avatar'] : (base?.avatar ?? ''),
      });
    }

    // 3. 内置智能体常驻运行
    const builtin = this.agents.get(BUILTIN_AGENT_ID);
    if (builtin) builtin.status = 'running';

    // 4. 团队加载
    this.loadTeams();
    this.memoryInitialized = true;
    this.ensureMemoryScope();
  }

  /** 内置智能体种子（单例 Agent；用户编辑经 override 覆盖对应字段） */
  private buildBuiltinSeed(): AgentInfo {
    const now = Date.now();
    return {
      id: BUILTIN_AGENT_ID,
      name: 'Agent',
      description: '内置通用智能体：日常对话、任务执行与多智能体协作调度（队长）',
      model: '',
      systemPrompt: '',
      tools: [],
      createdAt: now,
      updatedAt: now,
      type: 'builtin',
      emoji: 'agent',
      capabilities: [],
      status: 'idle',
      defaultModel: '',
      tasksCompleted: 0,
      tokensUsed: '0B',
      builtin: true,
      slug: 'agent',
      callable: true,
      invocationHint: '默认总调度：任何任务都可委派给内置 Agent 处理或由它分派给团队成员',
    };
  }

  // ─── 持久化（custom-agents.json：自定义智能体 + 内置编辑 override） ──

  private readPersistedAgents(): Array<Record<string, unknown>> {
    const raw = readJsonRecover<unknown>(this.customAgentsFile, []);
    if (!Array.isArray(raw)) throw new Error('Invalid custom-agents.json');
    return raw;
  }

  private writePersistedAgents(): void {
    if (!this.customAgentsFile) return;
    {
      const custom = Array.from(this.agents.values())
        .filter((a) => !a.builtin || a.id === BUILTIN_AGENT_ID)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          model: a.model,
          systemPrompt: a.systemPrompt,
          tools: a.tools,
          toolsMode: a.toolsMode,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          type: a.type || 'specialist',
          emoji: a.emoji || 'agent',
          capabilities: a.capabilities || [],
          slug: a.slug,
          callable: a.callable !== false,
          invocationHint: a.invocationHint || '',
          avatar: a.avatar || '',
        }));
      writeJsonAtomicSync(this.customAgentsFile, custom);
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────────

  /** 列出全部智能体 */
  listAgents(): AgentInfo[] {
    return Array.from(this.agents.keys()).map((id) => this.getAgent(id));
  }

  /** 获取单个智能体，不存在则抛错 */
  getAgent(id: string): AgentInfo {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent '${id}' not found`);
    if (!this.scheduler) return agent;
    const store = this.scheduler.store();
    const document = store.prompt(
      id,
      agent.systemPrompt,
      agent.builtin ? this.buildBuiltinSeed().systemPrompt : agent.systemPrompt,
    );
    const current = (
      agent.builtin ? store.upgradePrompt(id, this.buildBuiltinSeed().systemPrompt) : document
    ).revisions.at(-1)!;
    return { ...agent, systemPrompt: current.text, promptRevision: current.revision };
  }

  /** 按英文标识名（slug）查找智能体（协作委派入口，大小写不敏感） */
  findBySlug(slug: string): AgentInfo | undefined {
    if (!slug) return undefined;
    const s = slug.toLowerCase();
    return this.listAgents().find((a) => (a.slug || '').toLowerCase() === s);
  }

  /** slug 唯一性校验（排除自身） */
  private assertSlugAvailable(slug: string | undefined, excludeId?: string): void {
    if (!slug) return;
    const hit = this.findBySlug(slug);
    if (hit && hit.id !== excludeId) {
      throw new Error(`英文标识名 '${slug}' 已被智能体 '${hit.name}' 使用`);
    }
  }

  /** 创建自定义智能体 */
  createAgent(data: CreateAgentDto): AgentInfo {
    if (!data.name) {
      throw new Error('createAgent requires name');
    }
    const id = data.id?.trim() || randomUUID();
    if (this.agents.has(id)) {
      throw new Error(`Agent '${id}' already exists`);
    }
    this.assertSlugAvailable(data.slug);
    const now = Date.now();
    const agent: AgentInfo = {
      id,
      name: data.name,
      description: data.description ?? '',
      model: data.model ?? '',
      systemPrompt: data.systemPrompt ?? '',
      tools: data.tools ?? [],
      toolsMode: data.toolsMode || (data.tools !== undefined ? 'selected' : 'inherit'),
      createdAt: now,
      updatedAt: now,
      type: data.type ?? 'specialist',
      emoji: data.emoji ?? 'agent',
      capabilities: data.capabilities ?? [],
      status: 'idle',
      defaultModel: data.model ?? '',
      tasksCompleted: 0,
      tokensUsed: '0B',
      builtin: false,
      slug: data.slug ?? '',
      callable: data.callable !== false,
      invocationHint: data.invocationHint ?? '',
      avatar: data.avatar ?? '',
    };
    this.agents.set(id, agent);
    try {
      this.writePersistedAgents();
    } catch (error) {
      this.agents.delete(id);
      throw error;
    }
    return agent;
  }

  /** 更新智能体（内置智能体可编辑，编辑以 override 持久化） */
  updateAgent(id: string, data: UpdateAgentDto): AgentInfo {
    const existing = this.getAgent(id);
    if (
      data.systemPrompt !== undefined &&
      this.scheduler &&
      data.systemPrompt !== existing.systemPrompt
    ) {
      if (data.promptRevision !== existing.promptRevision)
        throw new RevisionConflict('Prompt changed; reload before saving');
    }
    if (data.slug !== undefined && data.slug !== existing.slug) {
      this.assertSlugAvailable(data.slug, id);
    }
    const updated: AgentInfo = { ...existing, updatedAt: Date.now() };
    if (data.name !== undefined) updated.name = data.name;
    if (data.description !== undefined) updated.description = data.description;
    if (data.model !== undefined) {
      updated.model = data.model;
      updated.defaultModel = data.model;
    }
    if (data.systemPrompt !== undefined)
      updated.systemPrompt = this.scheduler
        ? (this.agents.get(id)?.systemPrompt ?? '')
        : data.systemPrompt;
    if (data.tools !== undefined) {
      updated.tools = data.tools;
      updated.toolsMode = data.toolsMode || 'selected';
    }
    if (data.toolsMode !== undefined) updated.toolsMode = data.toolsMode;
    if (data.type !== undefined && !existing.builtin) updated.type = data.type;
    if (data.emoji !== undefined) updated.emoji = data.emoji;
    if (data.capabilities !== undefined) updated.capabilities = data.capabilities;
    if (data.slug !== undefined) updated.slug = data.slug;
    if (data.callable !== undefined) updated.callable = data.callable;
    if (data.invocationHint !== undefined) updated.invocationHint = data.invocationHint;
    if (data.avatar !== undefined) updated.avatar = data.avatar;
    this.agents.set(id, updated);
    try {
      this.writePersistedAgents();
    } catch (error) {
      this.agents.set(id, existing);
      throw error;
    }
    if (
      data.systemPrompt !== undefined &&
      this.scheduler &&
      data.systemPrompt !== existing.systemPrompt
    )
      this.scheduler.store().savePrompt(id, data.systemPrompt, existing.promptRevision!);
    return this.getAgent(id);
  }

  /** 删除智能体（内置智能体不可删除——产品规则：只能编辑，不能删除） */
  deleteAgent(id: string): void {
    this.ensureMemoryScope();
    const existing = this.agents.get(id);
    if (existing?.builtin) {
      throw new Error('内置智能体不可删除');
    }
    const previousTeams = new Map(
      [...this.teams].map(([key, team]) => [key, { ...team, memberIds: [...team.memberIds] }]),
    );
    const previousMemory = this.memories.get(id);
    this.agents.delete(id);
    this.memories.delete(id);
    for (const team of this.teams.values()) {
      if (!team.memberIds.includes(id)) continue;
      team.memberIds = team.memberIds.filter((member) => member !== id);
      if (team.leadId === id) team.leadId = team.memberIds[0];
      team.updatedAt = Date.now();
    }
    if (existing) {
      try {
        this.writePersistedAgents();
        this.writeTeams();
        if (this.memoriesFile) writeJsonAtomicSync(this.memoriesFile, [...this.memories.values()]);
      } catch (error) {
        this.agents.set(id, existing);
        if (previousMemory) this.memories.set(id, previousMemory);
        this.teams.clear();
        for (const [key, team] of previousTeams) this.teams.set(key, team);
        // Restore the first file if the second write failed. A storage failure is surfaced.
        this.writePersistedAgents();
        this.writeTeams();
        throw error;
      }
    }
  }

  // ─── 团队（多智能体协作单元） ────────────────────────────────────────

  /** 列出全部团队 */
  listTeams(): TeamInfo[] {
    return Array.from(this.teams.values());
  }

  /** 获取单个团队，不存在则抛错 */
  getTeam(id: string): TeamInfo {
    const team = this.teams.get(id);
    if (!team) throw new Error(`Team '${id}' not found`);
    return team;
  }

  /** 创建团队（成员 id 校验存在性） */
  createTeam(data: CreateTeamDto): TeamInfo {
    if (!data.name) throw new Error('createTeam requires name');
    const memberIds = Array.isArray(data.memberIds) ? data.memberIds : [];
    for (const mid of memberIds) {
      if (!this.agents.has(mid)) throw new Error(`团队成员不存在: ${mid}`);
    }
    if (data.leadId && !memberIds.includes(data.leadId)) {
      throw new Error('主管人必须是团队成员');
    }
    const now = Date.now();
    const team: TeamInfo = {
      id: randomUUID(),
      name: data.name,
      description: data.description ?? '',
      memberIds,
      leadId: data.leadId ?? memberIds[0],
      tags: Array.isArray(data.tags) ? data.tags : [],
      avatar: data.avatar ?? '',
      createdAt: now,
      updatedAt: now,
    };
    this.teams.set(team.id, team);
    try {
      this.writeTeams();
    } catch (error) {
      this.teams.delete(team.id);
      throw error;
    }
    return team;
  }

  /** 更新团队（名称/描述/成员清单/主管人/标签） */
  updateTeam(id: string, data: UpdateTeamDto): TeamInfo {
    const existing = this.getTeam(id);
    const updated: TeamInfo = { ...existing, updatedAt: Date.now() };
    if (data.name !== undefined) updated.name = data.name;
    if (data.description !== undefined) updated.description = data.description;
    if (data.memberIds !== undefined) {
      for (const mid of data.memberIds) {
        if (!this.agents.has(mid)) throw new Error(`团队成员不存在: ${mid}`);
      }
      updated.memberIds = data.memberIds;
    }
    if (data.leadId !== undefined) {
      if (!updated.memberIds.includes(data.leadId)) throw new Error('主管人必须是团队成员');
      updated.leadId = data.leadId;
    }
    if (updated.leadId && !updated.memberIds.includes(updated.leadId))
      updated.leadId = updated.memberIds[0];
    if (data.tags !== undefined) updated.tags = data.tags;
    if (data.avatar !== undefined) updated.avatar = data.avatar;
    this.teams.set(id, updated);
    try {
      this.writeTeams();
    } catch (error) {
      this.teams.set(id, existing);
      throw error;
    }
    return updated;
  }

  /** 删除团队 */
  deleteTeam(id: string): void {
    const existing = this.getTeam(id);
    this.teams.delete(id);
    try {
      this.writeTeams();
    } catch (error) {
      this.teams.set(id, existing);
      throw error;
    }
  }

  /** 团队可委派成员清单（callable !== false 的成员），供协作调度注入 */
  getTeamCallableMembers(teamId: string): AgentInfo[] {
    const team = this.getTeam(teamId);
    return team.memberIds
      .map((mid) => this.agents.get(mid))
      .filter((a): a is AgentInfo => !!a && a.callable !== false);
  }

  private loadTeams(): void {
    {
      const raw = readJsonRecover<unknown>(this.teamsFile, []);
      if (!Array.isArray(raw)) throw new Error('Invalid agent-teams.json');
      for (const t of raw) {
        if (!t || typeof t['id'] !== 'string' || typeof t['name'] !== 'string') continue;
        const memberIds = Array.isArray(t['memberIds'])
          ? (t['memberIds'] as string[]).filter((id) => this.agents.has(id))
          : [];
        this.teams.set(t['id'], {
          id: t['id'],
          name: t['name'],
          description: typeof t['description'] === 'string' ? t['description'] : '',
          memberIds,
          leadId:
            typeof t['leadId'] === 'string' && memberIds.includes(t['leadId'])
              ? t['leadId']
              : memberIds[0],
          tags: Array.isArray(t['tags']) ? (t['tags'] as string[]) : [],
          avatar: typeof t['avatar'] === 'string' ? t['avatar'] : '',
          createdAt: typeof t['createdAt'] === 'number' ? t['createdAt'] : Date.now(),
          updatedAt: typeof t['updatedAt'] === 'number' ? t['updatedAt'] : Date.now(),
        });
      }
    }
  }

  private writeTeams(): void {
    if (!this.teamsFile) return;
    writeJsonAtomicSync(this.teamsFile, Array.from(this.teams.values()));
  }

  // ─── 记忆 ───────────────────────────────────────────────────────────

  private ensureMemoryScope(): void {
    if (!this.memoryInitialized) return;
    const root = getDefaultDataDir();
    const file = join(this.memoryPolicy?.localMemoryRoot(root) ?? root, 'agent-memories.json');
    if (file === this.memoriesFile) return;
    const values = readJsonRecover<AgentMemory[]>(file, []);
    if (
      !Array.isArray(values) ||
      values.some(
        (m) =>
          !m ||
          typeof m.agentId !== 'string' ||
          !Array.isArray(m.facts) ||
          m.facts.some((f) => typeof f !== 'string'),
      )
    )
      throw new Error('智能体记忆文件损坏');
    this.memories.clear();
    for (const memory of values)
      if (this.agents.has(memory.agentId)) this.memories.set(memory.agentId, memory);
    this.memoriesFile = file;
  }
  /** 获取智能体记忆（不存在则返回空记忆） */
  getMemory(agentId: string): AgentMemory {
    this.ensureMemoryScope();
    return structuredClone(this.memories.get(agentId) ?? { agentId, facts: [], lastUpdated: 0 });
  }

  /** 设置智能体记忆 */
  setMemory(agentId: string, memory: AgentMemory): void {
    this.ensureMemoryScope();
    this.getAgent(agentId);
    if (
      !Array.isArray(memory.facts) ||
      memory.facts.length > 1000 ||
      memory.facts.some((f) => typeof f !== 'string' || f.length > 10000)
    )
      throw new Error('记忆内容无效');
    const previous = this.memories.get(agentId);
    this.memories.set(agentId, {
      ...memory,
      agentId,
      lastUpdated: Date.now(),
    });
    try {
      if (this.memoriesFile) writeJsonAtomicSync(this.memoriesFile, [...this.memories.values()]);
    } catch (e) {
      if (previous) this.memories.set(agentId, previous);
      else this.memories.delete(agentId);
      throw e;
    }
  }

  // ─── 工具 ───────────────────────────────────────────────────────────

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
