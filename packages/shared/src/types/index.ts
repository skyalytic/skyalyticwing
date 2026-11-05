// 通用类型定义

// 重新导出子模块类型（仅类型，避免与本地 ServerConfig 等冲突的模块采用具名导入）
export type {
  WsEvent,
  WsConnectionStatus,
  WsConnectionInfo,
  BackgroundTaskStatus,
  BackgroundTaskEventData,
} from './ws-events';

// AI 域所需共享类型：聊天消息 / 会话 / 工具相关类型
export * from './chat';
export * from './session';
export * from './tool';
export * from './channel';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface PaginatedResponse<T> extends Omit<ApiResponse<T[]>, 'data'> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface Timestamp {
  createdAt: string;
  updatedAt: string;
}

export interface KeyValue<T = string> {
  key: string;
  value: T;
}

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type AsyncResult<T, E = Error> = Promise<{ ok: true; value: T } | { ok: false; error: E }>;

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

// 事件类型
export type EventMap = Record<string, unknown>;
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

// 配置类型
export interface ServerConfig {
  port: number;
  host: string;
  tls?: { enabled: boolean; cert?: string; key?: string };
}

export interface DatabaseConfig {
  type: 'sqlite' | 'postgresql';
  path?: string;
  url?: string;
}

export interface AuthConfig {
  mode: 'none' | 'token' | 'password';
  token?: string;
  session?: { ttl: number };
}
