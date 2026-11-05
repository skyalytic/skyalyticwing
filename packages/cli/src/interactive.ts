import { createInterface, clearLine, cursorTo } from 'node:readline';
import { parseArgs, type CliOptions } from './args.js';
import { cmdRun, prepareSession, bindProject, type TurnEvent } from './commands/run.js';
import { apiFetch, DEFAULT_BASE_URL } from './http.js';
import { manage } from './manage.js';
import { cmdModels } from './commands/models.js';
import { cmdAgents } from './commands/agents.js';

export function splitCommand(line: string): string[] {
  const tokens = line.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g) ?? [];
  return tokens.map((t) => (/^["']/.test(t) ? t.slice(1, -1) : t));
}

export async function interactive(options: CliOptions): Promise<number> {
  if (!process.stdin.isTTY) throw new Error('非交互输入请使用 exec - 或 run "任务"');
  const fresh = !options.session;
  await prepareSession(options);
  await bindProject(options, fresh);
  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  console.error(
    `\nWing AI · ${options.session}\n直接输入任务；运行中继续输入可补充指令。/help 帮助，Ctrl+C 停止任务。`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: 'wing › ' });
  let active: Promise<number> | undefined, controller: AbortController | undefined;
  let approval: ((decision: string) => void) | undefined;
  let closing = false;
  const approve = (event: TurnEvent): Promise<string> =>
    new Promise((resolve) => {
      console.error(
        `\n审批：${event.request?.toolName}\n${JSON.stringify(event.request?.args, null, 2)}\n${event.request?.reason ?? ''}\ny=批准本次 / a=始终允许 / n=拒绝 / d=始终拒绝`,
      );
      approval = resolve;
      rl.prompt();
    });
  const cancel = () => {
    approval?.('denied');
    approval = undefined;
    controller?.abort();
  };
  const onLine = async (line: string) => {
    if (closing) return;
    line = line.trim();
    if (!line) return;
    if (approval && !line.startsWith('/')) {
      const decisions: Record<string, string> = {
        y: 'allow-once',
        a: 'allow-always',
        n: 'denied',
        d: 'deny-always',
      };
      const decision = decisions[line.toLowerCase()];
      if (!decision) {
        console.error('请输入 y / a / n / d');
        return;
      }
      const answer = approval;
      approval = undefined;
      answer(decision);
      return;
    }
    if (line === '/quit' || line === '/exit') {
      closing = true;
      cancel();
      rl.close();
      return;
    }
    if (line === '/cancel' || line === '/stop') {
      cancel();
      return;
    }
    if (line === '/help') {
      console.error(
        '/new /resume ID /fork /model ID /agent ID /attach "文件" /history /compact\n/models /agents /skills /mcp /plugins /memory /tools /status /permissions [ask|auto|yolo]\n/changes /diff ID /undo ID /redo ID /approvals /cancel /quit\n管理子命令与 CLI 命令一致；/api 可访问当前账号有权限的其他后端接口。',
      );
      return;
    }
    if (line.startsWith('/')) {
      if (active) throw new Error('任务正在运行；可补充指令或 /cancel，结束后再更改设置');
      const parsed = parseArgs(splitCommand(line.slice(1)));
      if (parsed.error) throw new Error(parsed.error);
      const args = parsed.positional,
        command = parsed.command!;
      if (command === 'model' || command === 'agent') {
        if (!args[0]) throw new Error('请提供 ID');
        options[command] = args[0];
      } else if (command === 'attach') {
        if (!args[0]) throw new Error('请提供文件路径');
        (options.files ??= []).push(args.join(' '));
        console.error('附件已加入下一轮');
      } else if (command === 'new') {
        delete options.session;
        await prepareSession(options);
        await bindProject(options, true);
        console.error(`会话 ${options.session}`);
      } else if (command === 'resume') {
        if (!args[0]) throw new Error('请提供会话 ID');
        const candidate = { ...options, session: args[0] };
        delete candidate.model;
        delete candidate.agent;
        await prepareSession(candidate);
        delete options.model;
        delete options.agent;
        Object.assign(options, candidate);
        console.error(`会话 ${options.session}`);
      } else if (command === 'fork') {
        const fork = await apiFetch<{ id: string }>(
          base,
          `/api/sessions/${encodeURIComponent(options.session!)}/fork`,
          { method: 'POST', body: {} },
        );
        if (!fork.data?.id) throw new Error('会话分叉失败');
        options.session = fork.data.id;
        console.error(`会话 ${options.session}`);
      } else if (command === 'models') await cmdModels(options);
      else if (command === 'agents') await cmdAgents(options);
      else
        await manage(command, args, {
          ...options,
          ...(parsed.options.dataFile ? { dataFile: parsed.options.dataFile } : {}),
        }, approve);
      return;
    }
    if (active) {
      await apiFetch(base, '/api/steer', {
        method: 'POST',
        body: { session: options.session, message: line },
      });
      console.error('已加入补充指令');
      return;
    }
    controller = new AbortController();
    active = cmdRun(line, options, {
      signal: controller.signal,
      approval: approve,
      progress: (message) => {
        // Preserve a partially typed steering message when a waiting update arrives.
        if (process.stderr.isTTY) {
          clearLine(process.stderr, 0);
          cursorTo(process.stderr, 0);
        }
        console.error(message);
        if (!closing) rl.prompt(true);
      },
    });
    void active
      .catch((error) => console.error(String(error)))
      .finally(() => {
        active = undefined;
        controller = undefined;
        approval = undefined;
        delete options.files;
        if (!closing) rl.prompt();
      });
  };
  let queue = Promise.resolve();
  rl.on('line', (line) => {
    queue = queue
      .then(() => onLine(line))
      .catch((error) => console.error(error instanceof Error ? error.message : String(error)))
      .then(() => {
        if (!closing) rl.prompt();
      });
  });
  rl.on('SIGINT', () => {
    if (active) cancel();
    else {
      closing = true;
      rl.close();
    }
  });
  rl.prompt();
  await new Promise<void>((resolve) => rl.once('close', resolve));
  closing = true;
  cancel();
  await queue;
  await active;
  return 0;
}
