import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** MCP 服务器传输类型 */
export type McpTransportType = 'stdio' | 'http' | 'sse';

/** MCP 服务器配置（含敏感 env，仅内部存储） */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportType;
  /** stdio 模式：可执行命令 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse 模式：服务器 URL */
  url?: string;
  /** http/sse 模式：自定义请求头 */
  headers?: Record<string, string>;
  enabled: boolean;
}

/** MCP 服务器信息（对外展示，脱敏：不含 env） */
export interface McpServerInfo {
  id: string;
  name: string;
  transport: McpTransportType;
  command?: string;
  args: string[];
  url?: string;
  enabled: boolean;
  status: 'stopped' | 'running' | 'error';
  lastError?: string;
  connectedAt?: number;
}

type ServerStatus = 'stopped' | 'running' | 'error';

interface ServerEntry {
  config: McpServerConfig;
  status: ServerStatus;
  lastError?: string;
  connectedAt?: number;
  /** HTTP 客户端句柄（http/sse 模式） */
  httpClient?: McpHttpClient;
}

/** JSON-RPC 请求的待处理句柄 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
  abort?: () => void;
}

/** MCP 工具描述（来自 tools/list） */
interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
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

/** HTTP 请求超时（30s） */
const HTTP_TIMEOUT = 30_000;
/** JSON-RPC 请求超时（30s） */
const REQUEST_TIMEOUT = 30_000;

/**
 * McpHttpClient - MCP HTTP/SSE JSON-RPC 客户端
 *
 * 通过 HTTP POST 或 SSE（Server-Sent Events）与 MCP 服务器通信。
 * 支持 initialize / tools/list / tools/call，带请求超时。
 *
 * 对应原始实现：channels.cjs 中 _fetchWithTimeout 的 HTTP 调用模式
 */
