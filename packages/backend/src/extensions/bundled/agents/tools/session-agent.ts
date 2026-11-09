import type { ToolDefinition, ToolResult, ToolContext, ChatMessage } from '@skyalyticwing/shared';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { AgentMessageService } from '../../../../modules/ai/agent/agent-message.service.js';
import {
  AgentSwarmService,
  type SubAgent,
} from '../../../../modules/ai/agent/agent-swarm.service.js';
import { SubagentService } from '../../../../modules/ai/agent/subagent.service.js';
import { SessionService } from '../../../../modules/session/session.service.js';

/** sessions_spawn 默认超时（毫秒），对齐旧版 120s */
const SPAWN_DEFAULT_TIMEOUT_MS = 120_000;

/** 通用结果包装：结构化数据放 data，序列化文本放 output */
function ok(data: unknown, note?: string): ToolResult {
  return {
    success: true,
    data,
    output: JSON.stringify(note ? { ...((data as object) || {}), note } : data, null, 2),
  };
}

function fail(error: string): ToolResult {
  return { success: false, error };
}

/** 构造一条 ChatMessage */
function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

/**
 * 跨会话协作 / 子代理域内置工具（移植自旧版 session-agent.cjs）。
 *
 * 依赖服务经 ServiceResolver 懒解析（AgentMessageService / SessionService /
 * AgentSwarmService / SubagentService 均位于非全局模块，且与 ToolExecutorService
 * 存在反向注入关系，构造期直连会形成循环依赖，故执行期解析）。
 *
 * 会话上下文：executor 调用工具时 ToolContext.sessionId 即当前会话/代理 ID，
 * 作为 agent_send 的发送方、子代理的父级使用；跨会话目标一律显式传参。
 */
