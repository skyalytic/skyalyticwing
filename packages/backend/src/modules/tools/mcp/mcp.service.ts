import { ChatControlRegistry } from '../../ai/chat/chat-control.registry.js';
import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { Server as HttpServer, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolResult, ToolContext, ToolParameterSchema } from '@skyalyticwing/shared';
import { getDefaultDataDir, loadJsonFile, resolveWebDataDir, saveJsonFile } from '../../core/utils/web-data.util.js';
import { sealSecret, openSecret } from '../../core/utils/local-secrets.js';
import { mcpCommand } from './mcp-command.js';

/** MCP 服务器配置（含敏感 env，仅内部存储） */
export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  credentialOwner?: string;
  enabled: boolean;
}

/** MCP 服务器信息（对外展示，脱敏：不含 env） */
export interface McpServerInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  status: 'stopped' | 'running' | 'error';
}

/** MCP 回环服务器状态（token 脱敏） */
export interface McpLoopbackStatus {
  running: boolean;
  port: number;
  token: string;
  url: string;
  config: {
    mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
  } | null;
}

/** MCP 渠道会话 */
interface ChannelSession {
  messages: Array<{ role: string; content: string; timestamp: number; id: string }>;
  createdAt: number;
}

/** MCP 渠道事件 */
interface ChannelEvent {
  cursor: number;
  type: string;
  data: unknown;
  timestamp: number;
}

/** MCP 服务器调用统计 */
interface ServerStats {
  calls: number;
  errors: number;
  lastCall: number | null;
}

/** MCP probe 结果 */
export interface McpProbeResult {
  serverId: string;
  serverName: string;
  transport: string;
  connected: boolean;
  capabilities: { tools: boolean; resources: boolean; prompts: boolean };
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  errors: string[];
  probedAt: string;
}

/** MCP doctor 检查项 */
export interface McpDoctorCheck {
  check: string;
  status: 'pass' | 'fail' | 'warn' | 'info';
  message: string;
}

/** MCP doctor 结果 */
export interface McpDoctorResult {
  serverId: string;
  serverName: string;
  healthy: boolean;
  checks: McpDoctorCheck[];
  diagnosedAt: string;
}

/** MCP 市场连接器条目（预置官方 MCP 服务器目录） */
export interface McpMarketEntry {
  /** 唯一 key（安装时使用） */
  key: string;
  /** 展示名（安装后作为 MCP 服务器名） */
  name: string;
  description: string;
  /** 分类（市场页签过滤） */
  category: string;
  /** 启动命令（stdio） */
  command: string;
  args: string[];
  /** 需要用户填写的环境变量名 */
  envKeys: string[];
  /** 官方主页/仓库 */
  homepage: string;
}

/**
 * 构建通用 MCP 市场目录（通用市场连接器，不绑定任何单一渠道商）。
 * 全部为社区通用官方 MCP 服务器，stdio 启动：
 *   - npx 系：Node 生态（@modelcontextprotocol/* 等）
 *   - uvx 系：Python 生态（mcp-server-fetch 等，需本机安装 uv）
 */