class McpHttpClient {
  private readonly logger = new Logger('McpHttpClient');
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  /** 初始化握手 */
  async initialize(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'skyalyticwing', version: '1.0.0' },
    })) as Record<string, unknown>;
    this.logger.debug(`Initialized MCP HTTP client: ${this.url} (${(result as { serverInfo?: { name?: string } })?.serverInfo?.name ?? 'unknown'})`);
  }

  /** 列出工具 */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolDescriptor[] };
    return result?.tools ?? [];
  }

  /** 调用工具 */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.request('tools/call', { name, arguments: args ?? {} }, signal)) as McpCallResult;
  }

  /** 关闭连接 */
  close(): void {
    this.failAll(new Error('MCP HTTP connection closed'));
  }

  /** Tool execution has no implicit deadline; handshake/list requests retain a timeout. */
  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pending.get(id);
        clearTimeout(pending?.timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', abort);
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const abort = () => {
        controller.abort();
        fail(new Error('MCP tool cancelled'));
        if (method === 'tools/call') void fetch(this.url, {
          method:'POST', headers:{'Content-Type':'application/json', ...this.headers},
          body:JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'User cancelled'}}),
          signal:AbortSignal.timeout(HTTP_TIMEOUT),
        }).then(response => response.body?.cancel()).catch(() => {});
      };
      const timer = method === 'tools/call' ? undefined : setTimeout(() => {
        controller.abort(); fail(new Error(`MCP HTTP request timeout: ${method}`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, {resolve:value=>{cleanup();resolve(value);},reject:fail,timer,abort:()=>controller.abort()});
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, {once:true});
      void fetch(this.url, {
        method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json',...this.headers},
        body, signal:controller.signal,
      }).then(async response => {
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
        const message = await response.json() as {id?:number;result?:unknown;error?:{message?:string}};
        if (message.id !== id) throw new Error('MCP response ID does not match request');
        if (message.error) throw new Error(message.error.message || 'MCP error');
        this.pending.get(id)?.resolve(message.result);
      }).catch(error => this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.abort?.();
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * McpServerService - MCP 服务器管理（stdio/HTTP/SSE 传输）
 *
 * 管理 MCP 服务器配置与生命周期，支持 stdio（子进程 JSON-RPC）与
 * http/sse（HTTP POST JSON-RPC）两种传输方式。
 *
 * 与 McpService 的关系：
 *   - McpService 专注于 stdio 子进程管理（已存在）
 *   - McpServerService 提供 HTTP/SSE 传输支持与统一配置注册
 *
 * 安全：服务器信息对外脱敏（不含 env）；HTTP 请求受 30s 超时约束。
 *
 * 对应原始实现：mcporter-manager.cjs 的 MCP 服务管理 + channels.cjs 的 _fetchWithTimeout
 */
@Injectable()
export class McpServerService implements OnModuleDestroy {
  private readonly logger = new Logger(McpServerService.name);
  private readonly servers = new Map<string, ServerEntry>();

  /** 列出全部服务器（脱敏） */
  listServers(): McpServerInfo[] {
    return Array.from(this.servers.values()).map((e) => this.toInfo(e));
  }

  /** 添加服务器配置 */
  addServer(config: Omit<McpServerConfig, 'id'> & { id?: string }): McpServerInfo {
    const id = config.id ?? randomUUID();
    if (this.servers.has(id)) throw new Error(`MCP server already exists: ${id}`);

    if (config.transport === 'stdio') {
      if (typeof config.command !== 'string' || config.command.length === 0) {
        throw new Error('MCP stdio server "command" is required');
      }
    } else {
      // http / sse
      if (typeof config.url !== 'string' || config.url.length === 0) {
        throw new Error(`MCP ${config.transport} server "url" is required`);
      }
    }

    const full: McpServerConfig = {
      id,
      name: config.name || id,
      transport: config.transport,
      ...(config.command !== undefined ? { command: config.command } : {}),
      args: Array.isArray(config.args) ? config.args : [],
      env: config.env && typeof config.env === 'object' ? { ...config.env } : {},
      ...(config.url !== undefined ? { url: config.url } : {}),
      headers: config.headers && typeof config.headers === 'object' ? { ...config.headers } : {},
      enabled: config.enabled !== false,
    };
    this.servers.set(id, { config: full, status: 'stopped' });
    this.logger.log(`Added MCP server ${id} (transport=${full.transport})`);
    return this.toInfo(this.servers.get(id)!);
  }

  /** 更新服务器配置（运行中则需先停止） */
  updateServer(id: string, config: Partial<Omit<McpServerConfig, 'id'>>): McpServerInfo {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (entry.status === 'running') {
      throw new Error(`Stop server before updating: ${id}`);
    }
    if (typeof config.name === 'string') entry.config.name = config.name;
    if (typeof config.transport === 'string') entry.config.transport = config.transport;
    if (typeof config.command === 'string' && config.command.length > 0) entry.config.command = config.command;
    if (Array.isArray(config.args)) entry.config.args = config.args;
    if (config.env && typeof config.env === 'object') entry.config.env = { ...config.env };
    if (typeof config.url === 'string') entry.config.url = config.url;
    if (config.headers && typeof config.headers === 'object') entry.config.headers = { ...config.headers };
    if (typeof config.enabled === 'boolean') entry.config.enabled = config.enabled;
    return this.toInfo(entry);
  }

  /** 删除服务器（运行中则先停止） */
  removeServer(id: string): void {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    this.stopServer(id);
    this.servers.delete(id);
    this.logger.log(`Removed MCP server ${id}`);
  }

  /** 启动服务器（HTTP/SSE 模式建立客户端连接并完成 initialize 握手） */
  async startServer(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (!entry.config.enabled) throw new Error(`MCP server is disabled: ${id}`);
    if (entry.status === 'running') return;

    try {
      if (entry.config.transport === 'http' || entry.config.transport === 'sse') {
        const client = new McpHttpClient(
          entry.config.url!,
          entry.config.headers ?? {},
        );
        await client.initialize();
        entry.httpClient = client;
      }
      // stdio 模式由 McpService 管理，此处仅记录状态
      entry.status = 'running';
      entry.connectedAt = Date.now();
      delete entry.lastError;
      this.logger.log(`Started MCP server ${id} (transport=${entry.config.transport})`);
    } catch (err) {
      entry.status = 'error';
      entry.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** 停止服务器 */
  stopServer(id: string): void {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`MCP server not found: ${id}`);
    if (entry.httpClient) {
      entry.httpClient.close();
      delete entry.httpClient;
    }
    entry.status = 'stopped';
    delete entry.connectedAt;
    this.logger.log(`Stopped MCP server ${id}`);
  }

  /** 列出 HTTP/SSE 服务器的工具（stdio 服务器工具请使用 McpService.listTools） */
  async listTools(serverId: string): Promise<McpToolDescriptor[]> {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`MCP server not found: ${serverId}`);
    if (entry.config.transport === 'stdio') {
      throw new Error(`Use McpService.listTools for stdio server: ${serverId}`);
    }
    if (!entry.httpClient || entry.status !== 'running') {
      throw new Error(`MCP server not running: ${serverId}`);
    }
    return entry.httpClient.listTools();
  }

  /** 调用 HTTP/SSE 服务器上的工具 */
  async callTool(serverId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`MCP server not found: ${serverId}`);
    if (entry.config.transport === 'stdio') {
      throw new Error(`Use McpService.callTool for stdio server: ${serverId}`);
    }
    if (!entry.httpClient || entry.status !== 'running') {
      throw new Error(`MCP server not running: ${serverId}`);
    }
    return entry.httpClient.callTool(toolName, args, signal);
  }

  /** 获取服务器配置（内部使用，含 env） */
  getServerConfig(id: string): McpServerConfig | undefined {
    return this.servers.get(id)?.config;
  }

  /** 模块销毁时停止所有服务器 */
  onModuleDestroy(): void {
    for (const [id, entry] of this.servers) {
      if (entry.httpClient) {
        entry.httpClient.close();
        delete entry.httpClient;
        entry.status = 'stopped';
        this.logger.log(`Stopped MCP server ${id} on shutdown`);
      }
    }
  }

  /** 配置 → 脱敏信息（不含 env） */
  private toInfo(entry: ServerEntry): McpServerInfo {
    const info: McpServerInfo = {
      id: entry.config.id,
      name: entry.config.name,
      transport: entry.config.transport,
      args: [...(entry.config.args ?? [])],
      enabled: entry.config.enabled,
      status: entry.status,
    };
    if (entry.config.command !== undefined) info.command = entry.config.command;
    if (entry.config.url !== undefined) info.url = entry.config.url;
    if (entry.lastError !== undefined) info.lastError = entry.lastError;
    if (entry.connectedAt !== undefined) info.connectedAt = entry.connectedAt;
    return info;
  }
}
