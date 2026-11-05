import { wt } from '@/i18n/workbench-text';
// 全局常量

// 与 shared 重复的数值常量统一从 @skyalyticwing/shared/constants 导入（值完全一致），
// 此处按前端命名习惯重新导出，保持既有 import 路径不变。
// 注意：走 ./constants 子路径而非包根入口，避免 shared 桶入口 re-export 的 logger（pino）被打进前端 bundle
import {
  HTTP_TIMEOUT_MS,
  WS_HEARTBEAT_INTERVAL,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_RECONNECT_INITIAL_DELAY,
  WS_RECONNECT_MAX_DELAY,
} from '@skyalyticwing/shared/constants';

export { HTTP_TIMEOUT_MS, WS_MAX_RECONNECT_ATTEMPTS };

/** API 前缀 */
export const API_PREFIX = '/api';

/** WebSocket 路径 */
export const WS_PATH = '/ws';

/** 构建 WebSocket URL（基于当前页面协议与主机） */
export function buildWsUrl(override?: string): string {
  if (override) return override;
  const envUrl = import.meta.env.VITE_WS_URL;
  if (envUrl) return envUrl;
  if (typeof window === 'undefined') return `ws://127.0.0.1:19111${WS_PATH}`;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${proto}//${host}${WS_PATH}`;
}

/** WebSocket 心跳间隔（ms，取自 shared WS_HEARTBEAT_INTERVAL） */
export const WS_HEARTBEAT_MS = WS_HEARTBEAT_INTERVAL;

/** WebSocket 重连初始延迟（ms，取自 shared WS_RECONNECT_INITIAL_DELAY） */
export const WS_RECONNECT_BASE_MS = WS_RECONNECT_INITIAL_DELAY;

/** WebSocket 重连最大延迟（ms，取自 shared WS_RECONNECT_MAX_DELAY） */
export const WS_RECONNECT_MAX_MS = WS_RECONNECT_MAX_DELAY;

/** WebSocket 消息去重缓存上限（LRU 清理） */
export const WS_MAX_SEEN_MESSAGES = 500;

/** 主题色 */
export const THEME = {
  primary: '#1a1a2e',
  background: '#16213e',
  card: '#0f3460',
  accent: '#e94560',
  text: '#eaeaea',
  textMuted: '#9aa5b1',
  border: '#1f3a5f',
  success: '#2ecc71',
  warning: '#f39c12',
  danger: '#e74c3c',
  info: '#3498db',
} as const;

/** 消息角色显示标签 */
export const ROLE_LABELS: Record<string, string> = {
  get user() {
    return wt('你');
  },
  get assistant() {
    return wt('助手');
  },
  get system() {
    return wt('系统');
  },
  get tool() {
    return wt('工具');
  },
};

/** 默认分页大小 */
export const DEFAULT_PAGE_SIZE = 20;

/** Toast 默认持续时间（ms） */
export const DEFAULT_TOAST_DURATION = 4000;
