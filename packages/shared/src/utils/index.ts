import { v4 as uuidv4 } from 'uuid';
import { format, formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export { uuidv4 };
export { deduplicateAttachments } from './attachments.js';

export function generateId(): string {
  return uuidv4();
}

export function formatDate(date: Date | string | number, pattern = 'yyyy-MM-dd HH:mm:ss'): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  if (isNaN(d.getTime())) throw new Error(`Invalid date input: ${date}`);
  return format(d, pattern);
}

export function formatRelativeTime(date: Date | string | number): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  if (isNaN(d.getTime())) throw new Error(`Invalid date input: ${date}`);
  return formatDistanceToNow(d, { addSuffix: true, locale: zhCN });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function retry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; delay?: number; backoff?: boolean; retryable?: (error: unknown) => boolean } = {}
): Promise<T> {
  const { maxRetries = 3, delay = 1000, backoff = true, retryable = () => true } = options;
  return fn().catch((error) => {
    if (maxRetries <= 0 || !retryable(error)) throw error;
    const nextDelay = backoff ? delay * 2 : delay;
    return sleep(delay).then(() => retry(fn, { maxRetries: maxRetries - 1, delay: nextDelay, backoff, retryable }));
  });
}

export function truncate(str: string, maxLength: number): string {
  // 边界处理：maxLength < 3 时 slice(0, 负数) 会从末尾计算，产生错误结果
  if (maxLength < 3) return str.length <= maxLength ? str.slice(0, maxLength) : '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  const debounced = ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T & { cancel: () => void };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

export function throttle<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let lastCall = 0;
  return ((...args: unknown[]) => {
    const now = Date.now();
    if (now - lastCall >= ms) {
      fn(...args);
      lastCall = now;
    }
  }) as T;
}

export function deepClone<T>(obj: T): T {
  try {
    return structuredClone(obj);
  } catch {
    // JSON 回退路径：不通过 reviver 将日期格式字符串转为 Date，避免原本是字符串的字段被误转
    // 若对象含循环引用，JSON.stringify 会抛 TypeError，此处回退为浅拷贝避免异常传播
    try {
      return JSON.parse(JSON.stringify(obj)) as T;
    } catch {
      return { ...obj };
    }
  }
}

export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (value instanceof Date || value instanceof RegExp || value instanceof Error) return false;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) result[key] = obj[key];
  }
  return result;
}

export function omit<T extends Record<string, unknown>, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}
