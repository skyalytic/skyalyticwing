import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { runShell } from '../../shared/tools/shell-runner.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';

interface BashArgs {
  command: string;
  cwd?: string;
  timeout?: number;
  readOnly?: boolean;
}

const DEFAULT_TIMEOUT = 0;

/**
 * bash 工具：执行 bash 命令。
 * 危险：true。安全：命令黑名单校验（isCommandAllowed）。
 * 实现：异步 spawn，命令输出完整写入日志。
 * 默认不设时限；用户取消或明确设置超时才终止。
 */
export function createBashTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'bash',
    description: '执行 bash 命令（默认不设执行时限，停止聊天会取消执行）。返回输出、退出码和取消状态。命令须通过安全校验。',
    category: 'shell',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令' },
        readOnly: { type: 'boolean', description: '纯查询时设为 true，跳过撤销快照；不会改变权限。修改文件时不要设置。' },
        cwd: { type: 'string', description: '工作目录（可选，须在白名单内）' },
        timeout: { type: 'number', description: '自愿设置本次执行超时毫秒数；省略或 0 表示不限时' },
      },
      required: ['command'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as BashArgs;
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
        const executable = findBash();
        if (!executable) return {success:false,error:'BASH_NOT_FOUND: 当前系统未安装可用 Bash。Windows 请使用 powershell 工具，或安装 Git Bash 后重试。',data:{errorCode:'ENOENT'}};
        return await runShell(executable, ['-c', a.command], { cwd, timeout, sessionId: ctx.sessionId, readOnly: a.readOnly === true, ...(ctx.signal ? {signal: ctx.signal} : {}) });
      } catch (err) {
        return formatExecError(err);
      }
    },
  };
}

/** 格式化 execFileSync 抛出的错误（含 stdout/stderr/status） */
export function formatExecError(err: unknown): ToolResult {
  const e = err as { stdout?: string; stderr?: string; status?: number; message?: string; signal?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const parts: string[] = [];
  if (e.signal) parts.push(`signal: ${e.signal}`);
  if (typeof e.status === 'number') parts.push(`exit code: ${e.status}`);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  const msg = e.message ? e.message.split('\n')[0] : 'Command failed';
  const result: ToolResult = {
    success: false,
    error: `${msg}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`,
  };
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  if (combined) result.output = combined;
  return result;
}

function findBash(): string | undefined {
  if (process.platform !== 'win32') return 'bash';
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs')].filter((s): s is string => !!s);
  const candidates = [
    ...(process.env['PATH'] || '').split(delimiter).filter(Boolean).map(p => join(p.replace(/^"|"$/g, ''), 'bash.exe')),
    ...roots.flatMap(p => [join(p, 'Git', 'bin', 'bash.exe'), join(p, 'Git', 'usr', 'bin', 'bash.exe')]),
  ];
  return candidates.find(p => !/[\\/]Windows[\\/](?:System32|Sysnative)[\\/]/i.test(p) && existsSync(p));
}