export function buildMarketCatalog(): McpMarketEntry[] {
  const home = homedir();
  return [
    {
      key: 'filesystem',
      name: 'Filesystem 文件系统',
      description: '读写指定目录下的本地文件，支持目录树、搜索与元信息（官方 @modelcontextprotocol/server-filesystem）',
      category: '文件与本地',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', home],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'fetch',
      name: 'Fetch 网页抓取',
      description: '抓取网页并转为 Markdown 供模型阅读（mcp-server-fetch，需本机安装 uv/uvx）',
      category: '网络与抓取',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'memory',
      name: 'Memory 知识记忆',
      description: '基于知识图谱的长期记忆，跨会话记住实体与关系（官方 server-memory）',
      category: '记忆与推理',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'sequential-thinking',
      name: 'Sequential Thinking 顺序思考',
      description: '动态多步思考与反思的推理脚手架，适合复杂问题拆解（官方 server-sequential-thinking）',
      category: '记忆与推理',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'github',
      name: 'GitHub',
      description: '仓库/Issue/PR/文件 API 访问，需填写 GITHUB_TOKEN（官方 server-github）',
      category: '开发协作',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envKeys: ['GITHUB_TOKEN'],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'brave-search',
      name: 'Brave 搜索',
      description: '联网网页搜索，需填写 BRAVE_API_KEY（官方 server-brave-search）',
      category: '网络与抓取',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      envKeys: ['BRAVE_API_KEY'],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'puppeteer',
      name: 'Puppeteer 浏览器',
      description: '驱动无头浏览器完成网页导航、截图与交互（官方 server-puppeteer）',
      category: '浏览器自动化',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'git',
      name: 'Git 仓库',
      description: '读取本地 Git 仓库的日志、状态、diff 等信息（mcp-server-git，需 uv/uvx）',
      category: '开发协作',
      command: 'uvx',
      args: ['mcp-server-git'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'time',
      name: 'Time 时间日历',
      description: '查询时区时间与日期换算（mcp-server-time，需 uv/uvx）',
      category: '效率工具',
      command: 'uvx',
      args: ['mcp-server-time'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'sqlite',
      name: 'SQLite 数据库',
      description: '对本地 SQLite 数据库执行查询与表结构浏览（mcp-server-sqlite，需 uv/uvx）',
      category: '数据库',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', join(home, 'skyalyticwing-mcp.sqlite')],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
    {
      key: 'context7',
      name: 'Context7 文档',
      description: '拉取主流框架/库的最新官方文档片段（@upstash/context7-mcp）',
      category: '开发协作',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      envKeys: [],
      homepage: 'https://github.com/upstash/context7',
    },
    {
      key: 'everything',
      name: 'Everything 示例',
      description: '官方示例服务器，覆盖 echo/加法等全部 MCP 能力，适合联调测试',
      category: '官方示例',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      envKeys: [],
      homepage: 'https://github.com/modelcontextprotocol/servers',
    },
  ];
}

type ServerStatus = 'stopped' | 'running' | 'error';

interface ServerEntry {
  config: McpServerConfig;
  client?: McpStdioClient | undefined;
  status: ServerStatus;
  stats: ServerStats;
}

/** JSON-RPC 请求的待处理句柄 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

/** MCP 工具描述（来自 tools/list） */
interface McpToolDescriptor {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema?: ToolParameterSchema | Record<string, unknown>;
}

/** MCP tools/call 返回内容项 */
interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpCallResult {
  content?: McpContentItem[];
  isError?: boolean;
}

/** MCP 资源描述（resources/list） */
export interface McpResourceDescriptor {
  uri?: string;
  name?: string;
  mimeType?: string;
  description?: string;
  [key: string]: unknown;
}

/** MCP 提示模板描述（prompts/list） */
export interface McpPromptDescriptor {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

const REQUEST_TIMEOUT = 30_000;
const LOOPBACK_SERVER_NAME = 'SkyalyticWing-MCP-Loopback';
const LOOPBACK_SERVER_VERSION = '1.0.0';
const LOOPBACK_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const CHANNEL_EVENT_MAX_QUEUE = 1000;
const CHANNEL_EVENT_DEFAULT_TIMEOUT = 30_000;

/**
 * McpStdioClient - MCP stdio JSON-RPC 客户端
 *
 * 通过子进程的 stdin/stdout 进行换行分隔的 JSON-RPC 2.0 通信。
 * 支持 initialize / tools/list / tools/call / resources/* / prompts/*，带请求超时与进程退出清理。
 */
class McpStdioClient {
  private readonly logger = new Logger('McpStdioClient');
  private proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private readonly secretValues: string[];

  constructor(
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd?: string,
  ) {
    this.secretValues = Object.entries(env).filter(([key])=>/key|token|secret|pass|auth|credential/i.test(key))
      .flatMap(([,value])=>[value,value.replace(/^Bearer\s+/i,'')]).filter(value=>value.length>=4);
    const launch=mcpCommand(command,args,env);
    this.proc = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: launch.env,
      cwd,
      windowsHide: true,
    });
    this.proc.stdout?.setEncoding('utf-8');
    this.proc.stdout?.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      let text = chunk.toString('utf-8').trim();
      text = this.cleanError(text);
      if (text) this.logger.debug(`[mcp stderr] ${text.slice(-4000)}`);
    });
    this.proc.on('error', (err) => this.failAll(err));
    this.proc.on('exit', (code) => {
      this.failAll(new Error(`MCP process exited (code=${code})`));
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** 初始化握手 */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'skyalyticwing', version: '1.0.0' },
    }, 180_000);
    this.notify('notifications/initialized');
  }

  /** 列出工具 */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDescriptor[] };
    return result?.tools ?? [];
  }

  /** 调用工具 */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.request('tools/call', { name, arguments: args ?? {} }, 0, signal)) as McpCallResult;
  }

  /** 列出资源（resources/list） */
  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request('resources/list', {})) as { resources?: McpResourceDescriptor[] };
    return result?.resources ?? [];
  }

  /** 读取资源（resources/read） */
  async readResource(uri: string): Promise<unknown> {
    return this.request('resources/read', { uri });
  }

  /** 列出提示模板（prompts/list） */
  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request('prompts/list', {})) as { prompts?: McpPromptDescriptor[] };
    return result?.prompts ?? [];
  }

  /** 获取提示模板（prompts/get） */
  async getPrompt(name: string, args: unknown): Promise<unknown> {
    return this.request('prompts/get', { name, arguments: args ?? {} });
  }

  /** 关闭连接并终止进程 */
  close(): void {
    this.failAll(new Error('MCP connection closed'));
    try {
      this.proc.stdin?.end();
    } catch {}
    try {
      this.proc.kill();
    } catch {}
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // 通知或无 id 消息，忽略
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(this.cleanError(msg.error.message ?? 'MCP error')));
    } else {
      pending.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown, timeout = REQUEST_TIMEOUT, signal?: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      if (signal?.aborted) { reject(new Error('MCP tool cancelled')); return; }
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer);
        this.notify('notifications/cancelled', {requestId:id,reason:'User cancelled'});
        pending.reject(new Error('MCP tool cancelled'));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id); cleanup();
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeout) : undefined;
      this.pending.set(id, {resolve:value=>{cleanup();resolve(value);},reject:error=>{cleanup();reject(error);},timer});
      signal?.addEventListener('abort', abort, {once:true});
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        if (!this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) throw new Error('MCP input stream is closed');
        this.proc.stdin.write(payload, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error); }
        });
      } catch (err) {
        clearTimeout(timer); cleanup();
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try {
      this.proc.stdin?.write(payload);
    } catch {}
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.cleanError(err.message)));
    }
    this.pending.clear();
  }
  private cleanError(value: string): string {
    for (const secret of this.secretValues) value = value.split(secret).join('[redacted]');
    return value;
  }
}

