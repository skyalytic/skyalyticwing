import { runShell } from '../executor/built-in/shell-runner.js';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LoggerService } from '../../core/logger/logger.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { parseCommandSegments } from '../../core/utils/exec-args.util.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/**
 * SandboxSystemService - 沙箱执行系统（PM-005）
 *
 * 移植自 start.cjs SandboxSystem：
 *   - Docker 可用时使用 docker run --rm 隔离执行
 *   - 否则降级进程级沙箱（命令白名单 + 链式命令检查 + 阻断模式）
 *   - 所有命令先经 SecurityManager.isCommandAllowed 校验
 *   - 子进程统一 execFile 数组参数调用（防 shell 注入）
 */

/** 允许的只读命令白名单（对齐旧版） */
export const ALLOWED_COMMANDS = [
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'grep',
  'find',
  'echo',
  'pwd',
  'whoami',
  'date',
  'wc',
  'sort',
  'uniq',
  'diff',
  'which',
  'printenv',
];

/** 阻断的危险命令模式（对齐旧版） */
export const BLOCKED_PATTERNS = [
  'rm -rf /',
  'mkfs',
  'dd if=',
  '> /dev/sda',
  'chmod 777 /',
  'chown root',
  'iptables',
  'crontab -r',
];

/** 命令长度上限 */

/** 进程沙箱默认超时 */

/** Docker 沙箱默认超时 */


/** 沙箱执行结果 */
export interface SandboxExecResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode: number | null;
  code?: string;
  mode: 'process-sandbox' | 'docker-sandbox';
  container?: string;
  data?: unknown;
}

/** 校验问题 */
export interface ValidationIssue {
  severity: 'critical' | 'warning';
  message: string;
}

@Injectable()
export class SandboxSystemService implements OnModuleInit {
  private dockerAvailable = false;
  private sandboxMode: 'docker' | 'process' = 'process';

