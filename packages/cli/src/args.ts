/**
 * 命令行参数解析（零依赖手写解析器）
 *
 * 支持的全局选项：
 *   --json                  机器可读 JSON 输出
 *   --base-url <url>        后端地址
 *   --agent <id>            智能体 ID（run 命令）
 *   --model <id>            模型 ID（run 命令）
 *   --session <id>          复用会话 ID（run 命令）
 *   -h / --help             帮助
 *   -v / --version          版本
 *
 * 解析规则：第一个非选项 token 视为子命令，其后非选项 token 视为位置参数；
 * 选项可出现在任意位置，支持 `--flag value` 与 `--flag=value` 两种写法。
 */

/** 全局选项集合 */
export interface CliOptions {
  /** 以机器可读 JSON 输出结果 */
  json: boolean;
  /** 显示帮助后退出 */
  help: boolean;
  /** 显示版本号后退出 */
  version: boolean;
  /** 后端地址（缺省时使用 http://127.0.0.1:9100） */
  baseUrl?: string;
  /** 智能体 ID（run 命令，缺省 'agent'） */
  agent?: string;
  /** 模型 ID（run 命令，可选） */
  model?: string;
  /** 会话 ID（run 命令，缺省自动生成） */
  session?: string;
  cwd?: string;
  files?: string[];
  jsonl?: boolean;
  dataFile?: string;
}

/** 解析结果 */
export interface ParsedArgs {
  /** 子命令：doctor / run / models / agents / cron；无命令时为 null */
  command: string | null;
  /** 子命令之后的位置参数 */
  positional: string[];
  /** 全局选项 */
  options: CliOptions;
  /** 解析失败原因（未知选项等）；非空时应报错退出 */
  error?: string;
}

/** 需要消费一个值的长选项 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--base-url',
  '--agent',
  '--model',
  '--session',
  '--cwd',
  '--file',
  '--image',
  '--data-file',
]);

/** 布尔长选项 */
const BOOL_FLAGS: ReadonlySet<string> = new Set(['--json', '--jsonl', '--help', '--version']);

/** 解析 process.argv 去掉 node 与脚本路径后的参数列表 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: CliOptions = { json: false, help: false, version: false };
  let command: string | null = null;
  const positional: string[] = [];
  let error: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue; // noUncheckedIndexedAccess：理论不可达，防御处理
    if (token === '--') {
      const rest = argv.slice(i + 1);
      if (command === null) command = rest.shift() ?? null;
      positional.push(...rest);
      break;
    }

    if (token.startsWith('-') && token !== '-') {
      // 支持 --flag=value 写法
      const eq = token.indexOf('=');
      const flag = eq === -1 ? token : token.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

      if (VALUE_FLAGS.has(flag)) {
        let value: string | undefined = inlineValue;
        if (value === undefined) {
          value = argv[i + 1];
          if (value === undefined || value.startsWith('-')) {
            error = `选项 ${flag} 缺少参数值`;
            break;
          }
          i++; // 消费下一个 token 作为值
        }
        if (flag === '--base-url') options.baseUrl = value;
        else if (flag === '--agent') options.agent = value;
        else if (flag === '--model') options.model = value;
        else if (flag === '--session') options.session = value;
        else if (flag === '--cwd') options.cwd = value;
        else if (flag === '--data-file') options.dataFile = value;
        else if (flag === '--file' || flag === '--image') (options.files ??= []).push(value);
        continue;
      }

      if (BOOL_FLAGS.has(flag) || flag === '-h' || flag === '-v') {
        if (inlineValue !== undefined) {
          error = `选项 ${flag} 不接受参数值`;
          break;
        }
        if (flag === '--json') options.json = true;
        else if (flag === '--jsonl') options.jsonl = true;
        else if (flag === '--help' || flag === '-h') options.help = true;
        else if (flag === '--version' || flag === '-v') options.version = true;
        continue;
      }

      error = `未知选项：${flag}`;
      break;
    }

    // 非选项 token：首个为子命令，其余为位置参数
    if (command === null) {
      command = token;
    } else {
      positional.push(token);
    }
  }

  return { command, positional, options, ...(error !== undefined ? { error } : {}) };
}