/**
 * McpService - MCP (Model Context Protocol) 服务器管理
 *
 * 管理 MCP 服务器配置与子进程生命周期，通过 stdio JSON-RPC 与服务器通信，
 * 暴露 listTools / callTool / resources / prompts 供控制器调用；
 * 同时提供回环 MCP 服务器（将内部能力以 MCP 协议暴露到 127.0.0.1）、
 * MCP 渠道桥（会话/消息/事件）与 probe / doctor 诊断。
 *
 * 配置持久化（mcp.json，与旧版 start.cjs _persist 格式兼容）：
 *   - 路径优先用户数据目录（SKYALYTICWING_DATA_DIR / %APPDATA%/SkyalyticWing），
 *     目录无文件时回退 packages/web/data 读取（仅读取，写回始终写用户目录）
 *   - 持久化 id/name/command/args/enabled；env 使用本机密钥加密为 sealedEnv
 *   - addServer / updateServer / removeServer 后写回
 *
 * 安全：服务器信息对外脱敏（不含 env）；回环 token 仅完整返回一次，状态查询时脱敏。
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() private readonly resourcePolicy?: LocalResourcePolicy) {}
  private credentialRefresh?: (id:string)=>Promise<void>;
  setCredentialRefresh(refresh:(id:string)=>Promise<void>):void {this.credentialRefresh=refresh;}
  private async refreshCredentials(id:string):Promise<void>{
    const scope = this.activeResourceRoot;
    this.assertCredentialOwner(id);
    const running=this.servers.get(id)?.status==='running';
    await this.credentialRefresh?.(id);
    this.assertResourceScope(scope);
    if(running&&this.servers.get(id)?.status==='stopped'&&this.servers.get(id)?.config.enabled)await this.startServer(id);
  }
  private assertResourceScope(scope: string): void {
    if (this.resourceRoot() !== scope) throw new Error('当前身份已变化，请重新选择 MCP 工具');
  }
  private readonly logger = new Logger(McpService.name);
  private readonly servers = new Map<string, ServerEntry>();
  private activeResourceRoot = '';
  private switchingResources = false;
  private resourceRoot() { return this.resourcePolicy?.localResourceRoot?.(getDefaultDataDir()) || getDefaultDataDir(); }
  private ensureResourceScope(): void {
    if (this.switchingResources) return;
    const root = this.resourceRoot();
    if (this.activeResourceRoot === root) return;
    this.switchingResources = true;
    try {
      for (const id of this.servers.keys()) this.stopServer(id);
      this.servers.clear(); this.starting.clear();
      this.activeResourceRoot = root;
      this.onModuleInit();
    } finally { this.switchingResources = false; }
  }

  // ── 回环 MCP 服务器状态 ──
  private loopbackServer: HttpServer | null = null;
  private loopbackPort = 0;
  private loopbackToken = '';
  private loopbackStarted = false;
  private readonly loopbackSseClients = new Set<ServerResponse>();
  private loopbackPreferredPort = 0;

  // ── MCP 渠道桥状态 ──
  private readonly channelSessions = new Map<string, ChannelSession>();
  private channelEventQueue: ChannelEvent[] = [];
  private channelEventCursor = 0;
  private readonly channelEventWaiters = new Set<(evt: ChannelEvent | null) => void>();

  /** 列出全部服务器（脱敏） */
  listServers(): McpServerInfo[] {
    this.ensureResourceScope();
    return Array.from(this.servers.values()).map((e) => this.toInfo(e));
  }

  /** Internal service access only; controllers must never serialize these credentials. */
  getEnvironmentForConfiguration(id: string): Record<string, string> {
    this.ensureResourceScope();
    const config = this.servers.get(id)?.config;
    return this.ownsCredentials(config) ? { ...config?.env } : {};
  }

  private credentialIdentity(): string { return this.resourcePolicy?.credentialIdentity?.() || 'local'; }
  private ownsCredentials(config?: McpServerConfig): boolean {
    return !config || (config.credentialOwner || 'local') === this.credentialIdentity();
  }
  private assertCredentialOwner(id: string): void {
    const config = this.servers.get(id)?.config;
    if (!this.ownsCredentials(config)) {
      this.stopServer(id);
      throw new Error('账号或企业已切换，请为当前身份重新填写此连接器的授权信息');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 配置持久化（mcp.json）
  // ════════════════════════════════════════════════════════════════

  /** mcp.json 读取路径：优先用户数据目录，其次 packages/web/data（兼容旧版数据） */
  private resolveMcpConfigPath(): string {
    const userPath = join(this.resourceRoot(), 'mcp.json');
    if (this.resourceRoot() !== getDefaultDataDir()) return userPath;
    if (existsSync(userPath)) return userPath;
    return join(resolveWebDataDir(), 'mcp.json');
  }

  /** mcp.json 写入路径：始终用户数据目录 */
  private get mcpConfigWritePath(): string {
    return join(this.activeResourceRoot || this.resourceRoot(), 'mcp.json');
  }

  /**
   * 启动时加载 mcp.json（仅当内存为空且文件存在时）。
   * 格式与旧版 start.cjs 兼容：{ servers: [{ id, name, command, args, enabled, ... }] }，
   * 从 sealedEnv 解密恢复环境变量；旧版无加密凭据时使用空对象。
   */
  onModuleInit(): void {
    this.activeResourceRoot = this.resourceRoot();
    if (this.servers.size > 0) return;
    const configPath = this.resolveMcpConfigPath();
    if (!existsSync(configPath)) return;
    try {
      const store = loadJsonFile<{ servers?: Array<Record<string, unknown>> }>(configPath, {});
      const servers = Array.isArray(store.servers) ? store.servers : [];
      let loaded = 0;
      for (const raw of servers) {
        if (!raw || typeof raw !== 'object') continue;
        const id = typeof raw['id'] === 'string' ? raw['id'] : randomUUID();
        const command = typeof raw['command'] === 'string' ? raw['command'] : '';
        if (!command || this.servers.has(id)) continue;
        this.servers.set(id, {
          config: {
            id,
            name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : id,
            command,
            args: Array.isArray(raw['args']) ? (raw['args'] as string[]) : [],
            env: typeof raw['sealedEnv']==='string' ? openSecret<Record<string,string>>(raw['sealedEnv'], 'mcp:'+id) : {},
            credentialOwner: typeof raw['credentialOwner']==='string' ? raw['credentialOwner'] : 'local',
            enabled: raw['enabled'] !== false,
          },
          status: 'stopped',
          stats: { calls: 0, errors: 0, lastCall: null },
        });
        loaded++;
      }
      if (loaded > 0) {
        this.logger.log(`Loaded ${loaded} MCP server config(s) from ${configPath}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to load mcp.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 写回 mcp.json（敏感 env 仅以 sealedEnv 密文落盘） */
  private persist(): void {
    try {
      const servers: Array<Record<string, unknown>> = [];
      for (const entry of this.servers.values()) {
        servers.push({
          id: entry.config.id,
          name: entry.config.name,
          command: entry.config.command,
          args: entry.config.args ?? [],
          enabled: entry.config.enabled,
          credentialOwner: entry.config.credentialOwner || 'local',
          sealedEnv: sealSecret(entry.config.env || {}, 'mcp:'+entry.config.id),
        });
      }
      saveJsonFile(this.mcpConfigWritePath, { servers });
      // Recovery copies must not resurrect a credential that the user revoked.
      saveJsonFile(this.mcpConfigWritePath, { servers });
    } catch (err) {
      this.logger.warn('Failed to persist mcp.json');
      throw err;
    }
  }

  /** 添加服务器配置 */
  addServer(config: Omit<McpServerConfig, 'id'> & { id?: string }): McpServerInfo {
    this.ensureResourceScope();
    const id = config.id ?? randomUUID();
    if (this.servers.has(id)) throw new Error(`MCP server already exists: ${id}`);
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new Error('MCP server "command" is required');
    }
    const full: McpServerConfig = {
      id,
      name: config.name || id,
      command: config.command,
      args: Array.isArray(config.args) ? config.args : [],
      env: config.env && typeof config.env === 'object' ? { ...config.env } : {},
      credentialOwner: this.credentialIdentity(),
      enabled: config.enabled !== false,
    };
    this.servers.set(id, { config: full, status: 'stopped', stats: { calls: 0, errors: 0, lastCall: null } });
    try{this.persist();}catch(e){this.servers.delete(id);throw e;}
    this.logger.log(`Added MCP server ${id} (${full.command})`);
    return this.toInfo(this.servers.get(id)!);
  }

  /** 获取 MCP 市场目录（预置官方连接器） */
  getMarketCatalog(): McpMarketEntry[] {
    return []; // Remote discovery is exclusively served by Skyalytic Ecosystem.
  }

  /** 从市场一键添加连接器：按 key 查目录并创建为 MCP 服务器配置（同名已存在则报错） */
  installFromMarket(_key: string, _env?: Record<string, string>): McpServerInfo {
    throw new Error('请使用 Skyalytic 官网生态页面安装经过校验的连接器');
  }

  /** 更新服务器配置（运行中则需先停止） */
  updateServer(id: string, config: Partial<Omit<McpServerConfig, 'id'>>): McpServerInfo {
    this.ensureResourceScope();
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (entry.status === 'running') {
      throw new Error(`Stop server before updating: ${id}`);
    }
    const previous=structuredClone(entry.config);
    if (typeof config.name === 'string') entry.config.name = config.name;
    if (typeof config.command === 'string' && config.command.length > 0) entry.config.command = config.command;
    if (Array.isArray(config.args)) entry.config.args = config.args;
    if (config.env && typeof config.env === 'object') {
      entry.config.env = { ...config.env };
      entry.config.credentialOwner = this.credentialIdentity();
    }
    if (typeof config.enabled === 'boolean') entry.config.enabled = config.enabled;
    try{this.persist();}catch(e){entry.config=previous;throw e;}
    return this.toInfo(entry);
  }

  /** 删除服务器（运行中则先停止） */
  removeServer(id: string): void {
    this.ensureResourceScope();
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (entry.client) {
      entry.client.close();
      entry.client = undefined;
    }
    entry.status = 'stopped';
    this.servers.delete(id);
    try{this.persist();}catch(e){this.servers.set(id,entry);throw e;}
    this.logger.log(`Removed MCP server ${id}`);
  }

  /** 启动服务器（spawn 子进程并完成 initialize 握手） */
  async startServer(id: string): Promise<void> {
    this.ensureResourceScope();
    const scope = this.activeResourceRoot;
    await this.resourcePolicy?.assert('mcp', id);
    this.assertResourceScope(scope);
    this.assertCredentialOwner(id);
    await this.credentialRefresh?.(id);
    this.assertResourceScope(scope);
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (!entry.config.enabled) throw new Error(`MCP server is disabled: ${id}`);
    if (entry.status === 'running' && entry.client) return;
    const pending = this.starting.get(id);
    if (pending) return pending;
    const operation = this.initializeServer(id, entry);
    this.starting.set(id, operation);
    try { await operation; }
    finally { if (this.starting.get(id) === operation) this.starting.delete(id); }
  }

  private readonly starting = new Map<string, Promise<void>>();

  private async initializeServer(id: string, entry: ServerEntry): Promise<void> {
    let client: McpStdioClient | undefined;
    try {
      client = new McpStdioClient(
        entry.config.command,
        entry.config.args ?? [],
        entry.config.env ?? {},
      );
      // Keep the in-flight child reachable so stop/remove/shutdown can cancel it.
      entry.client = client;
      await client.initialize();
      if (this.servers.get(id) !== entry || entry.client !== client) throw new Error('MCP startup cancelled');
      entry.status = 'running';
      this.logger.log(`Started MCP server ${id} (pid=${client.pid})`);
    } catch (err) {
      client?.close();
      if (entry.client === client) {
        entry.status = 'error';
        entry.client = undefined;
      }
      throw err;
    }
  }

  /** 停止服务器 */
  stopServer(id: string): void {
    this.ensureResourceScope();
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (entry.client) {
      entry.client.close();
      entry.client = undefined;
    }
    entry.status = 'stopped';
    this.logger.log(`Stopped MCP server ${id}`);
  }

  /** 列出服务器的工具（返回 ToolDefinition[]，execute 回调到 MCP 服务器） */
  async listTools(serverId: string): Promise<ToolDefinition[]> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('mcp', serverId);
    await this.refreshCredentials(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`MCP server not found: ${serverId}`);
    if (!entry.client || entry.status !== 'running') {
      throw new Error(`MCP server not running: ${serverId}`);
    }
    const tools = await entry.client.listTools();
    return tools.map((t) => this.toToolDefinition(serverId, t));
  }

  /** 调用服务器上的工具 */
  async callTool(serverId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('mcp', serverId);
    this.assertCredentialOwner(serverId);
    await this.refreshCredentials(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`MCP server not found: ${serverId}`);
    if (!entry.client || entry.status !== 'running') {
      throw new Error(`MCP server not running: ${serverId}`);
    }
    try {
      const result = await entry.client.callTool(toolName, args, signal);
      entry.stats.calls++;
      entry.stats.lastCall = Date.now();
      return this.redactResult(serverId, this.toToolResult(result));
    } catch (err) {
      entry.stats.calls++;
      entry.stats.errors++;
      entry.stats.lastCall = Date.now();
      return this.redactResult(serverId, { success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 资源与提示模板（JSON-RPC resources/* 与 prompts/*）
  // ════════════════════════════════════════════════════════════════

  /** 列出服务器资源（resources/list） */
  async listResources(serverId: string): Promise<{ resources: McpResourceDescriptor[]; error?: string }> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('mcp', serverId);
    await this.refreshCredentials(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) return { resources: [], error: 'Server not found' };
    if (!entry.client || entry.status !== 'running') {
      return { resources: [], error: 'Server not running' };
    }
    try {
      const resources = await entry.client.listResources();
      return { resources };
    } catch (err) {
      return { resources: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 读取服务器资源（resources/read） */
  async readResource(serverId: string, uri: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('mcp', serverId);
    await this.refreshCredentials(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) return { success: false, error: 'Server not found' };
    if (!entry.client || entry.status !== 'running') {
      return { success: false, error: 'Server not running' };
    }
    try {
      const result = await entry.client.readResource(uri);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 列出服务器提示模板（prompts/list） */
  async listPrompts(serverId: string): Promise<{ prompts: McpPromptDescriptor[]; error?: string }> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('mcp', serverId);
    await this.refreshCredentials(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) return { prompts: [], error: 'Server not found' };
    if (!entry.client || entry.status !== 'running') {
      return { prompts: [], error: 'Server not running' };
    }
    try {
      const prompts = await entry.client.listPrompts();
      return { prompts };
    } catch (err) {
      return { prompts: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 获取提示模板（prompts/get） */
  async getPrompt(serverId: string, name: string, args: unknown): Promise<{ success: boolean; result?: unknown; error?: string }> {
    this.ensureResourceScope();
    await this.resourcePolicy?.assert('mcp', serverId);
    await this.refreshCredentials(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) return { success: false, error: 'Server not found' };
    if (!entry.client || entry.status !== 'running') {
      return { success: false, error: 'Server not running' };
    }
    try {
      const result = await entry.client.getPrompt(name, args);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 探测与诊断（probe / doctor）
  // ════════════════════════════════════════════════════════════════

  /** 探测服务器能力（必要时临时启动，探测后停止） */
  async probe(serverId: string): Promise<McpProbeResult> {
    this.ensureResourceScope();
    const entry = this.servers.get(serverId);
    const result: McpProbeResult = {
      serverId,
      serverName: entry?.config.name ?? '',
      transport: 'stdio',
      connected: false,
      capabilities: { tools: false, resources: false, prompts: false },
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      errors: [],
      probedAt: new Date().toISOString(),
    };
    if (!entry) {
      result.errors.push('Server not found');
      return result;
    }
    const wasRunning = entry.status === 'running';
    if (!wasRunning) {
      try {
        await this.startServer(serverId);
      } catch (err) {
        result.errors.push(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
        return result;
      }
    }
    const [toolsRes, resourcesRes, promptsRes] = await Promise.all([
      this.listTools(serverId)
        .then((tools) => ({ count: tools.length, error: null as string | null }))
        .catch((err: unknown) => ({ count: 0, error: `tools: ${err instanceof Error ? err.message : String(err)}` })),
      this.listResources(serverId).then(
        (r) => ({ count: r.resources.length, error: r.error ? `resources: ${r.error}` : null }),
      ),
      this.listPrompts(serverId).then(
        (p) => ({ count: p.prompts.length, error: p.error ? `prompts: ${p.error}` : null }),
      ),
    ]);
    result.toolCount = toolsRes.count;
    result.resourceCount = resourcesRes.count;
    result.promptCount = promptsRes.count;
    for (const part of [toolsRes, resourcesRes, promptsRes]) {
      if (part.error) result.errors.push(part.error);
    }
    result.connected = true;
    result.capabilities.tools = result.toolCount > 0;
    result.capabilities.resources = result.resourceCount > 0;
    result.capabilities.prompts = result.promptCount > 0;
    if (!wasRunning) {
      try {
        this.stopServer(serverId);
      } catch {
        /* ignore */
      }
    }
    return result;
  }

  /** MCP 服务器诊断（配置/命令/状态/错误率检查） */
  doctor(serverId: string): McpDoctorResult {
    this.ensureResourceScope();
    const entry = this.servers.get(serverId);
    if (!entry) {
      return {
        serverId,
        serverName: '',
        healthy: false,
        checks: [{ check: 'config', status: 'fail', message: 'Server not found' }],
        diagnosedAt: new Date().toISOString(),
      };
    }
    const server = entry.config;
    const checks: McpDoctorCheck[] = [];
    let healthy = true;
    if (!server.command) {
      checks.push({ check: 'config', status: 'fail', message: 'No command configured' });
      healthy = false;
    } else {
      checks.push({ check: 'config', status: 'pass', message: 'Has command configured' });
      checks.push({
        check: 'command',
        status: 'pass',
        message: `Command: ${server.command} ${(server.args ?? []).join(' ')}`,
      });
    }
    if (server.enabled) {
      checks.push({ check: 'enabled', status: 'pass', message: 'Server is enabled' });
    } else {
      checks.push({ check: 'enabled', status: 'warn', message: 'Server is disabled' });
    }
    if (entry.status === 'running') {
      checks.push({ check: 'status', status: 'pass', message: 'Server is running' });
    } else if (entry.status === 'error') {
      checks.push({ check: 'status', status: 'fail', message: 'Server in error state' });
      healthy = false;
    } else {
      checks.push({ check: 'status', status: 'warn', message: `Server not running (status: ${entry.status})` });
    }
    if (entry.stats.errors > 0) {
      checks.push({
        check: 'error_rate',
        status: 'warn',
        message: `${entry.stats.errors} errors out of ${entry.stats.calls} calls`,
      });
    } else {
      checks.push({ check: 'error_rate', status: 'pass', message: 'No errors recorded' });
    }
    return {
      serverId,
      serverName: server.name,
      healthy,
      checks,
      diagnosedAt: new Date().toISOString(),
    };
  }

  /** MCP 聚合状态 */
  getStatusSummary(): {
    totalServers: number;
    running: number;
    loopback: McpLoopbackStatus;
  } {
    const entries = Array.from(this.servers.values());
    return {
      totalServers: entries.length,
      running: entries.filter((e) => e.status === 'running').length,
      loopback: this.getLoopbackStatus(),
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 内部工具暴露（expose）
  // ════════════════════════════════════════════════════════════════

  /**
   * 暴露内部工具为 MCP 服务器格式。
   *
   * 聚合回环内置工具（conversations_list 等）与所有运行中 MCP 服务器的工具
   * （以 mcp__<serverId>__<tool> 命名），与回环 tools/list 行为一致。
   */
  async exposeInternalTools(): Promise<
    Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  > {
    const exposed: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const tool of this.getLoopbackToolDescriptors()) {
      exposed.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    for (const [id, entry] of this.servers) {
      if (!entry.client || entry.status !== 'running') continue;
      try {
        const tools = await entry.client.listTools();
        for (const t of tools) {
          exposed.push({
            name: `mcp__${id}__${t.name}`,
            description: `[MCP:${entry.config.name}] ${t.description ?? t.name}`,
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          });
        }
      } catch {
        /* 服务器不可达时跳过 */
      }
    }
    return exposed;
  }

  // ════════════════════════════════════════════════════════════════
  // 回环 MCP 服务器（loopback）
  // ════════════════════════════════════════════════════════════════

  /** 启动回环 MCP 服务器（监听 127.0.0.1，Bearer token 鉴权） */
  async startLoopback(port = 0): Promise<{
    success: boolean;
    port?: number;
    token?: string;
    url?: string;
    message?: string;
    error?: string;
  }> {
    if (this.loopbackStarted && this.loopbackServer) {
      return {
        success: true,
        port: this.loopbackPort,
        token: this.loopbackToken,
        message: 'Loopback already running',
      };
    }
    const listenPort = port || this.loopbackPreferredPort || 0;
    this.loopbackToken = `sc-mcp-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const server = http.createServer((req, res) => this.handleLoopbackRequest(req, res));
    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.logger.error(`Loopback server error: ${err.message}`);
        this.loopbackServer = null;
        this.loopbackStarted = false;
        resolve({ success: false, error: err.message });
      });
      server.listen(listenPort, '127.0.0.1', () => {
        const addr = server.address();
        this.loopbackServer = server;
        this.loopbackPort = typeof addr === 'object' && addr ? addr.port : listenPort;
        this.loopbackStarted = true;
        this.logger.log(`MCP Loopback server started on 127.0.0.1:${this.loopbackPort}`);
        resolve({
          success: true,
          port: this.loopbackPort,
          token: this.loopbackToken,
          url: `http://127.0.0.1:${this.loopbackPort}/mcp`,
        });
      });
    });
  }

  /** 停止回环 MCP 服务器 */
  stopLoopback(): { success: boolean } {
    if (this.loopbackServer) {
      for (const client of this.loopbackSseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      this.loopbackSseClients.clear();
      try {
        this.loopbackServer.close();
      } catch {
        /* ignore */
      }
      this.loopbackServer = null;
      this.loopbackStarted = false;
      this.loopbackPort = 0;
      this.logger.log('MCP Loopback server stopped');
    }
    return { success: true };
  }

  /** 回环状态（token 脱敏） */
  getLoopbackStatus(): McpLoopbackStatus {
    return {
      running: this.loopbackStarted,
      port: this.loopbackPort,
      token: this.loopbackToken ? this.loopbackToken.substring(0, 12) + '...' : '',
      url: this.loopbackStarted ? `http://127.0.0.1:${this.loopbackPort}/mcp` : '',
      config: this.loopbackStarted
        ? {
            mcpServers: {
              skyalyticwing: {
                type: 'http',
                url: `http://127.0.0.1:${this.loopbackPort}/mcp`,
                headers: { Authorization: `Bearer ${this.loopbackToken}` },
              },
            },
          }
        : null,
    };
  }

  /** 更新回环配置（如偏好端口；下次启动生效） */
  updateLoopbackConfig(config: { port?: number }): { success: boolean; config: McpLoopbackStatus['config'] } {
    if (typeof config.port === 'number' && Number.isFinite(config.port) && config.port >= 0 && config.port < 65536) {
      this.loopbackPreferredPort = Math.floor(config.port);
    }
    return { success: true, config: this.getLoopbackStatus().config };
  }

  /** 处理回环 HTTP 请求 */
  private handleLoopbackRequest(req: http.IncomingMessage, res: ServerResponse): void {
    const origin = `http://127.0.0.1:${this.loopbackPort}`;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', server: LOOPBACK_SERVER_NAME })}\n\n`);
      this.loopbackSseClients.add(res);
      res.on('close', () => {
        this.loopbackSseClients.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && (url === '/mcp' || url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          name: LOOPBACK_SERVER_NAME,
          version: LOOPBACK_SERVER_VERSION,
          protocolVersions: LOOPBACK_PROTOCOL_VERSIONS,
          endpoints: {
            jsonrpc: '/mcp (POST)',
            sse: '/sse (GET)',
            resources: '/resources (GET)',
          },
        }),
      );
      return;
    }

    if (req.method === 'GET' && url === '/resources') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resources: this.getLoopbackResources() }));
      return;
    }

    if (req.method === 'POST' && (url === '/mcp' || url === '/')) {
      const authHeader = req.headers['authorization'] ?? '';
      if (this.loopbackToken) {
        if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.loopbackToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32001, message: 'Unauthorized' },
            }),
          );
          return;
        }
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
        if (body.length > 4 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        void this.handleLoopbackJsonRpcBody(body, res);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /** 解析并处理回环 JSON-RPC 消息 */
  private async handleLoopbackJsonRpcBody(body: string, res: ServerResponse): Promise<void> {
    let message: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(body || '{}');
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${err instanceof Error ? err.message : String(err)}` },
        }),
      );
      return;
    }
    if (message.jsonrpc !== '2.0') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32600, message: 'Invalid Request: missing jsonrpc version' },
        }),
      );
      return;
    }
    try {
      const result = await this.handleLoopbackJsonRpc(message);
      if (result === null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: {} }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        }),
      );
    }
  }

  /** 回环 JSON-RPC 分发 */
  private async handleLoopbackJsonRpc(message: {
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const id = message.id ?? null;
    const method = message.method ?? '';
    const params = message.params ?? {};
    switch (method) {
      case 'initialize': {
        const clientVersion = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
        const negotiated = LOOPBACK_PROTOCOL_VERSIONS.includes(clientVersion)
          ? clientVersion
          : LOOPBACK_PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
              prompts: {},
            },
            serverInfo: { name: LOOPBACK_SERVER_NAME, version: LOOPBACK_SERVER_VERSION },
          },
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'tools/list': {
        const tools = this.getLoopbackToolDescriptors().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        const external: Array<{ name: string; description: string; inputSchema: unknown }> = [];
        for (const [serverId, entry] of this.servers) {
          if (!entry.client || entry.status !== 'running') continue;
          try {
            const remote = await entry.client.listTools();
            for (const t of remote) {
              external.push({
                name: `mcp__${serverId}__${t.name}`,
                description: `[MCP:${entry.config.name}] ${t.description ?? t.name}`,
                inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
              });
            }
          } catch {
            /* 服务器不可达时跳过 */
          }
        }
        return { jsonrpc: '2.0', id, result: { tools: [...tools, ...external] } };
      }
      case 'tools/call': {
        const toolName = typeof params['name'] === 'string' ? params['name'] : '';
        const toolArgs = (params['arguments'] as Record<string, unknown>) ?? {};
        if (toolName.startsWith('mcp__')) {
          const parts = toolName.split('__');
          if (parts.length >= 3) {
            const serverId = parts[1];
            const remoteTool = parts.slice(2).join('__');
            try {
              const r = await this.callTool(serverId, remoteTool, toolArgs);
              return {
                jsonrpc: '2.0',
                id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text:
                        r.output ??
                        r.error ??
                        JSON.stringify(r),
                    },
                  ],
                  isError: !r.success,
                },
              };
            } catch (err) {
              return {
                jsonrpc: '2.0',
                id,
                result: {
                  content: [{ type: 'text', text: err instanceof Error ? err.message : 'MCP call failed' }],
                  isError: true,
                },
              };
            }
          }
        }
        try {
          const result = await this.callLoopbackTool(toolName, toolArgs);
          return { jsonrpc: '2.0', id, result };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: err instanceof Error ? err.message : 'tool execution failed' }],
              isError: true,
            },
          };
        }
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: this.getLoopbackResources() } };
      case 'resources/read':
        return {
          jsonrpc: '2.0',
          id,
          result: this.readLoopbackResource(typeof params['uri'] === 'string' ? params['uri'] : ''),
        };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  /** 回环内置工具定义 */
  private getLoopbackToolDescriptors(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: 'conversations_list',
        description: '列出所有频道对话和会话',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最大返回数量' },
            search: { type: 'string', description: '搜索关键词' },
            channel: { type: 'string', description: '按频道过滤' },
          },
        },
      },
      {
        name: 'conversation_get',
        description: '获取指定会话详情',
        inputSchema: {
          type: 'object',
          properties: { session_key: { type: 'string', description: '会话标识' } },
          required: ['session_key'],
        },
      },
      {
        name: 'messages_read',
        description: '读取会话最近消息',
        inputSchema: {
          type: 'object',
          properties: {
            session_key: { type: 'string', description: '会话标识' },
            limit: { type: 'number', description: '最大消息数' },
          },
          required: ['session_key'],
        },
      },
      {
        name: 'messages_send',
        description: '通过会话路由发送消息',
        inputSchema: {
          type: 'object',
          properties: {
            session_key: { type: 'string', description: '会话标识' },
            text: { type: 'string', description: '消息内容' },
          },
          required: ['session_key', 'text'],
        },
      },
      {
        name: 'events_poll',
        description: '轮询排队的事件',
        inputSchema: {
          type: 'object',
          properties: {
            after_cursor: { type: 'number', description: '游标' },
            limit: { type: 'number', description: '最大事件数' },
          },
        },
      },
      {
        name: 'events_wait',
        description: '等待下一个事件',
        inputSchema: {
          type: 'object',
          properties: {
            after_cursor: { type: 'number', description: '游标' },
            timeout_ms: { type: 'number', description: '超时毫秒' },
          },
        },
      },
      {
        name: 'permissions_list_open',
        description: '列出待审批请求',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'permissions_respond',
        description: '响应审批请求',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '审批ID' },
            decision: { type: 'string', enum: ['allow-once', 'allow-always', 'deny'], description: '决定' },
          },
          required: ['id', 'decision'],
        },
      },
    ];
  }

  /** 回环资源列表 */
  private getLoopbackResources(): Array<{
    uri: string;
    name: string;
    mimeType: string;
    description: string;
  }> {
    return [
      { uri: 'skyalyticwing://config', name: '当前配置', mimeType: 'application/json', description: 'SkyalyticWing当前运行配置' },
      { uri: 'skyalyticwing://channels', name: '频道状态', mimeType: 'application/json', description: '所有频道连接状态' },
      { uri: 'skyalyticwing://tools', name: '工具定义', mimeType: 'application/json', description: '所有可用工具定义' },
      { uri: 'skyalyticwing://sessions', name: '会话列表', mimeType: 'application/json', description: '所有活跃会话' },
    ];
  }

  /** 读取回环资源 */
  private readLoopbackResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
    if (uri === 'skyalyticwing://config') {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                servers: this.listServers(),
                loopback: this.getLoopbackStatus(),
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    if (uri === 'skyalyticwing://channels') {
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({}) }],
      };
    }
    if (uri === 'skyalyticwing://tools') {
      const tools = this.getLoopbackToolDescriptors().map((t) => ({
        name: t.name,
        description: t.description,
      }));
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(tools) }],
      };
    }
    if (uri === 'skyalyticwing://sessions') {
      const sessions = this.listConversations({ limit: 1000 });
      return {
        contents: [
          { uri, mimeType: 'application/json', text: JSON.stringify(sessions) },
        ],
      };
    }
    return {
      contents: [{ uri, mimeType: 'text/plain', text: 'Resource not found' }],
    };
  }

  /** 调用回环内置工具 */
  private async callLoopbackTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const text = (v: unknown) => JSON.stringify(v);
    switch (toolName) {
      case 'conversations_list':
        return { content: [{ type: 'text', text: text({ conversations: this.listConversations(args) }) }] };
      case 'conversation_get': {
        const key = String(args['session_key'] ?? '');
        const convs = this.listConversations({ search: key });
        const conv = convs.length > 0 ? convs[0] : null;
        if (!conv) {
          return { content: [{ type: 'text', text: `会话未找到: ${key}` }], isError: true };
        }
        return { content: [{ type: 'text', text: text({ conversation: conv }) }] };
      }
      case 'messages_read': {
        const msgs = this.readChannelMessages(String(args['session_key'] ?? ''), Number(args['limit']) || 20);
        return { content: [{ type: 'text', text: text({ messages: msgs, count: msgs.length }) }] };
      }
      case 'messages_send': {
        await this.sendChannelMessage(String(args['session_key'] ?? ''), String(args['text'] ?? ''));
        return { content: [{ type: 'text', text: 'sent' }] };
      }
      case 'events_poll': {
        const evts = this.pollChannelEvents(Number(args['after_cursor']) || 0, Number(args['limit']) || 20);
        return { content: [{ type: 'text', text: text(evts) }] };
      }
      case 'events_wait': {
        const evt = await this.waitChannelEvent(
          Number(args['after_cursor']) || 0,
          Number(args['timeout_ms']) || CHANNEL_EVENT_DEFAULT_TIMEOUT,
        );
        return { content: [{ type: 'text', text: evt ? text(evt) : 'timeout' }] };
      }
      case 'permissions_list_open':
        return { content: [{ type: 'text', text: text({ approvals: this.listPendingApprovals() }) }] };
      case 'permissions_respond':
        return {
          content: [
            {
              type: 'text',
              text: text(this.respondToApproval(String(args['id'] ?? ''), String(args['decision'] ?? ''))),
            },
          ],
        };
      default:
        return { content: [{ type: 'text', text: `未知工具: ${toolName}` }], isError: true };
    }
  }

  // ════════════════════════════════════════════════════════════════
  // MCP 渠道桥（conversations / messages / events / approvals）
  // ════════════════════════════════════════════════════════════════

  /** 列出渠道会话（api 会话；外部 IM 渠道未接入时仅返回 api） */
  listConversations(params: { limit?: number; channel?: string; search?: string } = {}): Array<Record<string, unknown>> {
    let results: Array<Record<string, unknown>> = [];
    for (const [sessionKey, s] of this.channelSessions) {
      if (!s || s.messages.length === 0) continue;
      results.push({
        sessionKey,
        channel: 'api',
        to: sessionKey,
        accountId: '',
        threadId: '',
        connected: true,
        messageCount: s.messages.length,
        lastMessageAt: s.messages[s.messages.length - 1]?.timestamp ?? null,
      });
    }
    if (params.channel) {
      results = results.filter((r) => r['channel'] === params.channel);
    }
    if (params.search) {
      const q = params.search.toLowerCase();
      results = results.filter((r) => `${r['sessionKey']} ${r['channel']}`.toLowerCase().includes(q));
    }
    return results.slice(0, params.limit || 50);
  }

  /** 读取会话最近消息 */
  readChannelMessages(sessionKey: string, limit = 20): Array<{ role: string; content: string; timestamp: number; id: string }> {
    const s = this.channelSessions.get(sessionKey);
    if (!s) return [];
    return s.messages.slice(-limit).map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      id: m.id,
    }));
  }

  /** 发送消息到会话（记录 assistant 消息并入队 message_sent 事件） */
  async sendChannelMessage(sessionKey: string, text: string): Promise<{ success: boolean }> {
    const key = sessionKey || 'default';
    let s = this.channelSessions.get(key);
    if (!s) {
      s = { messages: [], createdAt: Date.now() };
      this.channelSessions.set(key, s);
    }
    s.messages.push({
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      id: `msg-${Date.now()}`,
    });
    this.enqueueChannelEvent('message_sent', { sessionKey: key, text: text.substring(0, 100) });
    return { success: true };
  }

  /** 列出待审批请求（审批子系统未接入时返回空列表） */
  listPendingApprovals(): Array<Record<string, unknown>> {
    return [];
  }

  /** 响应审批请求 */
  respondToApproval(approvalId: string, decision: string): { error: string } | { success: boolean; id: string; decision: string } {
    void approvalId;
    void decision;
    return { error: 'Approval not found' };
  }

  /** 入队渠道事件并唤醒等待者 */
  private enqueueChannelEvent(type: string, data: unknown): void {
    this.channelEventCursor++;
    const evt: ChannelEvent = {
      cursor: this.channelEventCursor,
      type,
      data,
      timestamp: Date.now(),
    };
    this.channelEventQueue.push(evt);
    while (this.channelEventQueue.length > CHANNEL_EVENT_MAX_QUEUE) {
      this.channelEventQueue.shift();
    }
    const waiters = Array.from(this.channelEventWaiters);
    this.channelEventWaiters.clear();
    for (const w of waiters) {
      try {
        w(evt);
      } catch {
        /* ignore */
      }
    }
  }

  /** 轮询渠道事件 */
  pollChannelEvents(afterCursor: number, limit = 20): { events: ChannelEvent[]; nextCursor: number } {
    const events = this.channelEventQueue.filter((e) => e.cursor > (afterCursor || 0)).slice(0, limit || 20);
    const nextCursor = events.length > 0 ? events[events.length - 1].cursor : afterCursor || 0;
    return { events, nextCursor };
  }

  /** 等待下一个渠道事件（带超时，超时返回 null） */
  async waitChannelEvent(afterCursor: number, timeoutMs = CHANNEL_EVENT_DEFAULT_TIMEOUT): Promise<ChannelEvent | null> {
    const existing = this.channelEventQueue.find((e) => e.cursor > (afterCursor || 0));
    if (existing) return existing;
    return new Promise((resolve) => {
      const waiter = (evt: ChannelEvent | null) => {
        clearTimeout(timer);
        this.channelEventWaiters.delete(waiter);
        resolve(evt);
      };
      const timer = setTimeout(() => {
        this.channelEventWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      this.channelEventWaiters.add(waiter);
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 测试端点（/mcp/test-endpoint）
  // ════════════════════════════════════════════════════════════════

  /** 测试端点工具列表 */
  getTestEndpointTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: '_ping',
        description: 'Health check - 返回服务器状态和时间',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: '_list_tools',
        description: '列出所有可用工具',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'echo',
        description: '回显输入内容（测试用）',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      {
        name: 'get_time',
        description: '返回当前服务器时间',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'calc',
        description: '简单计算器（a+b）',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      },
    ];
  }

  /**
   * 调用测试端点工具。
   * @returns 工具结果；未知工具返回含 __unknown__ 标记的对象（由控制器转 404）
   */
  callTestEndpointTool(name: string, args: Record<string, unknown>): Record<string, unknown> | string[] {
    switch (name) {
      case '_ping':
        return {
          status: 'ok',
          server: 'SkyalyticWing-MCP-Test',
          time: new Date().toISOString(),
          version: '1.0.0',
        };
      case '_list_tools':
        return ['_ping', '_list_tools', 'echo', 'get_time', 'calc'];
      case 'echo':
        return { input: args['message'], echoed: true, time: new Date().toISOString() };
      case 'get_time':
        return {
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          date: new Date().toLocaleString('zh-CN'),
          unix: Date.now(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      case 'calc': {
        const a = Number(args['a']) || 0;
        const b = Number(args['b']) || 0;
        return { a, b, sum: a + b, product: a * b };
      }
      default:
        return { __unknown__: true };
    }
  }

  /** 模块销毁时停止所有服务器与回环 */
  onModuleDestroy(): void {
    this.stopLoopback();
    for (const [id, entry] of this.servers) {
      if (entry.client) {
        entry.client.close();
        entry.client = undefined;
        entry.status = 'stopped';
        this.logger.log(`Stopped MCP server ${id} on shutdown`);
      }
    }
  }

  /** 将 MCP 工具描述转为 ToolDefinition（execute 回调到 MCP 服务器） */
  private toToolDefinition(
    serverId: string,
    descriptor: McpToolDescriptor,
    scope = this.activeResourceRoot,
  ): ToolDefinition {
    const inputSchema = descriptor.inputSchema ?? { type: 'object', properties: {} };
    const parameters: ToolParameterSchema =
      inputSchema && (inputSchema as { type?: string }).type === 'object'
        ? (inputSchema as ToolParameterSchema)
        : { type: 'object', properties: (inputSchema as { properties?: Record<string, unknown> })?.properties ?? {} };
    return {
      name: descriptor.name,
      description: descriptor.description ?? `MCP tool from server ${serverId}`,
      parameters,
      category: 'mcp',
      dangerous: descriptor.annotations?.readOnlyHint !== true,
      execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
        const abort = new AbortController();
        const stop = () => abort.abort();
        const unsubscribe = ChatControlRegistry.onAbort(id => {if (!id || id === _ctx.sessionId) stop();});
        _ctx.signal?.addEventListener('abort', stop, {once:true});
        if (_ctx.signal?.aborted) stop();
        try {
          this.assertResourceScope(scope);
          return await this.callTool(serverId, descriptor.name, args, abort.signal);
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        } finally {unsubscribe();_ctx.signal?.removeEventListener('abort',stop);}
      },
    };
  }

  /** 将 MCP tools/call 结果转为 ToolResult */
  private toToolResult(result: McpCallResult): ToolResult {
    return toToolResult(result);
  }

  private redactResult(serverId: string, result: ToolResult): ToolResult {
    const values = Object.entries(this.servers.get(serverId)?.config.env || {})
      .filter(([key,value]) => /key|token|secret|pass|auth|credential/i.test(key) && value.length >= 4)
      .flatMap(([,value]) => [value, ...(value.startsWith('Bearer ') ? [value.slice(7)] : [])])
      .filter(value => value.length >= 4).sort((a,b) => b.length-a.length);
    const clean = (text?: string) => values.reduce((s,v) => s.split(v).join('[redacted]'), text || '');
    return {...result, ...(result.output !== undefined ? {output:clean(result.output)} : {}), ...(result.error !== undefined ? {error:clean(result.error)} : {})};
  }

  /** 配置 → 脱敏信息（不含 env） */
  private toInfo(entry: ServerEntry): McpServerInfo {
    return {
      id: entry.config.id,
      name: entry.config.name,
      command: entry.config.command,
      args: [...(entry.config.args ?? [])],
      enabled: entry.config.enabled,
      status: entry.status,
    };
  }
}

/** 将 MCP tools/call 结果转为 ToolResult（模块级，供工具 execute 闭包复用） */
function toToolResult(result: McpCallResult): ToolResult {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
  if (result.isError) {
    return { success: false, error: text || 'MCP tool returned an error' };
  }
  return { success: true, output: text };
}
