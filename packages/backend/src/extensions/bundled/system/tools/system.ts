import { runShell } from '../../shared/tools/shell-runner.js';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SystemService } from '../../../../modules/core/system/system.service.js';
import { UsageService } from '../../../../modules/core/system/usage.service.js';
import { QueueService } from '../../../../modules/core/queue/queue.service.js';
import { RemoteService } from '../../../../modules/core/remote/remote.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

interface EnvNameArgs {
  name: string;
  value?: string;
}

interface ProcessKillArgs {
  pid: number;
}

/**
 * 敏感环境变量黑名单（对齐旧版 system.cjs env_get/env_set）：
 * 路径注入类与凭据类变量禁止读取/设置。
 */
const SENSITIVE_ENV_PATTERN =
  /^(PATH|HOME|USER|SHELL|COMSPEC|SYSTEMROOT|WINDIR|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_|NPM_CONFIG_|AWS_|GITHUB_|GOOGLE_|AZURE_|DATABASE_URL|MYSQL_|POSTGRES_|REDIS_|MONGO_)|API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|AUTHORIZATION|COOKIE|CONNECTION_?STRING/i;

/** 环境变量名格式校验 */
function isValidEnvName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

/** 进程列表命令超时 */

/**
 * 系统/监控域工具：
 *   - system_info → SystemService.getSystemInfo
 *   - usage_stats → UsageService.getUsage
 *   - queue_status → QueueService.getStats/list
 *   - remote_nodes → RemoteService.listNodes
 *   - env_get / env_set（敏感变量黑名单，env_set 危险）
 *   - process_list / process_kill（child_process 固定命令桥接，无注入面）
 */
