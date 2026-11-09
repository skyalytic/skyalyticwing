/** AI 提供商配置 */
export interface ProviderConfig {
  apiFormat?: 'auto' | 'chat-completions' | 'responses';
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
}

/** 安全配置 */
export interface SecurityConfig {
  auth: {
    mode: 'none' | 'token';
    token?: string;
  };
  yolo: 'auto' | 'ask' | 'yolo';
  allowedPaths: string[];
  blockedCommands: string[];
}

/** 服务器配置 */
export interface ServerConfig {
  port: number;
  host: string;
  websocketPort: number;
  maxBodySize: number;
  requestTimeoutMs: number;
}

/** 日志配置 */
export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  redactKeys: string[];
  maxBufferEntries: number;
  filePath?: string;
}

/** 应用配置 */
export interface AppConfig {
  version: string;
  providers: Record<string, ProviderConfig>;
  security: SecurityConfig;
  server: ServerConfig;
  log: LogConfig;
  channels?: Record<string, unknown>;
  cron?: Record<string, unknown>;
}
