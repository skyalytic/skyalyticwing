import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { runShell } from '../executor/built-in/shell-runner.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** mcporter 执行结果 */
export interface McporterResult {
  stdout: string;
  stderr: string;
}

/** 版本查询结果 */
export interface McporterVersionResult {
  version: string | null;
  success: boolean;
  error?: string;
}

/** MCP 服务列表结果 */
export interface McporterListServersResult {
  success: boolean;
  servers: unknown[] | string[];
  raw?: string;
  error?: string;
}

/** MCP 工具列表结果 */
export interface McporterListToolsResult {
  success: boolean;
  tools: unknown[];
  server: string;
  raw?: string;
  error?: string;
}

/** 添加 MCP 服务结果 */
export interface McporterAddServerResult {
  success: boolean;
  name: string;
  url?: string;
  output?: string;
  error?: string;
}

/** 移除 MCP 服务结果 */
export interface McporterRemoveServerResult {
  success: boolean;
  name: string;
  output?: string;
  error?: string;
}

/** 调用 MCP 工具结果 */
export interface McporterCallToolResult {
  success: boolean;
  result: unknown;
  raw?: boolean;
  error?: string;
}

/** MCP 服务添加选项 */
export interface AddServerOptions {
  transport?: string;
  scope?: string;
  header?: string | string[];
}

/** mcporter 可用性结果 */
export interface McporterAvailability {
  available: boolean;
  version: string | null;
}

/** mcporter 运行状态 */
export interface McporterStatus {
  initialized: boolean;
  cliPath: string | null;
  configDir: string | null;
}

/** 默认执行超时（60s） */
const DEFAULT_TIMEOUT = 60_000;
/** Tool execution has no implicit deadline. */
const CALL_TOOL_TIMEOUT = 0;

/**
 * McporterService - mcporter CLI 管理服务
 *
 * 职责：
 *   - 定位 mcporter CLI 路径（本地 node_modules/.bin 优先，回退全局安装）
 *   - 执行 mcporter 命令（version / config list / config add / config remove / list / call）
 *   - 管理 mcporter 配置目录（MCPORTER_CONFIG_DIR 环境变量）
 *
 * 安全：
 *   - Windows .cmd 文件通过 cmd.exe /c 包装执行，对 cmd 元字符进行转义防止命令注入
 *   - 使用 windowsVerbatimArguments 避免 Node 二次转义
 *
 * 对应原始实现：packages/web/mcporter-manager.cjs（MCPorterManager）
 */
@Injectable()
export class McporterService implements OnModuleInit {
  private readonly logger = new Logger(McporterService.name);
  private cliPath: string | null = null;
  private configDir: string | null = null;
  private initialized = false;

  onModuleInit(): void {
    const dataDir = process.env['SKYALYTICWING_DATA_DIR'] || this.getDefaultDataDir();
    this.init(dataDir);
  }

  /** 初始化：确定 CLI 路径与配置目录 */
  init(dataDir?: string): void {
    // 确定 mcporter CLI 路径（本地安装优先）
    const localBin = join(process.cwd(), 'node_modules', '.bin', 'mcporter');
    const localBinCmd = localBin + '.cmd'; // Windows
    if (process.platform === 'win32' && existsSync(localBinCmd)) {
      this.cliPath = localBinCmd;
    } else if (existsSync(localBin)) {
      this.cliPath = localBin;
    } else {
      // 回退到全局安装
      this.cliPath = 'mcporter';
    }

    // mcporter 配置目录
    this.configDir = join(dataDir || homedir(), 'mcporter');
    if (!existsSync(this.configDir)) {
      try {
        mkdirSync(this.configDir, { recursive: true });
      } catch {
        // 忽略创建失败
      }
    }

    this.initialized = true;
    this.logger.log(`Initialized, CLI path: ${this.cliPath}`);
  }

