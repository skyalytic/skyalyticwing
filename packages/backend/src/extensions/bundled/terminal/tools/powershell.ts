import { runShell } from '../../shared/tools/shell-runner.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { formatExecError } from './bash.js';

interface PowerShellArgs {
  command: string;
  cwd?: string;
  timeout?: number;
  readOnly?: boolean;
}

const DEFAULT_TIMEOUT = 0;

/**
 * powershell 工具：执行 PowerShell 命令。
 * 危险：true。安全：命令黑名单校验（isCommandAllowed）。
 * 实现：异步 spawn('powershell', ['-NoProfile', '-Command', command], ...) 数组参数防注入。
 */
export function createPowerShellTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'powershell',
    description: '执行 PowerShell 命令（默认不设执行时限，停止聊天会取消执行）。返回输出、退出码和取消状态。命令须通过安全校验。',
    category: 'shell',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        readOnly: { type: 'boolean', description: '纯查询时设为 true，跳过撤销快照；不会改变权限。修改文件时不要设置。' },
        cwd: { type: 'string', description: '工作目录（可选，须在白名单内）' },
        timeout: { type: 'number', description: '自愿设置本次执行超时毫秒数；省略或 0 表示不限时' },
      },
      required: ['command'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as PowerShellArgs;
      if (!a || typeof a.command !== 'string' || a.command.length === 0) {
        return { success: false, error: 'Parameter "command" is required and must be a non-empty string' };
      }
      if (!security.isCommandAllowed(a.command)) {
        return { success: false, error: `Command blocked by guard: ${a.command}`, blocked: true };
      }
      const cwd = typeof a.cwd === 'string' && a.cwd.length > 0 ? a.cwd : ctx.workspace;
      if (cwd.includes('\0')) {
        return { success: false, error: 'cwd must not contain null bytes' };
      }
      if (!security.isPathAllowed(cwd)) {
        return { success: false, error: `cwd not allowed: ${cwd}`, blocked: true };
      }
      const timeout =
        Number.isSafeInteger(a.timeout) && a.timeout! > 0
          ? Math.floor(a.timeout!)
          : DEFAULT_TIMEOUT;
      try {
        return await runShell(
          process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
          ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; ' + a.command],
          {
            cwd,
            timeout,
            sessionId: ctx.sessionId, readOnly: a.readOnly === true,
            ...(ctx.signal ? {signal: ctx.signal} : {}),
          },
        );
      } catch (err) {
        return formatExecError(err);
      }
    },
  };
}
