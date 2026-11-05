import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { CronService, type CronJobConfig, type DeliveryConfig } from '../../../../modules/channels/cron/cron.service.js';
import { McpService, type McpServerInfo } from '../../../../modules/tools/mcp/mcp.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

interface CronCreateArgs {
  name: string;
  expression?: string;
  executeAt?: string;
  delayMinutes?: number;
  taskType: 'shell' | 'ai' | 'browser' | 'webhook' | 'tool';
  command: string;
  url?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  model?: string;
  enabled?: boolean;
  /** 长期任务总目标（AI 任务传入后启用状态追踪：跨轮注入进度与历史，7×24 自动执行） */
  goal?: string;
  /** 长期任务最大轮次（0/缺省=无限制，达到后自动收尾） */
  maxRounds?: number;
}

interface CronJobIdArgs {
  jobId: string;
}

interface CronToggleArgs extends CronJobIdArgs {
  enabled: boolean;
}

interface CronUpdateArgs extends Partial<CronCreateArgs> {
  jobId: string;
}

interface CronDeliveryArgs extends CronJobIdArgs {
  mode: 'none' | 'announce' | 'webhook';
  channel?: string;
  to?: string;
  webhookUrl?: string;
  failureAlert?: { after?: number; channel?: string; cooldownMs?: number };
}

