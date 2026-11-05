// 配置、会话及工具交互共用的核心类型。

export interface GatewayConfig {
  port: number;
  host: string;
  tls?: { enabled: boolean; cert?: string; key?: string };
  bindMode?: 'auto' | 'lan' | 'loopback' | 'custom';
}

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  provider: string;
  maxTokens?: number;
  temperature?: number;
  permissionMode?: 'auto' | 'ask' | 'deny';
  systemPrompt?: string;
  tools?: string[];
  workspace?: string;
}

export interface ChannelConfig {
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface ModelConfig {
  id: string;
  provider: string;
  name: string;
  apiBase?: string;
  apiKey?: string;
  maxTokens?: number;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  profile?: 'minimal' | 'coding' | 'messaging' | 'full';
}

export interface MemoryConfig {
  enabled: boolean;
  provider: string;
  path?: string;
  embeddingModel?: string;
}

export interface CronConfig {
  enabled: boolean;
  jobs?: CronJobConfig[];
}

export interface CronJobConfig {
  id: string;
  name: string;
  schedule: string;
  agent: string;
  message: string;
  enabled: boolean;
}

export interface HookConfig {
  enabled: boolean;
  url?: string;
  events?: string[];
}

export interface SecurityConfig {
  ssrfProtection: boolean;
  commandApproval: 'auto' | 'ask' | 'deny';
  sandboxEnabled: boolean;
  pathPolicy?: { allowed: string[]; denied: string[] };
}

export interface PluginConfig {
  enabled: boolean;
  directories?: string[];
  autoLoad?: boolean;
}

export interface DaemonConfig {
  enabled: boolean;
  type?: 'systemd' | 'launchd' | 'schtasks';
}

export interface ACPConfig {
  enabled: boolean;
  port?: number;
}

export interface MCPConfig {
  enabled: boolean;
  servers?: MCPServerConfig[];
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DatabaseConfig {
  type: 'sqlite' | 'postgresql';
  path?: string;
  url?: string;
}

export interface AppConfig {
  gateway: GatewayConfig;
  auth: { mode: string; token?: string; username?: string; password?: string; session?: { ttl: number } };
  database: DatabaseConfig;
  agents: Record<string, AgentConfig>;
  channels: ChannelConfig[];
  models?: ModelConfig[];
  tools?: ToolConfig[];
  memory?: MemoryConfig;
  cron?: CronConfig;
  hooks?: HookConfig;
  security?: SecurityConfig;
  plugins?: PluginConfig;
  daemon?: DaemonConfig;
  acp?: ACPConfig;
  mcp?: MCPConfig;
  logging?: { level: string; format: string };
}
