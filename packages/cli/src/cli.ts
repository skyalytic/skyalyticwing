#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from './args.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdRun, prepareSession } from './commands/run.js';
import { cmdModels } from './commands/models.js';
import { cmdAgents } from './commands/agents.js';
import { cmdCron } from './commands/cron.js';
import { interactive } from './interactive.js';
import { manage } from './manage.js';
import { connectRuntime } from './runtime.js';
import { ApiError } from './http.js';
const require = createRequire(import.meta.url);
const VERSION = (require('../package.json') as { version: string }).version;

function usage() {
  console.log(`Wing AI CLI ${VERSION}

用法：skyalyticwing [cli] | run/exec "任务" | resume <会话ID>

  cli / chat                 交互式 AI（工具、技能、MCP、记忆、蜂群使用桌面同一引擎）
  exec / run "任务"           执行任务；用 - 从标准输入读取
  resume <ID>                继续会话
  sessions / history         会话列表 / 当前会话历史
  models / agents            模型 / 智能体
  serve                      保持本机 AI 服务运行（Ctrl+C 退出自己启动的服务）
  tools / skills / plugins   工具 / 技能 / 插件
  mcp list|add|update|remove|start|stop|tools
  memory [关键词]            知识库 / 搜索记忆
  permissions [ask|auto|yolo] 查看或修改与桌面共用的权限设置
  approvals [ID 决策]        查看 / 处理审批
  changes / diff <ID>        文档变更 / 变更详情
  undo / redo <ID>           撤销 / 重做指定变更
  lsp servers / <操作> <文件> [行 列 新名称]   项目语言服务
  lsp apply <预览ID> --session <ID>          应用已审查的重命名/格式化
  repo inspect / verify <程序> [参数...]    仓库检查 / 真实测试与构建
  journal --session <ID>     持久任务记录与中断后未知操作
  compact / steer "指令" / stop   压缩 / 引导 / 停止指定会话
  cron list|run <ID>         定时任务
  doctor / status            连接检查 / 运行状态
  api METHOD /api/...        访问当前账号有权限的其他后端功能

选项：
  --cwd <目录>               绑定会话工作区（新会话默认当前目录）
  --session <ID> --agent <ID> --model <ID>
  --file <路径> / --image <路径>  附件，可重复指定
  --base-url <地址>          指定后端；缺省连接本机 Wing
  --data-file <JSON文件>     管理命令的配置数据（包括 MCP 配置）
  --json / --jsonl           最终 JSON / 实时事件 JSONL
  --help / --version

认证：环境变量 SKYALYTICWING_AUTH_TOKEN 或 SKYALYTICWING_COOKIE。
远程连接使用 HTTPS；不会在命令行显示或记录凭据。
交互模式 Ctrl+C 停止当前任务；再次空闲时退出。输入 /help 查看会话命令。`);
}
async function stdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 500_000) throw new Error('输入超过 500000 字符');
  }
  return text;
}
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  const { options, positional } = parsed;
  if (parsed.error) throw new Error(parsed.error);
  if (options.version || parsed.command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (options.help || parsed.command === 'help') {
    usage();
    return 0;
  }
  let command = parsed.command ?? 'cli';
  if (command === 'start') command = 'serve';
  if (command === 'gateway') {
    if (!positional[0] || positional[0] === 'run') command = 'serve';
    else if (positional[0] === 'status') command = 'status';
    else throw new Error('gateway 支持 run / status；在启动服务的终端按 Ctrl+C 停止。');
  }
  if (command === 'resume') {
    if (!positional[0]) throw new Error('请指定会话 ID；使用 sessions 查看');
    options.session = positional[0];
  }
  const stopRuntime = await connectRuntime(options);
  try {
    if (command === 'serve') {
      console.error('Wing AI 服务运行中，Ctrl+C 退出。');
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      return 0;
    }
    if (['cli', 'chat', 'resume'].includes(command)) return await interactive(options);
    if (command === 'run' || command === 'exec') {
      const prompt = positional.join(' ') === '-' ? await stdin() : positional.join(' ');
      if (!prompt.trim()) throw new Error('请提供任务内容');
      if (options.session) await prepareSession(options);
      return await cmdRun(prompt, options);
    }
    if (command === 'doctor') return await cmdDoctor(options);
    if (command === 'models') return await cmdModels(options);
    if (command === 'agents') return await cmdAgents(options);
    if (command === 'cron') return await cmdCron(positional, options);
    await manage(command, positional, options);
    return 0;
  } finally {
    await stopRuntime();
  }
}
void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes('--json') || process.argv.includes('--jsonl'))
      console.log(
        JSON.stringify({
          ok: false,
          error: message,
          ...(error instanceof ApiError ? { data: error.data } : {}),
        }),
      );
    else {
      console.error(`Wing CLI：${message}`);
      const result =
        error instanceof ApiError
          ? (error.data as { output?: string; data?: { outputPath?: string } })
          : undefined;
      if (result?.output) console.error(result.output);
      if (result?.data?.outputPath) console.error(`完整日志：${result.data.outputPath}`);
    }
    process.exitCode = 1;
  });