export function createSessionAgentTools(resolve: ServiceResolver): ToolDefinition[] {
  return [
    // ═══ agent_send ═══
    {
      name: 'agent_send',
      description:
        '向其他代理发送消息（母代理间协作通信）。消息投递到目标代理收件箱并广播 agent_message 事件。' +
        '发送方默认为当前会话 ID，可通过 fromAgentId 显式指定。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          toAgentId: { type: 'string', description: '目标代理 ID' },
          message: { type: 'string', description: '消息内容' },
          type: {
            type: 'string',
            enum: ['text', 'task', 'query', 'response', 'notification'],
            description: '消息类型（默认 text）',
          },
          fromAgentId: { type: 'string', description: '发送方代理 ID（可选，默认当前会话）' },
        },
        required: ['toAgentId', 'message'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = args as {
          toAgentId?: string;
          message?: string;
          type?: string;
          fromAgentId?: string;
        };
        if (!a || typeof a.toAgentId !== 'string' || a.toAgentId.length === 0) {
          return fail('Parameter "toAgentId" is required');
        }
        if (typeof a.message !== 'string' || a.message.length === 0) {
          return fail('Parameter "message" is required');
        }
        const messenger = resolve(AgentMessageService);
        if (!messenger) return fail('AgentMessageService 未初始化，跨代理信箱不可用');
        const from = a.fromAgentId || ctx.sessionId || 'main';
        try {
          const r = messenger.send(from, a.toAgentId, a.message, a.type || 'text');
          if (!r.success) return fail(r.error || '发送失败');
          return ok({ msgId: r.msgId, delivered: r.delivered, from, to: a.toAgentId });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ agent_inbox ═══
    {
      name: 'agent_inbox',
      description: '查看代理收件箱：获取其他代理发来的消息（含未读），可只看未读并可标记已读。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '代理 ID（可选，默认当前会话）' },
          unreadOnly: { type: 'boolean', description: '仅显示未读消息，默认 false' },
          markRead: { type: 'boolean', description: '获取后标记为已读，默认 false' },
        },
        required: [],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { agentId?: string; unreadOnly?: boolean; markRead?: boolean };
        const messenger = resolve(AgentMessageService);
        if (!messenger) return fail('AgentMessageService 未初始化，跨代理信箱不可用');
        const agentId = a.agentId || ctx.sessionId || 'main';
        try {
          const msgs = a.unreadOnly
            ? messenger.getUnread(agentId)
            : messenger.getInbox(agentId).messages;
          let marked = 0;
          if (a.markRead && msgs.length > 0) {
            marked = messenger.markRead(agentId).marked;
          }
          return ok({
            agentId,
            messages: msgs,
            unreadCount: messenger.getUnread(agentId).length,
            markedRead: marked,
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ agent_message_read ═══
    {
      name: 'agent_message_read',
      description:
        '读取代理收件箱中的指定消息详情（按 msgId），并可顺带标记已读。' +
        '不传 msgId 时返回最近一条未读消息。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          msgId: { type: 'string', description: '消息 ID（可选，缺省取最近一条未读）' },
          agentId: { type: 'string', description: '代理 ID（可选，默认当前会话）' },
          markRead: { type: 'boolean', description: '读取后标记为已读，默认 true' },
        },
        required: [],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { msgId?: string; agentId?: string; markRead?: boolean };
        const messenger = resolve(AgentMessageService);
        if (!messenger) return fail('AgentMessageService 未初始化，跨代理信箱不可用');
        const agentId = a.agentId || ctx.sessionId || 'main';
        try {
          const inbox = messenger.getInbox(agentId).messages;
          let msg = a.msgId
            ? inbox.find((m) => m.id === a.msgId)
            : [...inbox].reverse().find((m) => !m.read);
          if (!msg && a.msgId) return fail(`消息不存在: ${a.msgId}`);
          if (!msg) return ok({ agentId, message: null, note: '收件箱为空（或无未读消息）' });
          if (a.markRead !== false) {
            messenger.markRead(agentId, msg.id);
            msg = { ...msg, read: true };
          }
          return ok({ agentId, message: msg });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sessions_list ═══
    {
      name: 'sessions_list',
      description: '列出所有会话（ID、标题、消息数、更新时间，按更新时间倒序）。',
      category: 'session',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const sessions = resolve(SessionService);
        if (!sessions) return fail('SessionService 未初始化');
        try {
          const list = sessions.listSessions();
          return ok({ total: list.length, sessions: list });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sessions_read ═══
    {
      name: 'sessions_read',
      description: '读取指定会话的历史消息（可按角色过滤、限制条数，从最新往前取）。',
      category: 'session',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 ID' },
          limit: { type: 'number', description: '返回最近 N 条消息，默认 20' },
          role: {
            type: 'string',
            enum: ['user', 'assistant', 'system', 'tool'],
            description: '按角色过滤（可选）',
          },
        },
        required: ['sessionId'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { sessionId?: string; limit?: number; role?: ChatMessage['role'] };
        if (!a || typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
          return fail('Parameter "sessionId" is required');
        }
        const sessions = resolve(SessionService);
        if (!sessions) return fail('SessionService 未初始化');
        try {
          if (!sessions.getSession(a.sessionId)) return fail(`会话不存在: ${a.sessionId}`);
          const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 20;
          let msgs = sessions.getMessages(a.sessionId, limit);
          if (a.role) msgs = msgs.filter((m) => m.role === a.role);
          return ok({
            sessionId: a.sessionId,
            total: sessions.getMessages(a.sessionId).length,
            messages: msgs.map((m) => ({
              role: m.role,
              content: String(m.content || '').slice(0, 500),
              timestamp: m.timestamp,
            })),
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sessions_send ═══
    {
      name: 'sessions_send',
      description:
        '向其他会话投递一条消息（跨会话通信）。消息以用户角色写入目标会话，' +
        '目标会话的 Agent 在下一轮交互时处理。会话不存在时自动创建。',
      category: 'session',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 ID' },
          message: { type: 'string', description: '消息内容' },
          fromAgent: { type: 'string', description: '发送方标识（可选，附加在消息头）' },
        },
        required: ['sessionId', 'message'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { sessionId?: string; message?: string; fromAgent?: string };
        if (!a || typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
          return fail('Parameter "sessionId" is required');
        }
        if (typeof a.message !== 'string' || a.message.length === 0) {
          return fail('Parameter "message" is required');
        }
        const sessions = resolve(SessionService);
        if (!sessions) return fail('SessionService 未初始化');
        try {
          const content = a.fromAgent ? `[from:${a.fromAgent}] ${a.message}` : a.message;
          sessions.addMessage(a.sessionId, makeMessage('user', content));
          return ok({ sessionId: a.sessionId, sent: true });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sessions_reply ═══
    {
      name: 'sessions_reply',
      description:
        '以助手角色向指定会话追加一条回复（跨会话应答，不触发目标会话的 Agent 循环）。' +
        '适用于代理代答/结果回写场景。',
      category: 'session',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '目标会话 ID' },
          message: { type: 'string', description: '回复内容' },
          fromAgent: { type: 'string', description: '回复方标识（可选，附加在回复头）' },
        },
        required: ['sessionId', 'message'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { sessionId?: string; message?: string; fromAgent?: string };
        if (!a || typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
          return fail('Parameter "sessionId" is required');
        }
        if (typeof a.message !== 'string' || a.message.length === 0) {
          return fail('Parameter "message" is required');
        }
        const sessions = resolve(SessionService);
        if (!sessions) return fail('SessionService 未初始化');
        try {
          const content = a.fromAgent ? `[reply:${a.fromAgent}] ${a.message}` : a.message;
          sessions.addMessage(a.sessionId, makeMessage('assistant', content));
          return ok({ sessionId: a.sessionId, replied: true });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sessions_spawn ═══
    {
      name: 'sessions_spawn',
      description:
        '在隔离会话中执行一个独立 AI 任务（不打扰当前会话上下文），完成后直接返回结果。' +
        '适用于并行处理独立子任务。桥接 SubagentService.executeIsolated。',
      category: 'session',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '任务描述（将作为隔离会话的用户输入）' },
          model: { type: 'string', description: '使用的模型（可选，默认全局默认模型）' },
          systemPrompt: { type: 'string', description: '隔离会话 system prompt（可选）' },
          timeout: { type: 'number', description: '超时秒数，默认 120' },
        },
        required: ['message'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = args as {
          message?: string;
          model?: string;
          systemPrompt?: string;
          timeout?: number;
        };
        if (!a || typeof a.message !== 'string' || a.message.length === 0) {
          return fail('Parameter "message" is required');
        }
        const subagent = resolve(SubagentService);
        if (!subagent) return fail('SubagentService 未初始化，隔离执行不可用');
        const timeoutMs =
          typeof a.timeout === 'number' && a.timeout > 0
            ? Math.floor(a.timeout * 1000)
            : SPAWN_DEFAULT_TIMEOUT_MS;
        try {
          const result = await Promise.race([
            subagent.executeIsolated(a.message, {
              ...(a.model ? { model: a.model } : {}),
              ...(a.systemPrompt ? { systemPrompt: a.systemPrompt } : {}),
              sessionId: ctx.sessionId,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Spawn timeout (${timeoutMs}ms)`)), timeoutMs),
            ),
          ]);
          if (!result.success) return fail(result.error || 'Spawn 执行失败');
          return ok({
            output: result.output,
            iterations: result.iterations,
            durationMs: result.durationMs,
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ subagent_execute ═══
    {
      name: 'subagent_execute',
      description:
        '创建一个子代理同步执行任务：子代理拥有独立工作区与上下文，由真实 LLM 驱动，' +
        '完成后结果直接返回并按配置自动销毁。工具名与 agent-swarm.service 的嵌套特判路径对齐。',
      category: 'agent',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '任务简短标题' },
          prompt: { type: 'string', description: '详细任务指令（缺省用 task）' },
          model: { type: 'string', description: '模型（可选）' },
          type: {
            type: 'string',
            enum: ['worker', 'researcher', 'coder', 'writer'],
            description: '任务类型（默认 worker）',
          },
          autoDestroy: { type: 'boolean', description: '完成后自动销毁（默认 true）' },
          workspace: {
            type: 'string',
            enum: ['isolated', 'shared'],
            description:
              '默认 isolated；远程 Git 项目使用独立 worktree。只有明确协作同一目录时选择 shared。',
          },
        },
        required: ['task'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as {
          task?: string;
          prompt?: string;
          model?: string;
          type?: string;
          autoDestroy?: boolean;
          workspace?: 'isolated' | 'shared';
        };
        if (typeof a.task !== 'string' || a.task.length === 0) {
          return fail('Parameter "task" is required');
        }
        const swarm = resolve(AgentSwarmService);
        if (!swarm) return fail('AgentSwarmService 未初始化，子代理不可用');
        const parent = ctx.sessionId || 'main';
        try {
          ctx.log('info', `subagent_execute: parent=${parent} task=${a.task.slice(0, 60)}`);
          const created = swarm.createSubAgent(parent, {
            task: a.task,
            prompt: a.prompt || a.task,
            model: a.model || '',
            type: a.type || 'worker',
            autoDestroy: a.autoDestroy !== false,
            workspace: a.workspace === 'shared' ? 'shared' : 'isolated',
            inheritTools: true,
          });
          if (created.id === null) {
            return fail(`子代理创建失败: ${created.error || '未知错误'}`);
          }
          const r = await swarm.executeSync(created.id);
          if (!r.success)
            return {
              ...fail(r.error || '子代理执行失败'),
              ...(r.remoteWorkspace ? { data: { remoteWorkspace: r.remoteWorkspace } } : {}),
            };
          return ok({
            agentId: r.agentId,
            output: r.result || '',
            ...(r.remoteWorkspace ? { remoteWorkspace: r.remoteWorkspace } : {}),
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ subagents ═══
    {
      name: 'subagents',
      description: '管理子代理：列出全部子代理、查看单个状态、或终止指定子代理。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'status', 'terminate'],
            description: 'list=列出全部；status=单个状态；terminate=终止',
          },
          agentId: { type: 'string', description: '子代理 ID（status/terminate 必填）' },
        },
        required: ['action'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { action?: string; agentId?: string };
        const swarm = resolve(AgentSwarmService);
        if (!swarm) return fail('AgentSwarmService 未初始化，子代理不可用');
        const action = a.action || 'list';
        try {
          if (action === 'list') {
            const agents = swarm.listActiveAgents().map((s) => ({
              id: s.id,
              parentId: s.parentId,
              type: s.type,
              status: s.status,
              task: s.task,
              createdAt: s.createdAt,
            }));
            return ok({
              total: agents.length,
              running: swarm.getRunningCount(),
              subagents: agents,
            });
          }
          if (typeof a.agentId !== 'string' || a.agentId.length === 0) {
            return fail(`action=${action} 需要 agentId 参数`);
          }
          if (action === 'status') {
            const s = swarm.getAgentStatus(a.agentId);
            if (!s) return fail(`子代理不存在: ${a.agentId}`);
            return ok(s);
          }
          if (action === 'terminate') {
            const r = swarm.destroyAgent(a.agentId);
            if (!r.success) return fail(r.error || `终止失败: ${a.agentId}`);
            return ok({ terminated: a.agentId });
          }
          return fail(`Unknown action: ${action}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ subagent_create ═══
    {
      name: 'subagent_create',
      description:
        '创建一个子代理（仅创建不执行）。返回 agentId 后可用 subagent_execute 的调度体系、' +
        'subagents status 查看状态，或由蜂群调度统一派发。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '任务简短标题' },
          prompt: { type: 'string', description: '详细任务指令（可选）' },
          model: { type: 'string', description: '模型（可选）' },
          type: {
            type: 'string',
            enum: ['worker', 'researcher', 'coder', 'writer'],
            description: '任务类型（默认 worker）',
          },
          autoDestroy: { type: 'boolean', description: '完成后自动销毁（默认 true）' },
        },
        required: ['task'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as {
          task?: string;
          prompt?: string;
          model?: string;
          type?: string;
          autoDestroy?: boolean;
        };
        if (typeof a.task !== 'string' || a.task.length === 0) {
          return fail('Parameter "task" is required');
        }
        const swarm = resolve(AgentSwarmService);
        if (!swarm) return fail('AgentSwarmService 未初始化，子代理不可用');
        try {
          const created = swarm.createSubAgent(ctx.sessionId || 'main', {
            task: a.task,
            prompt: a.prompt || '',
            model: a.model || '',
            type: a.type || 'worker',
            autoDestroy: a.autoDestroy !== false,
          });
          if (created.id === null) return fail(`子代理创建失败: ${created.error || '未知错误'}`);
          const agent = created as SubAgent;
          return ok({
            agentId: agent.id,
            status: agent.status,
            type: agent.type,
            depth: agent.depth,
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ subagent_status ═══
    {
      name: 'subagent_status',
      description: '查询指定子代理的详细状态（状态机、任务、结果、时间戳等）。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '子代理 ID' },
        },
        required: ['agentId'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { agentId?: string };
        if (!a || typeof a.agentId !== 'string' || a.agentId.length === 0) {
          return fail('Parameter "agentId" is required');
        }
        const swarm = resolve(AgentSwarmService);
        if (!swarm) return fail('AgentSwarmService 未初始化，子代理不可用');
        try {
          const s = swarm.getAgentStatus(a.agentId);
          if (!s) return fail(`子代理不存在: ${a.agentId}`);
          return ok(s);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