  /**
   * 执行 mcporter 命令。
   * Windows 上 .cmd 文件需通过 cmd.exe /c 包装，并对元字符转义防止命令注入。
   */
  private async exec(args: string[], options?: Record<string, unknown>): Promise<McporterResult> {
    if (!this.initialized && !this.cliPath) {
      this.init();
    }

    const opts: Record<string, unknown> = {
      timeout: DEFAULT_TIMEOUT,
      env: { ...process.env, MCPORTER_CONFIG_DIR: this.configDir },
      ...options,
    };

    let cmd = this.cliPath as string;
    let finalArgs = [...args];

    // Windows 上 .cmd 文件需要通过 cmd.exe 执行
    if (process.platform === 'win32' && cmd && cmd.endsWith('.cmd')) {
      // cmd.exe /c 包装时 args 需对 cmd 元字符（&|<>()^%!）转义
      // 否则 args 含 `&` 等会被 cmd.exe 解析为命令分隔符，导致命令注入
      // 转义策略：先用 ^ 转义元字符，再用双引号包裹（defense-in-depth）
      const escapeCmdArg = (arg: string): string => {
        const s = String(arg == null ? '' : arg);
        const escaped = s.replace(/([&|<>()^%!])/g, '^$1');
        return '"' + escaped.replace(/"/g, '""') + '"';
      };
      const escapedArgs = finalArgs.map((a) => escapeCmdArg(a));
      // 把整个命令拼成单一字符串传给 /c，避免 cmd.exe 的多 /c 解析问题
      finalArgs = ['/c', '"' + cmd + '" ' + escapedArgs.join(' ')];
      cmd = 'cmd.exe';
      // 使用 windowsVerbatimArguments 让 Node 不再二次转义
      (opts as Record<string, unknown>)['windowsVerbatimArguments'] = true;
    }

    try {
      const result = await runShell(cmd, finalArgs, {
        cwd: this.configDir || homedir(), sessionId: '', readOnly: true, separateStderr: true,
        timeout: typeof opts['timeout'] === 'number' ? opts['timeout'] : 0,
        windowsVerbatimArguments: opts['windowsVerbatimArguments'] === true,
        env: opts['env'] as NodeJS.ProcessEnv,
      });
      const details = result.data as {stderrPreview?:string;previewPartial?:boolean;outputPath?:string;stderrPath?:string};
      if (!result.success) throw new Error((details.stderrPreview || result.error || 'mcporter failed') + ` (output: ${details.outputPath})`);
      // Large structured results remain readable from disk instead of killing the CLI
      // or trying to allocate the entire result in memory.
      return {
        stdout: details.previewPartial ? JSON.stringify({outputPath:details.outputPath,stderrPath:details.stderrPath,requiresFileRead:true,preview:result.output}) : (result.output || '').trim(),
        stderr: details.stderrPreview || '',
      };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const errMsg = (e.stderr || '').trim() || e.message || String(err);
      throw new Error(errMsg);
    }
  }

  /** 获取 mcporter 版本 */
  async version(): Promise<McporterVersionResult> {
    try {
      const r = await this.exec(['--version']);
      return { version: r.stdout, success: true };
    } catch (e) {
      return { version: null, success: false, error: (e as Error).message };
    }
  }

  /** 列出所有已配置的 MCP 服务 */
  async listServers(): Promise<McporterListServersResult> {
    try {
      const r = await this.exec(['config', 'list', '--json']);
      try {
        const data = JSON.parse(r.stdout);
        return { success: true, servers: data.servers || data || [] };
      } catch {
        // 非 JSON 输出，解析文本
        const lines = r.stdout.split('\n').filter((l) => l.trim());
        return { success: true, servers: lines, raw: r.stdout };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message, servers: [] };
    }
  }

  /** 列出指定服务的工具 */
  async listTools(serverName: string): Promise<McporterListToolsResult> {
    try {
      const r = await this.exec(['list', serverName, '--json']);
      try {
        const data = JSON.parse(r.stdout);
        return { success: true, tools: data.tools || data || [], server: serverName };
      } catch {
        return { success: true, tools: [], server: serverName, raw: r.stdout };
      }
    } catch (e) {
      return { success: false, error: (e as Error).message, tools: [], server: serverName };
    }
  }

  /** 添加 MCP 服务（URL 接入，通用） */
  async addServer(name: string, url: string, options?: AddServerOptions): Promise<McporterAddServerResult> {
    const args = ['config', 'add', name, '--url', url];
    if (options?.transport) {
      args.push('--transport', options.transport);
    }
    if (options?.scope) {
      args.push('--scope', options.scope);
    }
    if (options?.header) {
      if (Array.isArray(options.header)) {
        options.header.forEach((h) => args.push('--header', h));
      } else {
        args.push('--header', options.header);
      }
    }
    try {
      const r = await this.exec(args);
      return { success: true, name, url, output: r.stdout };
    } catch (e) {
      return { success: false, error: (e as Error).message, name };
    }
  }

  /** 移除 MCP 服务 */
  async removeServer(name: string): Promise<McporterRemoveServerResult> {
    try {
      const r = await this.exec(['config', 'remove', name]);
      return { success: true, name, output: r.stdout };
    } catch (e) {
      return { success: false, error: (e as Error).message, name };
    }
  }

  /** 调用 MCP 工具 */
  async callTool(serverDotTool: string, argsObj?: Record<string, unknown>): Promise<McporterCallToolResult> {
    const args = ['call', serverDotTool, '--output', 'json'];
    if (argsObj && Object.keys(argsObj).length > 0) {
      args.push('--args', JSON.stringify(argsObj));
    }
    try {
      const r = await this.exec(args, { timeout: CALL_TOOL_TIMEOUT });
      try {
        const data = JSON.parse(r.stdout);
        return { success: true, result: data };
      } catch {
        return { success: true, result: r.stdout, raw: true };
      }
    } catch (e) {
      return { success: false, result: undefined, error: (e as Error).message };
    }
  }

  /** 检查 mcporter 是否可用 */
  async isAvailable(): Promise<McporterAvailability> {
    try {
      const r = await this.exec(['--version']);
      return { available: true, version: r.stdout };
    } catch {
      return { available: false, version: null };
    }
  }

  /** 获取状态信息 */
  getStatus(): McporterStatus {
    return {
      initialized: this.initialized,
      cliPath: this.cliPath,
      configDir: this.configDir,
    };
  }

  /** 获取默认数据目录（跨平台） */
  private getDefaultDataDir(): string {
    const plat = process.platform;
    if (plat === 'win32') {
      const appData = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'SkyalyticWing');
    }
    if (plat === 'darwin') {
      return join(homedir(), 'Library', 'Application Support', 'SkyalyticWing');
    }
    const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    return join(xdg, 'skyalyticwing');
  }
}
