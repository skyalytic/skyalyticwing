import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { AgentSwarmService } from '../../../../modules/ai/agent/agent-swarm.service.js';
import { AgentService } from '../../../../modules/ai/agent/agent.service.js';
import { ProviderService } from '../../../../modules/ai/llm/provider.service.js';
import { SandboxSystemService } from '../../../../modules/tools/sandbox/sandbox.service.js';
import { SessionService } from '../../../../modules/session/session.service.js';
import { PluginService } from '../../../../modules/tools/plugin/plugin.service.js';
import { jsonOut } from '../../reach/tools/agent-reach.js';

function fail(error: string): ToolResult {
  return { success: false, error };
}

/**
 * 平台域内置工具：蜂群子代理 / LLM 提供商配置 / 沙箱代码执行 / 会话与插件管理。
 *
 * - subagent_spawn_swarm：桥接 AgentSwarmService.spawnSwarm（并行创建+执行+汇总）
 * - provider_config：桥接 ProviderService（list/save/test，baseUrl 经 SSRF 守卫）
 * - code_execution：桥接 SandboxSystemService.executeSafe（命令经 CommandGuard，
 *   Docker 优先/进程白名单降级）；服务不可用时降级 execFile + CommandGuard 并明确提示
 * - session_create / session_status：桥接 SessionService
 * - plugin_list / plugin_toggle：桥接 PluginService
 * - sandbox_status：桥接 SandboxSystemService.getStatus
 *
 * 依赖服务均经 ServiceResolver 懒解析（非全局模块，避免循环实例化）。
 */
