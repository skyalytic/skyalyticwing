import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { MemoryService } from '../../../../modules/ai/agent/memory.service.js';
import { MemoryDataService } from '../../../../modules/memory/memory-data.service.js';
import { VectorsService } from '../../../../modules/ai/vectors/vectors.service.js';
import { SkillService } from '../../../../modules/ai/agent/skill.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

interface MemorySearchArgs {
  query: string;
  maxResults?: number;
}

interface MemoryGetArgs {
  path?: string;
  from?: number;
  lines?: number;
}

interface MemorySaveArgs {
  content: string;
  target: 'longterm' | 'today';
  section?: string;
}

interface KnowledgeSearchArgs {
  query: string;
  topK?: number;
}

interface KnowledgeAddArgs {
  title: string;
  content: string;
  tags?: string[];
}

interface SkillCreateArgs {
  name: string;
  description: string;
  steps: string;
  emoji?: string;
}

interface SkillExecuteArgs {
  name: string;
  input?: string;
}

interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface UpdatePlanArgs {
  plan: PlanStep[];
  explanation?: string;
}

/** 会话内计划存储（sessionId → 最新计划），与旧版一致仅会话内有效 */
const sessionPlans = new Map<string, { plan: PlanStep[]; explanation: string; updatedAt: number }>();

/**
 * 记忆/向量/技能域工具：
 *   - memory_search / memory_get / memory_save   → MemoryService（MEMORY.md + 每日笔记）
 *   - knowledge_search / knowledge_add           → MemoryDataService + VectorsService（向量检索）
 *   - skill_list / skill_create / skill_execute  → SkillService
 *   - update_plan                                → 会话内计划管理（轻量内存实现 + 广播）
 */