  constructor(
    private readonly logger: LoggerService,
    private readonly security: SecurityManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: 3000,
        windowsHide: true,
      });
      this.dockerAvailable = true;
      this.sandboxMode = 'docker';
      this.logger.info('sandbox: Docker 沙箱可用');
    } catch {
      this.dockerAvailable = false;
      this.sandboxMode = 'process';
      this.logger.info('sandbox: Docker 不可用；隔离执行将拒绝运行');
    }
  }

  /** 沙箱状态 */
  getStatus(): Record<string, unknown> {
    return {
      enabled: this.dockerAvailable,
      isolation: this.dockerAvailable ? 'container' : 'unavailable',
      processFallback: process.env['SKYALYTICWING_ALLOW_UNISOLATED_EXECUTION'] === 'true',
      mode: this.sandboxMode,
      dockerAvailable: this.dockerAvailable,
      allowedCommands: ALLOWED_COMMANDS.length,
      blockedPatterns: BLOCKED_PATTERNS.length,
    };
  }

  /** 允许的操作列表 */
  getAllowed(): { commands: string[]; blocked: string[] } {
    return { commands: [...ALLOWED_COMMANDS], blocked: [...BLOCKED_PATTERNS] };
  }

  /** 是否命中阻断模式 */
  isBlocked(command: string): boolean {
    const lower = command.toLowerCase();
    return BLOCKED_PATTERNS.some((p) => lower.includes(p));
  }

  /** 安全执行（Docker 优先，进程沙箱降级） */
  async executeSafe(
    command: string,
    options?: { cwd?: string; timeout?: number; sessionId?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult> {
    if (!command.trim()) {
      return {
        success: false,
        error: 'Command must not be empty',
        exitCode: null,
        code: 'INVALID_COMMAND',
        mode: 'docker-sandbox',
      };
    }
    if (this.isBlocked(command)) {
      return {
        success: false,
        error: 'Command blocked by security policy',
        exitCode: null,
        code: 'BLOCKED',
        mode: 'process-sandbox',
      };
    }
    if (!this.security.isCommandAllowed(command)) {
      return {
        success: false,
        error: 'Command rejected by security manager',
        exitCode: null,
        code: 'NOT_ALLOWED',
        mode: 'process-sandbox',
      };
    }
    if (this.sandboxMode === 'docker' && this.dockerAvailable) {
      return this.executeInDocker(command, options);
    }
    if (process.env['SKYALYTICWING_ALLOW_UNISOLATED_EXECUTION'] === 'true')
      return this.executeInProcess(command, options);
    return {
      success: false,
      error: 'Docker isolation unavailable. No host execution fallback is permitted.',
      exitCode: null,
      code: 'ISOLATION_UNAVAILABLE',
      mode: 'docker-sandbox',
    };
  }

  /** 进程级沙箱：白名单校验 + execFile 数组参数执行 */
  private async executeInProcess(
    command: string,
    options?: { cwd?: string; timeout?: number; sessionId?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult> {
    const segments = parseCommandSegments(command);
    const parts = segments?.length === 1 ? segments[0]!.argv : [];
    const baseCmd = (parts[0] ?? '').toLowerCase();
    // This fallback cannot enforce OS isolation. Only single allowlisted commands
    // are accepted; shell syntax must never disable the executable allowlist.
    // GNU find can execute other programs or mutate files through these actions.
    const unsafeFind =
      baseCmd === 'find' &&
      parts.some((arg) =>
        /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/i.test(arg),
      );
    if (!ALLOWED_COMMANDS.includes(baseCmd) || unsafeFind) {
      return {
        success: false,
        error: 'Process sandbox requires a single allowlisted command without execution actions',
        exitCode: null,
        code: 'NOT_ALLOWED',
        mode: 'process-sandbox',
      };
    }

    try {
      const result = await runShell(parts[0]!, parts.slice(1), {
        cwd: options?.cwd || process.cwd(), timeout: options?.timeout ?? 0,
        sessionId: options?.sessionId || '', readOnly:true,
        ...(options?.signal ? {signal:options.signal} : {}),
        env: {PATH:process.env['PATH'],SystemRoot:process.env['SystemRoot'],SANDBOX_MODE:'true'},
      });
      return {...result, exitCode:(result.data as {exitCode?:number|null})?.exitCode ?? null, mode:'process-sandbox'};
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string; code?: number };
      return {
        success: false,
        output: e.stdout ?? '',
        error: e.stderr || e.message,
        exitCode: e.code ?? 1,
        mode: 'process-sandbox',
      };
    }
  }

  /** Docker 沙箱：docker run --rm 数组参数执行 */
  private async executeInDocker(
    command: string,
    options?: { cwd?: string; timeout?: number; sessionId?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult> {
    const containerName = `sandbox-${randomUUID()}`;
    const workDir = '/workspace';
    let source: string;
    try {
      source = realpathSync(options?.cwd || process.cwd());
      if (
        !statSync(source).isDirectory() ||
        source.includes(',') ||
        !this.security.isPathAllowed(source, 'write')
      )
        throw new Error('Workspace not allowed');
    } catch (err) {
      return {
        success: false,
        error: String(err),
        exitCode: null,
        code: 'INVALID_WORKSPACE',
        mode: 'docker-sandbox',
      };
    }
    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      '--user',
      `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
      '--security-opt=no-new-privileges',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--mount',
      `type=bind,source=${source},target=${workDir}`,
      '--workdir',
      workDir,
      process.env['SKYALYTICWING_SANDBOX_IMAGE'] || 'node:22-bookworm-slim',
      'bash',
      '-c',
      command,
    ];
    try {
      const result = await runShell('docker', args, {
        cwd: options?.cwd || process.cwd(), timeout: options?.timeout ?? 0,
        sessionId:options?.sessionId || '', ...(options?.signal ? {signal:options.signal} : {}),
      });
      return {...result,exitCode:(result.data as {exitCode?:number|null})?.exitCode ?? null,mode:'docker-sandbox',container:containerName};
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string; code?: number };
      return {
        success: false,
        output: e.stdout ?? '',
        error: e.stderr || e.message,
        exitCode: e.code ?? 1,
        mode: 'docker-sandbox',
        container: containerName,
      };
    } finally {
      // Killing the Docker client on timeout does not stop its container.
      await execFileAsync('docker', ['rm', '-f', containerName], {
        timeout: 5000,
        windowsHide: true,
      }).catch(() => undefined);
    }
  }

  /** 验证命令安全性 */
  validateCommand(command: string): { valid: boolean; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    if (this.isBlocked(command)) {
      issues.push({ severity: 'critical', message: 'Contains blocked pattern' });
    }
    const baseCmd = command.trim().split(/\s+/)[0] ?? '';
    if (!ALLOWED_COMMANDS.includes(baseCmd)) {
      issues.push({ severity: 'warning', message: `Command not in allowlist: ${baseCmd}` });
    }
    return { valid: issues.every((i) => i.severity !== 'critical'), issues };
  }
}