export function createPlatformTools(
  _security: SecurityManagerService,
  resolve: ServiceResolver,
): ToolDefinition[] {
  return [
    // ═══ subagent_spawn_swarm ═══
    {
      name: 'subagent_spawn_swarm',
      description:
        '蜂群调度：并行派生多个子代理执行任务并汇总结果（受最大并发 5 与嵌套深度 3 限制）。' +
        '父级默认为当前会话。全部完成后返回成功/失败计数与逐任务摘要。',
      category: 'agent',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string', description: '任务描述（简式）' },
                {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: '任务描述' },
                    prompt: { type: 'string', description: '初始指令（默认同 task）' },
                    type: { type: 'string', description: '任务类型（默认 worker）' },
                    model: { type: 'string', description: '指定模型（默认继承）' },
                    agentId: { type: 'string', description: '团队成员的专家 ID 或 slug，读取其保存的角色、模型与工具配置' },
                    systemPrompt: { type: 'string', description: '临时子任务角色；指定专家时使用该专家保存的角色' },
                  },
                },
              ],
            },
            description: '任务列表（字符串或对象）',
          },
          parentAgentId: { type: 'string', description: '父代理 ID（可选，默认当前会话）' },
        },
        required: ['tasks'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { tasks?: unknown; parentAgentId?: string };
        if (!Array.isArray(a.tasks) || a.tasks.length === 0) {
          return fail('Parameter "tasks" must be a non-empty array');
        }
        const swarm = resolve(AgentSwarmService);
        if (!swarm) return fail('AgentSwarmService 未初始化，蜂群调度不可用');
        const parent = a.parentAgentId || ctx.sessionId || 'main';
        try {
          if (ctx.sessionId && parent !== ctx.sessionId) return fail('只能向当前会话委派任务');
          const registry = resolve(AgentService);
          const session = resolve(SessionService)?.getSession(ctx.sessionId || '');
          const team = session?.agent?.startsWith('team:') ? registry?.getTeam(session.agent.slice(5)) : undefined;
          const tasks = a.tasks.map((raw) => {
            const task = typeof raw === 'string' ? { task: raw } : raw;
            if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('无效的子任务');
            const t = task as Record<string, unknown>;
            const id = typeof t['agentId'] === 'string' ? t['agentId'] : '';
            const expert = id ? registry?.listAgents().find((x) => x.id === id || x.slug?.toLowerCase() === id.toLowerCase()) : undefined;
            if (id && (!expert || expert.callable === false)) throw new Error(`专家不存在或未允许委派: ${id}`);
            if (team && (!expert || !team.memberIds.includes(expert.id))) throw new Error('团队任务必须指定可委派的团队成员 agentId');
            return {
              task: typeof t['task'] === 'string' ? t['task'] : '',
              prompt: typeof t['prompt'] === 'string' ? t['prompt'] : '',
              type: typeof t['type'] === 'string' ? t['type'] : 'worker',
              model: expert?.model || (typeof t['model'] === 'string' ? t['model'] : session?.model || ''),
              systemPrompt: expert ? expert.systemPrompt : typeof t['systemPrompt'] === 'string' ? t['systemPrompt'] : '',
              tools: expert?.tools.length ? [...expert.tools] : undefined,
              inheritTools: true,
              workspace: ctx.workspace || 'isolated',
            };
          });
          const r = await swarm.spawnSwarm(parent, tasks);
          return { ...jsonOut({
            parentAgentId: parent,
            totalTasks: r.totalTasks,
            completed: r.completed,
            failed: r.failed,
            results: r.results.map((x) => ({
              agentId: x.agentId,
              success: x.success,
              result: x.result ? x.result.substring(0, 1000) : undefined,
              error: x.error ? x.error.substring(0, 500) : undefined,
            })),
            summary: r.summary,
          }), success: r.success, ...(r.success ? {} : { error: '部分或全部子任务失败，请检查逐任务结果' }) };
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ provider_config ═══
    {
      name: 'provider_config',
      description:
        'LLM 提供商配置管理：list=列出全部提供商（含 configured 状态与模型）；' +
        'save=更新配置（apiKey/baseUrl/models，baseUrl 经 SSRF 校验）；' +
        'test=连通性测试（实际调用一次 LLM）；models=列出可用模型。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'save', 'test', 'models'],
            description: 'list=列表；save=保存配置；test=连通测试；models=模型列表',
          },
          providerId: { type: 'string', description: '提供商 ID（save/test 必填）' },
          config: {
            type: 'object',
            description: 'save 时的配置项（apiKey/baseUrl/models/displayName）',
          },
        },
        required: ['action'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as {
          action?: string;
          providerId?: string;
          config?: Record<string, unknown>;
        };
        const provider = resolve(ProviderService);
        if (!provider) return fail('ProviderService 未初始化，提供商配置不可用');
        const action = a.action || 'list';
        try {
          if (action === 'list') {
            return jsonOut(provider.listProviders());
          }
          if (action === 'models') {
            return jsonOut(provider.listModels());
          }
          if (action === 'save') {
            if (!a.providerId) return fail('save 需要 providerId');
            if (!a.config || typeof a.config !== 'object') return fail('save 需要 config 对象');
            const r = provider.updateProvider(a.providerId, a.config);
            return jsonOut({ ...r, providerId: a.providerId });
          }
          if (action === 'test') {
            if (!a.providerId) return fail('test 需要 providerId');
            const r = await provider.testProvider(a.providerId);
            return jsonOut({ providerId: a.providerId, ...r });
          }
          return fail(`未知 action: ${action}`);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ code_execution ═══
    {
      name: 'code_execution',
      description:
        '沙箱代码执行：命令先经命令守卫校验，Docker 可用时在隔离容器执行（内存/CPU/文件系统限制），' +
        '否则降级进程级白名单沙箱。沙箱服务不可用时降级直接执行（命令守卫仍生效）。',
      category: 'shell',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令（经命令守卫与沙箱策略）' },
          cwd: { type: 'string', description: '工作目录（可选，默认当前目录）' },
          timeout: { type: 'number', description: '超时毫秒（默认 30000）' },
        },
        required: ['command'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { command?: string; cwd?: string; timeout?: number };
        if (typeof a.command !== 'string' || a.command.length === 0) {
          return fail('Parameter "command" is required');
        }
        const sandbox = resolve(SandboxSystemService);
        if (sandbox) {
          try {
            const opts: { cwd?: string; timeout?: number } = {};
            if (typeof a.cwd === 'string') opts.cwd = a.cwd;
            if (typeof a.timeout === 'number') opts.timeout = a.timeout;
            const r = await sandbox.executeSafe(a.command, opts);
            return r.success ? jsonOut(r) : fail(r.error || '隔离执行失败');
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
        }
        return fail('隔离执行服务不可用，未在宿主机运行命令');
      },
    },

    // ═══ session_create ═══
    {
      name: 'session_create',
      description: '显式创建新会话（返回会话 ID/标题/时间戳），持久化到 sessions.json。',
      category: 'session',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '会话标题（可选，默认按时间生成）' },
        },
        required: [],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { title?: string };
        const session = resolve(SessionService);
        if (!session) return fail('SessionService 未初始化，会话创建不可用');
        try {
          const info = session.createSession(a.title);
          return jsonOut(info);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ session_status ═══
    {
      name: 'session_status',
      description:
        '查看会话状态：sessionId 指定时返回该会话信息（标题/消息数/时间戳），否则返回最近会话列表。',
      category: 'session',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '会话 ID（可选，缺省返回列表）' },
          limit: { type: 'number', description: '列表模式返回条数（默认 10）' },
        },
        required: [],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = (args || {}) as { sessionId?: string; limit?: number };
        const session = resolve(SessionService);
        if (!session) return fail('SessionService 未初始化，会话状态不可用');
        try {
          if (a.sessionId) {
            const item = session.getSession(a.sessionId);
            if (!item) return fail(`会话不存在: ${a.sessionId}`);
            return jsonOut({
              id: item.id,
              title: item.title,
              messageCount: item.messages.length,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              model: item.model,
              agent: item.agent,
              pinned: item.pinned,
            });
          }
          const limit = Math.max(1, Math.min(50, Math.floor(a.limit || 10)));
          const list = session.listSessions().slice(0, limit);
          return jsonOut({
            currentSessionId: ctx.sessionId,
            total: list.length,
            sessions: list,
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ plugin_list ═══
    {
      name: 'plugin_list',
      description: '列出全部已安装插件（名称/版本/启用与加载状态/提供的工具），不含插件配置。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const plugin = resolve(PluginService);
        if (!plugin) return fail('PluginService 未初始化，插件列表不可用');
        try {
          return jsonOut({ plugins: plugin.listPlugins() });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ plugin_toggle ═══
    {
      name: 'plugin_toggle',
      description: '启用/禁用插件（按 ID 或名称）。禁用后插件工具不再注册。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          pluginId: { type: 'string', description: '插件 ID 或名称' },
          enabled: { type: 'boolean', description: 'true=启用，false=禁用' },
        },
        required: ['pluginId', 'enabled'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { pluginId?: string; enabled?: boolean };
        if (typeof a.pluginId !== 'string' || a.pluginId.length === 0) {
          return fail('Parameter "pluginId" is required');
        }
        if (typeof a.enabled !== 'boolean') {
          return fail('Parameter "enabled" must be a boolean');
        }
        const plugin = resolve(PluginService);
        if (!plugin) return fail('PluginService 未初始化，插件切换不可用');
        try {
          const r = await plugin.togglePluginById(a.pluginId, a.enabled);
          if (r === null) return fail(`插件不存在: ${a.pluginId}`);
          return jsonOut({ pluginId: a.pluginId, enabled: r });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sandbox_status ═══
    {
      name: 'sandbox_status',
      description: '查看沙箱执行系统状态（模式/是否 Docker 可用/白名单与阻断规则计数）。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const sandbox = resolve(SandboxSystemService);
        if (!sandbox) return fail('SandboxSystemService 未初始化，沙箱状态不可用');
        try {
          return jsonOut(sandbox.getStatus());
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