export function createMemoryTools(resolve: ServiceResolver): ToolDefinition[] {
  /** 域服务懒解析（首次执行时解析并缓存；未加载时工具返回明确不可用提示） */
  let memoryCache: MemoryService | undefined;
  let memoryResolved = false;
  const getMemory = (): MemoryService | undefined => {
    if (!memoryResolved) {
      memoryCache = resolve(MemoryService);
      memoryResolved = true;
    }
    return memoryCache;
  };
  let memoryDataCache: MemoryDataService | undefined;
  let memoryDataResolved = false;
  const getMemoryData = (): MemoryDataService | undefined => {
    if (!memoryDataResolved) {
      memoryDataCache = resolve(MemoryDataService);
      memoryDataResolved = true;
    }
    return memoryDataCache;
  };
  let vectorsCache: VectorsService | undefined;
  let vectorsResolved = false;
  const getVectors = (): VectorsService | undefined => {
    if (!vectorsResolved) {
      vectorsCache = resolve(VectorsService);
      vectorsResolved = true;
    }
    return vectorsCache;
  };
  let skillCache: SkillService | undefined;
  let skillResolved = false;
  const getSkill = (): SkillService | undefined => {
    if (!skillResolved) {
      skillCache = resolve(SkillService);
      skillResolved = true;
    }
    return skillCache;
  };

  const memorySearchTool: ToolDefinition = {
    name: 'memory_search',
    description:
      '搜索长期记忆(MEMORY.md)和每日笔记(memory/*.md)。回答关于之前工作、决策、偏好、待办等问题前，必须先搜索记忆。',
    category: 'memory',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询' },
        maxResults: { type: 'number', description: '最大结果数（默认10）' },
      },
      required: ['query'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as MemorySearchArgs;
      if (!a || typeof a.query !== 'string' || a.query.length === 0) {
        return { success: false, error: 'Parameter "query" is required and must be a non-empty string' };
      }
      const memory = getMemory();
      if (!memory) {
        return { success: false, error: '记忆服务不可用（AgentModule 未加载）' };
      }
      try {
        const results = memory.search(a.query, a.maxResults ?? 10, _ctx.agentId);
        return {
          success: true,
          output: results.length === 0 ? '（无记忆命中）' : JSON.stringify(results, null, 2),
          data: { query: a.query, results, total: results.length },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const memoryGetTool: ToolDefinition = {
    name: 'memory_get',
    description: '读取记忆文件内容（MEMORY.md 或 memory/YYYY-MM-DD.md），支持行号分页。',
    category: 'memory',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，如 MEMORY.md 或 memory/2026-04-19.md' },
        from: { type: 'number', description: '起始行号（默认1）' },
        lines: { type: 'number', description: '读取行数（默认120）' },
      },
      required: ['path'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as MemoryGetArgs;
      if (!a || typeof a.path !== 'string' || a.path.length === 0) {
        return { success: false, error: 'Parameter "path" is required' };
      }
      if (a.path.includes('..')) {
        return { success: false, error: '路径不允许包含 ..', blocked: true };
      }
      const memory = getMemory();
      if (!memory) {
        return { success: false, error: '记忆服务不可用（AgentModule 未加载）' };
      }
      try {
        const result = memory.get(a.path, a.from, a.lines);
        if (typeof result === 'string') {
          return { success: false, error: result };
        }
        if (result.error) {
          return { success: false, error: result.error };
        }
        return {
          success: true,
          output: (result.content ?? '').slice(0, 60_000),
          data: result,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const memorySaveTool: ToolDefinition = {
    name: 'memory_save',
    description:
      '保存信息到记忆系统。重要信息用 longterm（MEMORY.md 长期记忆），临时观察用 today（今日笔记）。',
    category: 'memory',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要保存的内容' },
        target: { type: 'string', enum: ['longterm', 'today'], description: 'longterm=长期记忆, today=今日笔记' },
        section: { type: 'string', description: '可选的章节标题' },
      },
      required: ['content', 'target'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as MemorySaveArgs;
      if (!a || typeof a.content !== 'string' || a.content.length === 0) {
        return { success: false, error: 'Parameter "content" is required and must be a non-empty string' };
      }
      if (a.target !== 'longterm' && a.target !== 'today') {
        return { success: false, error: 'Parameter "target" must be longterm or today' };
      }
      const memory = getMemory();
      if (!memory) {
        return { success: false, error: '记忆服务不可用（AgentModule 未加载）' };
      }
      const text = a.section ? `\n### ${a.section}\n${a.content}` : a.content;
      try {
        const r = a.target === 'longterm' ? memory.appendToMemory(text, _ctx.agentId) : memory.appendToToday(text);
        if (!r.ok) {
          return { success: false, error: r.error ?? '保存失败' };
        }
        return { success: true, output: `已保存到${a.target === 'longterm' ? '长期记忆(MEMORY.md)' : '今日笔记'}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const knowledgeSearchTool: ToolDefinition = {
    name: 'knowledge_search',
    description:
      '搜索知识库（向量检索 + 关键词回退）。当问题需要知识库中的信息（产品文档、FAQ、客服知识）时使用，返回最相关条目。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询词或问题' },
        topK: { type: 'number', description: '返回结果数量（默认5）' },
      },
      required: ['query'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as KnowledgeSearchArgs;
      if (!a || typeof a.query !== 'string' || a.query.length === 0) {
        return { success: false, error: 'Parameter "query" is required and must be a non-empty string' };
      }
      const vectors = getVectors();
      const memoryData = getMemoryData();
      if (!vectors && !memoryData) {
        return { success: false, error: '知识库服务不可用（VectorsModule / MemoryModule 未加载）' };
      }
      try {
        const results = vectors ? vectors.search(a.query, { topK: a.topK ?? 5 }) : [];
        const knowledge = memoryData ? memoryData.searchKnowledge(a.query, a.topK ?? 5) : [];
        return {
          success: true,
          output:
            JSON.stringify(
              {
                vectorResults: results.map((r) => ({
                  score: Number(r.score.toFixed(3)),
                  matchType: r.matchType,
                  content: r.content,
                  metadata: r.metadata,
                })),
                knowledgeResults: knowledge.map((k) => ({
                  id: k.id,
                  title: k.title,
                  score: k.score,
                  content: k.content.slice(0, 300),
                })),
              },
              null,
              2,
            ) || '（无结果）',
          data: { query: a.query, vectorCount: results.length, knowledgeCount: knowledge.length },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const knowledgeAddTool: ToolDefinition = {
    name: 'knowledge_add',
    description:
      '向知识库添加新条目（FAQ、文档片段、产品信息等）。同时写入知识库与向量索引以便语义检索。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '知识条目标题' },
        content: { type: 'string', description: '知识内容正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["产品","FAQ"]' },
      },
      required: ['title', 'content'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as KnowledgeAddArgs;
      if (!a || typeof a.title !== 'string' || a.title.length === 0) {
        return { success: false, error: 'Parameter "title" is required' };
      }
      if (typeof a.content !== 'string' || a.content.length === 0) {
        return { success: false, error: 'Parameter "content" is required' };
      }
      const memoryData = getMemoryData();
      if (!memoryData) {
        return { success: false, error: '知识库服务不可用（MemoryModule 未加载）' };
      }
      const vectors = getVectors();
      try {
        const entry = memoryData.addKnowledge(a.title, a.content, a.tags);
        // 同步写入向量索引（type=knowledge 供统计与语义检索；向量服务不可用时跳过）
        let vectorId: string | undefined;
        let indexWarning: string | undefined;
        if (vectors) {
          try {
          const embedding = vectors.addEmbedding(`${a.title}\n${a.content}`, {
            type: 'knowledge',
            knowledgeId: entry.id,
            title: a.title,
            tags: entry.tags,
            source: 'knowledge_add',
          });
          vectorId = embedding.id;
          } catch {
            indexWarning = '条目已保存，但向量索引未写入，仍可通过关键词检索';
          }
        }
        return {
          success: true,
          output: `知识条目已添加: ${a.title} (id=${entry.id}${vectorId ? `, vector=${vectorId}` : ''})${indexWarning ? '\n' + indexWarning : ''}`,
          data: { id: entry.id, ...(vectorId ? { vectorId } : {}), ...(indexWarning ? {indexWarning} : {}) },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const skillListTool: ToolDefinition = {
    name: 'skill_list',
    description: '列出所有可用技能及其描述。',
    category: 'skill',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const skill = getSkill();
      if (!skill) {
        return { success: false, error: '技能服务不可用（AgentModule 未加载）' };
      }
      try {
        const { skills } = await skill.listAvailableSkills();
        return {
          success: true,
          output:
            skills.map((s) => `${s.emoji ?? '📋'} ${s.name}: ${s.description}`).join('\n') || '（无技能）',
          data: { skills, total: skills.length },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const skillCreateTool: ToolDefinition = {
    name: 'skill_create',
    description:
      '创建新技能。技能是AI可调用的操作指南（SKILL.md），创建后在相关场景下自动使用。用户说"帮我创建一个XXX技能"时使用。',
    category: 'skill',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（英文小写+连字符，如 web-search）' },
        description: { type: 'string', description: '技能简短描述' },
        steps: { type: 'string', description: '技能详细操作步骤（Markdown）' },
        emoji: { type: 'string', description: '技能图标emoji（默认📋）' },
      },
      required: ['name', 'description', 'steps'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as SkillCreateArgs;
      if (!a || typeof a.name !== 'string' || a.name.length === 0) {
        return { success: false, error: 'Parameter "name" is required' };
      }
      if (!a.description) return { success: false, error: 'Parameter "description" is required' };
      if (!a.steps) return { success: false, error: 'Parameter "steps" is required' };
      const skill = getSkill();
      if (!skill) {
        return { success: false, error: '技能服务不可用（AgentModule 未加载）' };
      }
      try {
        const meta = skill.createSkill({
          name: a.name,
          description: a.description,
          steps: a.steps,
          ...(typeof a.emoji === 'string' ? { emoji: a.emoji } : {}),
        });
        ctx.broadcast('skill_updated', { action: 'created', skill: meta });
        return {
          success: true,
          output: `技能"${a.name}"创建成功，AI可在相关场景下使用`,
          data: meta,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const skillExecuteTool: ToolDefinition = {
    name: 'skill_execute',
    description:
      '获取指定技能的详细步骤（SKILL.md 内容）。此工具只返回步骤，不会自动执行——你需要按照步骤用 bash/file_read 等工具直接完成。',
    category: 'skill',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要执行的技能名称' },
        input: { type: 'string', description: '执行技能时的输入参数或上下文（可选）' },
      },
      required: ['name'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as SkillExecuteArgs;
      if (!a || typeof a.name !== 'string' || a.name.length === 0) {
        return { success: false, error: 'Parameter "name" is required' };
      }
      const skill = getSkill();
      if (!skill) {
        return { success: false, error: '技能服务不可用（AgentModule 未加载）' };
      }
      try {
        const result = await skill.getSkillContent(a.name);
        if (!result) {
          return { success: false, error: `未找到技能: ${a.name}（可用 skill_list 查看）` };
        }
        const { parseSkillDocument } = await import('../../../../modules/ai/agent/skill-document.js');
        const body = parseSkillDocument(result.content).body || result.content;
        return {
          success: true,
          output: `技能文件：${result.path}\n辅助文件和脚本请相对此文件所在目录解析；产物写入当前工作目录。\n\n${body}\n\n[以上为操作指南，请继续使用工具完成并检查结果；读取指南不代表任务完成。]`,
          data: { skill: a.name, input: a.input ?? '', path: result.path },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const updatePlanTool: ToolDefinition = {
    name: 'update_plan',
    description:
      '更新当前结构化工作计划，用于多步骤复杂任务跟踪进度。每步有 pending/in_progress/completed 三种状态，最多一个 in_progress。简单任务不需要使用。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', description: '简短的步骤描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '步骤状态' },
            },
            required: ['step', 'status'],
          },
          description: '有序步骤列表',
        },
        explanation: { type: 'string', description: '可选的变更说明' },
      },
      required: ['plan'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as UpdatePlanArgs;
      if (!a || !Array.isArray(a.plan) || a.plan.length === 0) {
        return { success: false, error: 'Parameter "plan" must be a non-empty array' };
      }
      const inProgress = a.plan.filter((s) => s && s.status === 'in_progress').length;
      if (inProgress > 1) {
        return { success: false, error: '最多只能有一个步骤为 in_progress' };
      }
      const record = {
        plan: a.plan,
        explanation: a.explanation ?? '',
        updatedAt: Date.now(),
      };
      sessionPlans.set(ctx.sessionId, record);
      const summary = a.plan
        .map((s, i) => {
          const icon = s.status === 'completed' ? '✅' : s.status === 'in_progress' ? '🔄' : '⏳';
          return `${icon} ${i + 1}. ${s.step}`;
        })
        .join('\n');
      ctx.broadcast('plan_updated', { sessionId: ctx.sessionId, ...record });
      return {
        success: true,
        output: summary,
        data: record,
      };
    },
  };

  return [
    memorySearchTool,
    memoryGetTool,
    memorySaveTool,
    knowledgeSearchTool,
    knowledgeAddTool,
    skillListTool,
    skillCreateTool,
    skillExecuteTool,
    updatePlanTool,
  ];
}

