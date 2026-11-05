import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions = {}) {
  const { level = 'info', name = 'skyalyticwing', pretty = false } = options;

  // pino-pretty 为可选依赖；若未安装则降级为普通 logger，避免 transport 启动时崩溃
  let transport: { target: string; options: Record<string, unknown> } | undefined;
  if (pretty) {
    try {
      // 探测 pino-pretty 是否可用
      import.meta.resolve('pino-pretty');
      transport = { target: 'pino-pretty', options: { colorize: true } };
    } catch {
      // pino-pretty 未安装，降级为普通 logger
    }
  }

  // exactOptionalPropertyTypes: true 时不能显式传入 undefined，需条件构造
  const opts: pino.LoggerOptions = { level, name };
  if (transport) opts.transport = transport;
  return pino(opts);
}

export type Logger = ReturnType<typeof createLogger>;

export const logger = createLogger();