export function createSystemTools(resolve: ServiceResolver): ToolDefinition[] {
  /** 域服务懒解析（首次执行时解析并缓存；未加载时工具返回明确不可用提示） */
  let systemCache: SystemService | undefined;
  let systemResolved = false;
  const getSystem = (): SystemService | undefined => {
    if (!systemResolved) {
      systemCache = resolve(SystemService);
      systemResolved = true;
    }
    return systemCache;
  };
  let usageCache: UsageService | undefined;
  let usageResolved = false;
  const getUsage = (): UsageService | undefined => {
    if (!usageResolved) {
      usageCache = resolve(UsageService);
      usageResolved = true;
    }
    return usageCache;
  };
  let queueCache: QueueService | undefined;
  let queueResolved = false;
  const getQueue = (): QueueService | undefined => {
    if (!queueResolved) {
      queueCache = resolve(QueueService);
      queueResolved = true;
    }
    return queueCache;
  };
  let remoteCache: RemoteService | undefined;
  let remoteResolved = false;
  const getRemote = (): RemoteService | undefined => {
    if (!remoteResolved) {
      remoteCache = resolve(RemoteService);
      remoteResolved = true;
    }
    return remoteCache;
  };

  const systemInfoTool: ToolDefinition = {
    name: 'system_info',
    description: '获取系统运行信息（平台/架构/主机名/内存/PID/运行时间/数据目录等），用于诊断系统状态。',
    category: 'system',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const system = getSystem();
      if (!system) {
        return { success: false, error: '系统信息服务不可用（SystemModule 未加载）' };
      }
      try {
        const info = system.getSystemInfo();
        return {
          success: true,
          output: `platform=${info.platform} arch=${info.arch} host=${info.hostname} node=${info.nodeVersion} uptime=${info.uptime}s pid=${info.pid} totalMem=${Math.round(info.totalMem / 1024 / 1024)}MB freeMem=${Math.round(info.freeMem / 1024 / 1024)}MB`,
          data: info,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const usageStatsTool: ToolDefinition = {
    name: 'usage_stats',
    description: '查看API用量统计（今日/本月请求数、token消耗、各供应商占比），用于监控使用情况。',
    category: 'system',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const usage = getUsage();
      if (!usage) {
        return { success: false, error: '用量统计服务不可用（SystemModule 未加载）' };
      }
      try {
        const snapshot = usage.getUsage();
        return {
          success: true,
          output: `今日: ${snapshot.today.requests}次/${snapshot.today.tokens}tokens；本月: ${snapshot.thisMonth.requests}次/${snapshot.thisMonth.tokens}tokens；供应商: ${snapshot.byProvider.map((p) => `${p.provider}(${p.percentage}%)`).join(', ') || '无'}`,
          data: snapshot,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const queueStatusTool: ToolDefinition = {
    name: 'queue_status',
    description: '查看消息队列状态（队列长度/处理中/最近消息），用于调试消息处理问题。',
    category: 'system',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const queue = getQueue();
      if (!queue) {
        return { success: false, error: '消息队列服务不可用（QueueModule 未加载）' };
      }
      try {
        const stats = queue.getStats();
        const { items, total } = queue.list();
        return {
          success: true,
          output: `队列长度=${stats.queueSize}/${stats.maxSize}，处理中=${stats.isProcessing}`,
          data: { stats, recent: items.slice(0, 10), total },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const remoteNodesTool: ToolDefinition = {
    name: 'remote_nodes',
    description: '列出远程节点信息（ID/地址/状态/负载/能力），用于分布式任务管理。',
    category: 'system',
    dangerous: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const remote = getRemote();
      if (!remote) {
        return { success: false, error: '远程节点服务不可用（RemoteModule 未加载）' };
      }
      try {
        const nodes = remote.listNodes();
        return {
          success: true,
          output: nodes.length === 0 ? '（无远程节点）' : nodes.map((n) => `${n['name']}: ${n['host']} [${n['status']}]`).join('\n'),
          data: { nodes, total: nodes.length },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const envGetTool: ToolDefinition = {
    name: 'env_get',
    description: '读取环境变量值（受安全策略限制，路径注入类与凭据类敏感变量不可读取）。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境变量名（大写字母/数字/下划线）' },
      },
      required: ['name'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as EnvNameArgs;
      const name = a?.name ?? '';
      if (!isValidEnvName(name) || SENSITIVE_ENV_PATTERN.test(name)) {
        return { success: false, error: `不允许读取该环境变量: ${name || '(空)'}`, blocked: true };
      }
      const value = process.env[name];
      return {
        success: true,
        output: value !== undefined ? `${name}=${value}` : `${name} 未设置`,
        data: { name, value: value ?? null, exists: value !== undefined },
      };
    },
  };

  const envSetTool: ToolDefinition = {
    name: 'env_set',
    description:
      '设置环境变量值（仅当前进程内生效，重启后失效；敏感变量不可设置）。用于临时调整运行时行为。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境变量名（大写字母/数字/下划线）' },
        value: { type: 'string', description: '变量值' },
      },
      required: ['name', 'value'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as EnvNameArgs;
      const name = a?.name ?? '';
      const value = typeof a?.value === 'string' ? a.value : '';
      if (!isValidEnvName(name) || SENSITIVE_ENV_PATTERN.test(name)) {
        return { success: false, error: `不允许设置该环境变量: ${name || '(空)'}`, blocked: true };
      }
      process.env[name] = value;
      return {
        success: true,
        output: `${name} 已设置（仅当前进程生效）`,
        data: { name, value },
      };
    },
  };

  const processListTool: ToolDefinition = {
    name: 'process_list',
    description: '列出当前系统运行中的进程（Windows: Get-Process；Unix: ps aux）。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        nameFilter: { type: 'string', description: '按进程名过滤（可选）' },
      },
      required: [],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as { nameFilter?: string };
      const safeFilter = typeof a?.nameFilter === 'string' ? a.nameFilter.replace(/[^a-zA-Z0-9_.-]/g, '') : '';
      const windows = platform() === 'win32';
      const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Get-Process ${safeFilter ? `| Where-Object { $_.ProcessName -like '*${safeFilter}*' } ` : ''}| Select-Object Id,ProcessName,CPU,WorkingSet64 | Format-Table -AutoSize`;
      const result = await runShell(windows ? 'powershell.exe' : 'ps', windows ? ['-NoProfile','-Command',script] : ['aux'], {
        cwd:ctx.workspace,sessionId:ctx.sessionId,readOnly:true,...(ctx.signal ? {signal:ctx.signal} : {}),
      });
      // A paginated preview must keep the full-output reference, even when filtering.
      if (!windows && safeFilter && !(result.data as {previewPartial?:boolean})?.previewPartial) {
        result.output = (result.output || '').split('\n').filter(line => line.includes(safeFilter)).join('\n');
      }
      return {...result,data:{...(result.data as Record<string,unknown>),platform:platform()}};
    },
  };

  const processKillTool: ToolDefinition = {
    name: 'process_kill',
    description: '终止指定PID的进程（危险操作）。不能终止自身进程。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: '要终止的进程PID（正整数）' },
      },
      required: ['pid'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as ProcessKillArgs;
      const pid = a?.pid;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return { success: false, error: `无效的PID: ${String(pid)}` };
      }
      if (pid === process.pid) {
        return { success: false, error: '不能终止自身进程', blocked: true };
      }
      try {
        if (platform() === 'win32') {
          execFileSync('taskkill', ['/PID', String(pid), '/F'], {
            timeout: 5_000,
            windowsHide: true,
          });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        return { success: true, output: `进程已终止: ${pid}` };
      } catch (err) {
        return {
          success: false,
          error: `终止进程 ${pid} 失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };

  return [
    systemInfoTool,
    usageStatsTool,
    queueStatusTool,
    remoteNodesTool,
    envGetTool,
    envSetTool,
    processListTool,
    processKillTool,
  ];
}
