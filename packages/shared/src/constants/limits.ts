/** 消息存储限制 */
export const MAX_CHAT_MESSAGES = 500;

/** 任务存储限制 */
export const MAX_TASKS = 10000;

/** HTTP 请求超时（毫秒） */
export const HTTP_TIMEOUT_MS = 30000;

/** HTTP 响应最大大小（字节） */
export const HTTP_MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB

/** WebSocket 重连最大次数 */
export const WS_MAX_RECONNECT_ATTEMPTS = 50;

/** WebSocket 重连初始延迟（毫秒） */
export const WS_RECONNECT_INITIAL_DELAY = 3000;

/** WebSocket 重连最大延迟（毫秒） */
export const WS_RECONNECT_MAX_DELAY = 60000;

/** WebSocket 心跳间隔（毫秒） */
export const WS_HEARTBEAT_INTERVAL = 30000;

/** 定时任务投递最大重试次数 */
export const CRON_MAX_RETRIES = 3;

/** 定时任务投递重试延迟（毫秒） */
export const CRON_RETRY_DELAY = 5000;

/** 日志缓冲区最大条目数 */
export const LOG_MAX_BUFFER_ENTRIES = 1000;

/** 插件加载并发限制 */
export const PLUGIN_MAX_CONCURRENT_LOADS = 10;