interface McpCallArgs {
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

interface McpServerNameArgs {
  serverName: string;
}

interface McpResourceArgs {
  server?: string;
}

interface McpResourceReadArgs {
  server: string;
  uri: string;
}

interface McpLoopbackStartArgs {
  port?: number;
}

interface McpConversationsArgs {
  channel?: string;
  search?: string;
  limit?: number;
}

/** 按名称或ID解析 MCP 服务器ID（找不到返回 null） */
function resolveMcpServerId(mcp: McpService, nameOrId: string): string | null {
  const servers = mcp.listServers();
  const byId = servers.find((s) => s.id === nameOrId);
  if (byId) return byId.id;
  const byName = servers.find((s) => s.name === nameOrId);
  return byName ? byName.id : null;
}

/**
 * cron-mcp 域工具（17个）：
 *   cron_create / cron_update / cron_delete / cron_list / cron_toggle /
 *   cron_run_now / cron_delivery                    → CronService
 *   mcp_list / mcp_start / mcp_stop / mcp_call /
 *   mcp_resources / mcp_resource_read /
 *   mcp_loopback_start / mcp_loopback_status / mcp_loopback_stop /
 *   mcp_conversations_list                          → McpService
 */
export function createCronMcpTools(resolve: ServiceResolver): ToolDefinition[] {
  /** CronService / McpService 懒解析（首次执行时解析并缓存） */
  let cronCache: CronService | undefined;
  let cronResolved = false;
  const getCron = (): CronService | undefined => {
    if (!cronResolved) {
      cronCache = resolve(CronService);
      cronResolved = true;
    }
    return cronCache;
  };
  let mcpCache: McpService | undefined;
  let mcpResolved = false;
  const getMcp = (): McpService | undefined => {
    if (!mcpResolved) {
      mcpCache = resolve(McpService);
      mcpResolved = true;
    }
    return mcpCache;
  };

  const cronCreateTool: ToolDefinition = {
    name: 'cron_create',
    description:
      '创建定时任务。三种时间设置(三选一)：expression=周期cron表达式；executeAt=一次性ISO时间；delayMinutes=几分钟后执行(一次性)。重要：用户要"现在/马上"做的事直接用对应工具执行，不要建定时任务；只有明确说"定时/计划/稍后/X分钟后"才用本工具。' +
      '长期任务（如"跟踪一周股价""持续监控直到完成"）：taskType=ai 且传 goal（总目标）与可选 maxRounds，任务将 7×24 自动执行，每轮自动带上之前的进度与历史，AI 每轮通过 [STATUS]/[PROGRESS]/[NEXT]/[SCHEDULE] 协议自主续排，done 后自动收尾。' +
      '例:{name:"每日天气",expression:"0 9 * * *",taskType:"ai",command:"查询天气"}；{name:"股价跟踪",expression:"0 */2 * * *",taskType:"ai",command:"检查股价异动",goal:"跟踪本周股价并每周五汇总",maxRounds:60}；{name:"打开B站",delayMinutes:5,taskType:"browser",command:"打开https://bilibili.com"}',
    category: 'cron',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称' },
        expression: { type: 'string', description: '[周期性]cron表达式(分 时 日 月 周)，如"0 9 * * *"=每天9点。与executeAt/delayMinutes三选一' },
        executeAt: { type: 'string', description: '[一次性]ISO时间，如"2026-04-11T20:00:00"，执行一次后自动停用' },
        delayMinutes: { type: 'number', description: '[一次性]几分钟后执行，如5=5分钟后' },
        taskType: { type: 'string', enum: ['shell', 'ai', 'browser', 'webhook', 'tool'], description: 'shell=命令, ai=AI任务, browser=浏览器, webhook=HTTP回调, tool=指定工具' },
        command: { type: 'string', description: '任务内容：shell填命令/ai填提示词/browser填URL或描述/webhook填URL' },
        toolName: { type: 'string', description: '工具名（仅taskType=tool时必填）' },
        toolArgs: { type: 'object', description: '工具参数JSON（仅taskType=tool时使用）' },
        model: { type: 'string', description: 'AI任务使用的模型（可选）' },
        goal: { type: 'string', description: '[AI长期任务]总目标（启用状态追踪：每轮注入进度与历史，AI 自主续排，done 自动收尾）' },
        maxRounds: { type: 'number', description: '[AI长期任务]最大轮次（可选，0/缺省=无限制）' },
        enabled: { type: 'boolean', description: '是否立即启用（默认true）' },
      },
      required: ['name', 'taskType', 'command'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as CronCreateArgs;
      if (!a || typeof a.name !== 'string' || a.name.length === 0) {
        return { success: false, error: 'Parameter "name" is required' };
      }
      if (!a.taskType || !a.command) {
        return { success: false, error: 'Parameters "taskType" and "command" are required' };
      }
      const timeSources = [a.expression, a.executeAt, a.delayMinutes].filter(
        (v) => v !== undefined && v !== null && v !== '',
      );
      if (timeSources.length === 0) {
        return { success: false, error: '需提供 expression / executeAt / delayMinutes 之一' };
      }
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        let expression: string | undefined;
        let schedule: { kind: 'at'; at: string } | undefined;
        let runOnce = false;
        if (a.expression) {
          expression = a.expression;
        } else if (a.executeAt) {
          const at = new Date(a.executeAt);
          if (isNaN(at.getTime())) {
            return { success: false, error: `无效的 executeAt 时间: ${a.executeAt}` };
          }
          schedule = { kind: 'at', at: a.executeAt };
          runOnce = true;
        } else {
          const minutes = a.delayMinutes ?? 0;
          if (!Number.isFinite(minutes) || minutes <= 0) {
            return { success: false, error: 'delayMinutes 必须为正数' };
          }
          schedule = { kind: 'at', at: new Date(Date.now() + minutes * 60_000).toISOString() };
          runOnce = true;
        }
        const result = cron.addJob({
          id: '', // 由 CronService 自动生成 jobId
          name: a.name,
          runOnce,
          taskType: a.taskType,
          command: a.command,
          enabled: a.enabled !== false,
          ...(expression !== undefined ? { expression } : {}),
          ...(schedule !== undefined ? { schedule } : {}),
          ...(typeof a.url === 'string' ? { url: a.url } : {}),
          ...(typeof a.toolName === 'string' ? { toolName: a.toolName } : {}),
          ...(a.toolArgs !== undefined && a.toolArgs !== null ? { toolArgs: a.toolArgs } : {}),
          ...(typeof a.model === 'string' ? { model: a.model } : {}),
          // 长期任务：goal/maxRounds 任一给出即启用状态追踪（跨轮进度注入 + 续排协议）
          ...(a.taskType === 'ai' && (a.goal || a.maxRounds)
            ? {
                longRunning: {
                  ...(a.goal ? { goal: a.goal } : { goal: a.command }),
                  ...(a.maxRounds ? { maxRounds: a.maxRounds } : {}),
                  round: 0,
                  history: [],
                },
              }
            : {}),
        });
        if (!result.success) {
          return { success: false, error: result.error ?? '创建失败' };
        }
        return {
          success: true,
          output: `定时任务已创建: ${a.name} (id=${result.jobId})`,
          data: { jobId: result.jobId },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const cronUpdateTool: ToolDefinition = {
    name: 'cron_update',
    description: '更新定时任务（名称/调度/命令/启停等，仅传需修改的字段）。从 cron_list 获取 jobId。',
    category: 'cron',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务ID' },
        name: { type: 'string', description: '新任务名称' },
        expression: { type: 'string', description: '新cron表达式（周期性）' },
        executeAt: { type: 'string', description: '新一次性执行时间（ISO）' },
        delayMinutes: { type: 'number', description: '从现在起几分钟后执行（一次性）' },
        taskType: { type: 'string', enum: ['shell', 'ai', 'browser', 'webhook', 'tool'], description: '任务类型' },
        command: { type: 'string', description: '任务内容' },
        model: { type: 'string', description: 'AI任务模型' },
        toolName: { type: 'string', description: '工具名（taskType=tool）' },
        toolArgs: { type: 'object', description: '工具参数' },
        enabled: { type: 'boolean', description: '是否启用' },
      },
      required: ['jobId'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as CronUpdateArgs;
      if (!a || !a.jobId) {
        return { success: false, error: 'Parameter "jobId" is required' };
      }
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        const updates: Partial<CronJobConfig> = {};
        if (a.name !== undefined) updates.name = a.name;
        if (a.command !== undefined) updates.command = a.command;
        if (a.model !== undefined) updates.model = a.model;
        if (a.toolName !== undefined) updates.toolName = a.toolName;
        if (a.toolArgs !== undefined && a.toolArgs !== null) updates.toolArgs = a.toolArgs;
        if (a.enabled !== undefined) updates.enabled = a.enabled;
        if (a.taskType !== undefined) updates.taskType = a.taskType;
        if (a.expression !== undefined) {
          updates.expression = a.expression;
          updates.runOnce = false;
        } else if (a.executeAt !== undefined) {
          const at = new Date(a.executeAt);
          if (isNaN(at.getTime())) {
            return { success: false, error: `无效的 executeAt: ${a.executeAt}` };
          }
          updates.schedule = { kind: 'at', at: a.executeAt };
          updates.runOnce = true;
        } else if (a.delayMinutes !== undefined) {
          const minutes = a.delayMinutes;
          if (!Number.isFinite(minutes) || minutes <= 0) {
            return { success: false, error: 'delayMinutes 必须为正数' };
          }
          updates.schedule = { kind: 'at', at: new Date(Date.now() + minutes * 60_000).toISOString() };
          updates.runOnce = true;
        }
        const result = cron.updateJob(a.jobId, updates);
        if (!result.success) {
          return { success: false, error: result.error ?? '更新失败' };
        }
        return { success: true, output: `定时任务已更新: ${a.jobId}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const cronDeleteTool: ToolDefinition = {
    name: 'cron_delete',
    description: '删除指定定时任务（系统内置任务不可删除）。',
    category: 'cron',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '要删除的任务ID（从cron_list获取）' } },
      required: ['jobId'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as CronJobIdArgs;
      if (!a || !a.jobId) return { success: false, error: 'Parameter "jobId" is required' };
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        const r = cron.deleteJob(a.jobId);
        return r.success
          ? { success: true, output: `定时任务已删除: ${a.jobId}` }
          : { success: false, error: r.error ?? '删除失败' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const cronListTool: ToolDefinition = {
    name: 'cron_list',
    description: '列出所有定时任务及其状态（调度/启停/上次结果/下次执行时间）。',
    category: 'cron',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        const jobs = cron.listJobs();
        return {
          success: true,
          output: jobs.length === 0 ? '（无定时任务）' : JSON.stringify(jobs, null, 2),
          data: { jobs, total: jobs.length },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const cronToggleTool: ToolDefinition = {
    name: 'cron_toggle',
    description: '启用或禁用定时任务。',
    category: 'cron',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务ID' },
        enabled: { type: 'boolean', description: 'true=启用, false=禁用' },
      },
      required: ['jobId', 'enabled'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as CronToggleArgs;
      if (!a || !a.jobId || typeof a.enabled !== 'boolean') {
        return { success: false, error: 'Parameters "jobId" and "enabled" are required' };
      }
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        const r = cron.toggleJob(a.jobId, a.enabled);
        return r.success
          ? { success: true, output: `任务已${a.enabled ? '启用' : '禁用'}: ${a.jobId}` }
          : { success: false, error: r.error ?? '操作失败' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const cronRunNowTool: ToolDefinition = {
    name: 'cron_run_now',
    description: '立即执行一次定时任务（不等下次计划时间）。返回任务执行结果摘要。',
    category: 'cron',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '要立即执行的任务ID' } },
      required: ['jobId'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as CronJobIdArgs;
      if (!a || !a.jobId) return { success: false, error: 'Parameter "jobId" is required' };
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        const r = await cron.runJob(a.jobId);
        return r.success
          ? { success: true, output: `任务已触发执行: ${a.jobId}（${r.message ?? ''}）` }
          : { success: false, error: r.error ?? '触发失败' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const cronDeliveryTool: ToolDefinition = {
    name: 'cron_delivery',
    description: '设置定时任务的交付方式（none/announce频道通知/webhook回调）与失败告警配置。',
    category: 'cron',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '定时任务ID' },
        mode: { type: 'string', enum: ['none', 'announce', 'webhook'], description: '交付模式' },
        channel: { type: 'string', description: '通知渠道（announce模式）' },
        to: { type: 'string', description: '通知目标（频道/用户ID）' },
        webhookUrl: { type: 'string', description: 'Webhook URL（webhook模式，经SSRF校验）' },
        failureAlert: {
          type: 'object',
          properties: {
            after: { type: 'number', description: '连续失败N次后告警' },
            channel: { type: 'string', description: '告警渠道' },
            cooldownMs: { type: 'number', description: '告警冷却期毫秒' },
          },
          description: '失败告警配置',
        },
      },
      required: ['jobId', 'mode'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as CronDeliveryArgs;
      if (!a || !a.jobId || !a.mode) {
        return { success: false, error: 'Parameters "jobId" and "mode" are required' };
      }
      const cron = getCron();
      if (!cron) {
        return { success: false, error: '定时任务服务不可用（CronModule 未加载）' };
      }
      try {
        const delivery: DeliveryConfig = {
          mode: a.mode,
          ...(a.channel !== undefined ? { channel: a.channel } : {}),
          ...(a.to !== undefined ? { threadId: a.to } : {}),
          ...(a.webhookUrl !== undefined ? { url: a.webhookUrl, webhookUrl: a.webhookUrl } : {}),
        };
        const r = cron.updateJob(a.jobId, {
          delivery,
          ...(a.failureAlert !== undefined ? { failureAlert: a.failureAlert } : {}),
        });
        return r.success
          ? { success: true, output: `交付方式已设置: ${a.jobId} → ${a.mode}` }
          : { success: false, error: r.error ?? '设置失败' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpListTool: ToolDefinition = {
    name: 'mcp_list',
    description: '列出所有已配置的MCP服务器及其状态（ID/名称/命令/启停/运行状态）与回环服务状态。',
    category: 'mcp',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const servers: McpServerInfo[] = mcp.listServers();
        const summary = mcp.getStatusSummary();
        return {
          success: true,
          output: servers.length === 0 ? '（未配置MCP服务器）' : JSON.stringify(servers, null, 2),
          data: { servers, summary },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpStartTool: ToolDefinition = {
    name: 'mcp_start',
    description: '启动一个MCP服务器以获取外部工具能力（spawn子进程并完成握手）。',
    category: 'mcp',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { serverName: { type: 'string', description: 'MCP服务器名称或ID（从mcp_list获取）' } },
      required: ['serverName'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpServerNameArgs;
      if (!a || !a.serverName) return { success: false, error: 'Parameter "serverName" is required' };
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const id = resolveMcpServerId(mcp, a.serverName);
        if (!id) return { success: false, error: `MCP服务器未找到: ${a.serverName}（用 mcp_list 查看）` };
        await mcp.startServer(id);
        return { success: true, output: `MCP服务器已启动: ${a.serverName}` };
      } catch (err) {
        return { success: false, error: `MCP服务器启动失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  const mcpStopTool: ToolDefinition = {
    name: 'mcp_stop',
    description: '停止一个MCP服务器（终止子进程，配置保留）。',
    category: 'mcp',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { serverName: { type: 'string', description: 'MCP服务器名称或ID' } },
      required: ['serverName'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpServerNameArgs;
      if (!a || !a.serverName) return { success: false, error: 'Parameter "serverName" is required' };
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const id = resolveMcpServerId(mcp, a.serverName);
        if (!id) return { success: false, error: `MCP服务器未找到: ${a.serverName}` };
        mcp.stopServer(id);
        return { success: true, output: `MCP服务器已停止: ${a.serverName}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpCallTool: ToolDefinition = {
    name: 'mcp_call',
    description:
      '调用MCP服务器上的扩展工具。先用 mcp_list 查看服务器与状态（需已启动），工具名以服务器文档为准。',
    category: 'mcp',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'MCP服务器ID（从mcp_list获取）' },
        toolName: { type: 'string', description: '要调用的工具名称' },
        args: { type: 'object', description: '工具参数（JSON对象）' },
      },
      required: ['serverId', 'toolName'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpCallArgs;
      if (!a || !a.serverId || !a.toolName) {
        return { success: false, error: 'Parameters "serverId" and "toolName" are required' };
      }
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        return await mcp.callTool(a.serverId, a.toolName, a.args ?? {});
      } catch (err) {
        return { success: false, error: `MCP调用失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  const mcpResourcesTool: ToolDefinition = {
    name: 'mcp_resources',
    description: '列出MCP服务器提供的可用资源（文件/数据等）。不传server则列出所有服务器的资源。',
    category: 'mcp',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { server: { type: 'string', description: 'MCP服务器ID或名称（可选，留空列出所有）' } },
      required: [],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpResourceArgs;
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const targets: string[] = [];
        if (a.server) {
          const id = resolveMcpServerId(mcp, a.server);
          if (!id) return { success: false, error: `MCP服务器未找到: ${a.server}` };
          targets.push(id);
        } else {
          for (const s of mcp.listServers()) targets.push(s.id);
        }
        const all: Record<string, unknown> = {};
        let errors = 0;
        for (const id of targets) {
          const r = await mcp.listResources(id);
          all[id] = r.resources;
          if (r.error) errors += 1;
        }
        return {
          success: true,
          output: JSON.stringify(all, null, 2),
          data: { resources: all, errorServers: errors },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpResourceReadTool: ToolDefinition = {
    name: 'mcp_resource_read',
    description: '读取MCP服务器上的特定资源（需服务器已启动）。',
    category: 'mcp',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP服务器ID或名称' },
        uri: { type: 'string', description: '资源URI（从mcp_resources获取）' },
      },
      required: ['server', 'uri'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpResourceReadArgs;
      if (!a || !a.server || !a.uri) {
        return { success: false, error: 'Parameters "server" and "uri" are required' };
      }
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const id = resolveMcpServerId(mcp, a.server);
        if (!id) return { success: false, error: `MCP服务器未找到: ${a.server}` };
        const r = await mcp.readResource(id, a.uri);
        if (!r.success) return { success: false, error: r.error ?? '读取失败' };
        return {
          success: true,
          output: JSON.stringify(r.result, null, 2).slice(0, 100_000),
          data: r.result,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpLoopbackStartTool: ToolDefinition = {
    name: 'mcp_loopback_start',
    description:
      '启动MCP Loopback服务器（监听127.0.0.1），允许外部MCP客户端（如Claude Desktop）通过HTTP连接本系统。',
    category: 'mcp',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { port: { type: 'number', description: '端口号（0=自动分配，默认0）' } },
      required: [],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpLoopbackStartArgs;
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const r = await mcp.startLoopback(a.port ?? 0);
        if (!r.success) {
          return { success: false, error: r.error ?? '回环服务器启动失败' };
        }
        return {
          success: true,
          output: `MCP Loopback已启动: ${r.url}（token=${r.token}，仅本次完整返回，请保存）`,
          data: { port: r.port, token: r.token, url: r.url },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpLoopbackStatusTool: ToolDefinition = {
    name: 'mcp_loopback_status',
    description: '获取MCP Loopback服务器状态（运行状态/端口/脱敏token/Claude Desktop配置）。',
    category: 'mcp',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const st = mcp.getLoopbackStatus();
        return {
          success: true,
          output: st.running ? `Loopback运行中: ${st.url}` : 'Loopback未运行',
          data: st,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpLoopbackStopTool: ToolDefinition = {
    name: 'mcp_loopback_stop',
    description: '停止MCP Loopback服务器。',
    category: 'mcp',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const r = mcp.stopLoopback();
        return { success: r.success, output: 'MCP Loopback已停止' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const mcpConversationsListTool: ToolDefinition = {
    name: 'mcp_conversations_list',
    description: '列出所有MCP渠道对话（会话键/频道/消息数/最近消息时间），可按频道或关键词过滤。',
    category: 'mcp',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '按频道过滤' },
        search: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '最大返回数量（默认50）' },
      },
      required: [],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as McpConversationsArgs;
      const mcp = getMcp();
      if (!mcp) {
        return { success: false, error: 'MCP服务不可用（McpModule 未加载）' };
      }
      try {
        const conversations = mcp.listConversations({
          channel: a.channel || '',
          search: a.search || '',
          limit: a.limit || 50,
        });
        return {
          success: true,
          output: conversations.length === 0 ? '（无对话）' : JSON.stringify(conversations, null, 2),
          data: { conversations, total: conversations.length },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return [
    cronCreateTool,
    cronUpdateTool,
    cronDeleteTool,
    cronListTool,
    cronToggleTool,
    cronRunNowTool,
    cronDeliveryTool,
    mcpListTool,
    mcpStartTool,
    mcpStopTool,
    mcpCallTool,
    mcpResourcesTool,
    mcpResourceReadTool,
    mcpLoopbackStartTool,
    mcpLoopbackStatusTool,
    mcpLoopbackStopTool,
    mcpConversationsListTool,
  ];
}
