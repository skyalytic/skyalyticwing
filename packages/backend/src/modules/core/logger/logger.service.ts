import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { isTokenMetric } from './token-metric.util.js';

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 单条日志条目 */
export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

/** 默认脱敏字段（小写匹配） */
const DEFAULT_REDACT_KEYS = [
  'authtoken',
  'apikey',
  'tls.key',
  'password',
  'secret',
  'token',
];

/** 脱敏占位符 */
const REDACTED = '***';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_BUFFER_ENTRIES = 1000;

/**
 * LoggerService - 结构化日志服务
 *
 * 特性：
 *   - 四级日志 debug/info/warn/error
 *   - 自动脱敏：递归遍历 meta 与字符串化后的 message，匹配 authToken/apiKey/tls.key/password/secret/token
 *   - 内存环形缓冲：最多 1000 条，超出后丢弃最旧条目
 *   - 控制台输出（通过 NestJS 内置 Logger 避免颜色冲突）
 */
@Injectable()
export class LoggerService {
  private readonly nestLogger = new NestLogger(LoggerService.name);
  private buffer: LogEntry[] = [];
  private bufferLimit = MAX_BUFFER_ENTRIES;
  private redactKeys: string[] = DEFAULT_REDACT_KEYS;
  private minLevel: LogLevel = 'info';

  /** 运行期调整脱敏字段（如根据 ConfigService.log.redactKeys） */
  setRedactKeys(keys: string[]): void {
    this.redactKeys = keys.length > 0 ? keys.map((k) => k.toLowerCase()) : DEFAULT_REDACT_KEYS;
  }

  /** 运行期调整最低输出级别 */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** 运行期调整缓冲区上限 */
  setBufferLimit(limit: number): void {
    this.bufferLimit = limit > 0 ? limit : MAX_BUFFER_ENTRIES;
    this.trimBuffer();
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  /**
   * 获取内存缓冲日志
   * @param level 可选，按级别过滤
   * @param limit 可选，最多返回条数（从最新开始）
   */
  getLogs(level?: string, limit?: number): LogEntry[] {
    let entries = this.buffer;
    if (level) {
      const lv = level.toLowerCase() as LogLevel;
      entries = entries.filter((e) => e.level === lv);
    }
    if (limit !== undefined && limit > 0) {
      const start = Math.max(0, entries.length - limit);
      return entries.slice(start);
    }
    return [...entries];
  }

  /** 清空内存缓冲 */
  clear(): void {
    this.buffer = [];
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const safeMessage = this.redactString(message);
    const entry: LogEntry =
      meta !== undefined
        ? {
            timestamp: Date.now(),
            level,
            message: safeMessage,
            meta: this.redactObject(meta) as Record<string, unknown>,
          }
        : {
            timestamp: Date.now(),
            level,
            message: safeMessage,
          };
    this.pushEntry(entry);
    this.emit(entry);
  }

  private pushEntry(entry: LogEntry): void {
    this.buffer.push(entry);
    this.trimBuffer();
  }

  private trimBuffer(): void {
    if (this.buffer.length > this.bufferLimit) {
      this.buffer = this.buffer.slice(this.buffer.length - this.bufferLimit);
    }
  }

  private emit(entry: LogEntry): void {
    const metaStr = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
    const line = `${entry.message}${metaStr}`;
    switch (entry.level) {
      case 'debug':
        this.nestLogger.debug(line);
        break;
      case 'info':
        this.nestLogger.log(line);
        break;
      case 'warn':
        this.nestLogger.warn(line);
        break;
      case 'error':
        this.nestLogger.error(line);
        break;
    }
  }

  private redactString(input: string): string {
    let result = input;
    for (const key of this.redactKeys) {
      // 简单子串匹配 + 转义正则元字符
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 匹配 "key":"value" 或 key=value 形式
      const re = new RegExp(`(["']?${escaped}["']?\\s*[:=]\\s*["']?)[^"',}\\s]+`, 'gi');
      result = result.replace(re, `$1${REDACTED}`);
    }
    return result;
  }

  private redactObject(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return this.redactString(value);
    if (Array.isArray(value)) return value.map((v) => this.redactObject(v));
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!isTokenMetric(k, v) && this.isRedactableKey(k) && (typeof v === 'string' || typeof v === 'number')) {
          result[k] = REDACTED;
        } else {
          result[k] = this.redactObject(v);
        }
      }
      return result;
    }
    return value;
  }

  private isRedactableKey(key: string): boolean {
    const lower = key.toLowerCase();
    for (const redact of this.redactKeys) {
      if (lower === redact) return true;
      // 支持 tls.key 这种点分键与嵌套对象的字段名 key
      if (redact.includes('.')) {
        const last = redact.split('.').pop()!;
        if (lower === last) return true;
      } else if (lower.replace(/[_-]/g, '').includes(redact.replace(/[_-]/g, ''))) {
        return true;
      }
    }
    return false;
  }
}
