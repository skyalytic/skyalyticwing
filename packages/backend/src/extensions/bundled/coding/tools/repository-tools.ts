import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { LocalResourcePolicy } from '../../../../modules/core/security/local-resource-policy.service.js';
import { RunJournal } from '../../../../modules/ai/agent/run-journal.js';
import { runShell } from '../../shared/tools/shell-runner.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
const execute = promisify(execFile);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await execute('git', ['--no-pager', ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return result.stdout;
}
function commands(root: string) {
  const found: Array<{ label: string; command: string; args: string[] }> = [];
  if (existsSync(join(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const manager = existsSync(join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(root, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
    for (const name of Object.keys(pkg.scripts ?? {}))
      if (/^(test|build|lint|type-?check|check)(:|$)/.test(name))
        found.push({ label: name, command: manager, args: ['run', name] });
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'pytest.ini')))
    found.push({ label: 'pytest', command: 'python', args: ['-m', 'pytest'] });
  if (existsSync(join(root, 'Cargo.toml')))
    found.push(
      { label: 'cargo test', command: 'cargo', args: ['test'] },
      { label: 'cargo check', command: 'cargo', args: ['check'] },
    );
  if (existsSync(join(root, 'go.mod')))
    found.push({ label: 'go test', command: 'go', args: ['test', './...'] });
  if (existsSync(join(root, 'pom.xml')))
    found.push({ label: 'maven test', command: 'mvn', args: ['test'] });
  return found;
}
async function snapshot(root: string, signal?: AbortSignal) {
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], signal).catch(() => '(unborn)');
  const status = await git(
    root,
    ['status', '--short', '--untracked-files=all', '--', '.', ':(exclude).wing-terminal'],
    signal,
  );
  const diff = await git(
    root,
    ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ':(exclude).wing-terminal'],
    signal,
  ).catch(() => git(root, ['diff', '--no-ext-diff', '--no-textconv'], signal));
  return { head: head.trim(), status, diff, diffHash: sha(diff) };
}
export function createRepositoryTools(
  security: SecurityManagerService,
  resolve: ServiceResolver,
): ToolDefinition[] {
  const rootFor = (raw: unknown, ctx: ToolContext) => {
    const root = realpathSync(
      pathResolve(ctx.workspace || process.cwd(), (raw as { root?: string })?.root || '.'),
    );
    if (!security.isPathAllowed(root, 'readwrite') || !statSync(root).isDirectory())
      throw new Error('Repository path not allowed');
    return root;
  };
  return [
    {
      name: 'repo_inspect',
      category: 'development',
      dangerous: false,
      description:
        '检查真实 Git 仓库：HEAD、未提交改动、补丁、已跟踪文件和可用测试/构建命令。不会自动执行仓库脚本。',
      parameters: { type: 'object', properties: { root: { type: 'string' } }, required: [] },
      async execute(raw: unknown, ctx: ToolContext) {
        try {
          const root = rootFor(raw, ctx);
          const state = await snapshot(root, ctx.signal);
          const files = (await git(root, ['ls-files', '-z'], ctx.signal))
            .split('\0')
            .filter(Boolean);
          const data = { root, ...state, files, commands: commands(root) };
          return { success: true, data, output: JSON.stringify(data) };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      },
    },
    {
      name: 'repo_verify',
      category: 'development',
      dangerous: true,
      description:
        '执行一条明确指定的仓库测试/构建命令，记录真实退出码、耗时、完整输出日志和执行前后 Git 补丁。命令参数用数组传递；未运行或失败不得报告测试通过。停止任务会终止进程树。',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeout: { type: 'number' },
        },
        required: ['command', 'args'],
      },
      async execute(raw: unknown, ctx: ToolContext) {
        try {
          const a = raw as { command: string; args: string[]; timeout?: number };
          const root = rootFor(raw, ctx);
          if (
            typeof a.command !== 'string' ||
            !a.command ||
            !Array.isArray(a.args) ||
            !a.args.every((s) => typeof s === 'string' && !s.includes('\0')) ||
            a.command.includes('\0')
          )
            throw new Error('command and string args required');
          if (!security.isCommandAllowed([a.command, ...a.args].join(' ')))
            throw new Error('Command blocked by security policy');
          const before = await snapshot(root, ctx.signal),
            startedAt = Date.now();
          let executable = a.command,
            args = a.args;
          if (process.platform === 'win32') {
            // PowerShell single-quoted literals preserve argument boundaries without CMD interpolation.
            const literal = (v: string) => "'" + v.replace(/'/g, "''") + "'";
            const script = `$ErrorActionPreference='Stop'; & ${[a.command, ...a.args].map(literal).join(' ')}; if ($null -eq $LASTEXITCODE) { if ($?) {exit 0} else {exit 1} } else {exit $LASTEXITCODE}`;
            executable = 'powershell.exe';
            args = [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ];
          }
          const result = await runShell(executable, args, {
            cwd: root,
            sessionId: ctx.sessionId,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(a.timeout ? { timeout: a.timeout } : {}),
          });
          const after = await snapshot(root).catch((error) => ({ error: String(error) }));
          return {
            ...result,
            data: {
              ...(result.data as object),
              root,
              command: a.command,
              args: a.args,
              startedAt,
              durationMs: Date.now() - startedAt,
              before,
              after,
            },
          };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      },
    },
    {
      name: 'task_journal',
      category: 'development',
      dangerous: false,
      description:
        '读取当前账号下本会话持久执行记录，包括已完成工具、运行状态和中断后结果未知的调用。未知操作必须检查副作用后再决定是否重试。',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_raw: unknown, ctx: ToolContext) {
        try {
          const identity =
            resolve<LocalResourcePolicy>(LocalResourcePolicy)?.credentialIdentity() ??
            'local';
          const data = RunJournal.list(identity, ctx.sessionId);
          return { success: true, data, output: JSON.stringify(data) };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      },
    },
  ];
}
