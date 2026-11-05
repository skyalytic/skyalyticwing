import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDate,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatRelativeTime,
  formatTime,
  formatUptime,
  genId,
  prettyJson,
  safeJsonParse,
  truncate,
} from '../src/utils/format';

describe('formatTime / formatDate', () => {
  it('格式化时间为 YYYY-MM-DD HH:mm:ss', () => {
    const d = new Date(2026, 0, 15, 10, 30, 45); // 本地时间，避免时区问题
    expect(formatTime(d)).toBe('2026-01-15 10:30:45');
    expect(formatTime(d.getTime())).toBe('2026-01-15 10:30:45');
    expect(formatTime('2026-01-15T10:30:45')).not.toBe('--'); // 字符串可解析
  });

  it('补零到两位', () => {
    const d = new Date(2026, 10, 3, 4, 5, 6);
    expect(formatTime(d)).toBe('2026-11-03 04:05:06');
  });

  it('仅格式化日期', () => {
    expect(formatDate(new Date(2026, 0, 15))).toBe('2026-01-15');
    expect(formatDate(new Date(2026, 10, 3))).toBe('2026-11-03');
  });

  it('无效输入返回 --', () => {
    expect(formatTime('invalid-date')).toBe('--');
    expect(formatDate('invalid-date')).toBe('--');
    expect(formatTime(NaN)).toBe('--');
  });
});

describe('formatRelativeTime', () => {
  const base = new Date(2026, 0, 15, 12, 0, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(base);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [0, '刚刚'],
    [30_000, '刚刚'],
    [3 * 60_000, '3 分钟前'],
    [59 * 60_000, '59 分钟前'],
    [2 * 3_600_000, '2 小时前'],
    [23 * 3_600_000, '23 小时前'],
    [5 * 86_400_000, '5 天前'],
    [40 * 86_400_000, '1 个月前'],
    [400 * 86_400_000, '1 年前'],
  ])('%d ms 前 → %s', (offset, expected) => {
    expect(formatRelativeTime(base - offset)).toBe(expected);
  });

  it('无效输入返回 --', () => {
    expect(formatRelativeTime('invalid-date')).toBe('--');
  });
});

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [-5, '0 B'],
    [1, '1 B'],
    [500, '500 B'],
    [1024, '1.00 KB'],
    [1536, '1.50 KB'],
    [1048576, '1.00 MB'],
    [1073741824, '1.00 GB'],
    [1024 ** 4, '1.00 TB'],
  ])('%d 字节 → %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});

describe('formatDuration / formatUptime', () => {
  it('毫秒', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(999)).toBe('999 ms');
  });

  it('秒（两位小数）', () => {
    expect(formatDuration(1000)).toBe('1.00 s');
    expect(formatDuration(1500)).toBe('1.50 s');
  });

  it('分钟 + 秒', () => {
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('运行时长（中文单位）', () => {
    expect(formatUptime(0)).toBe('0秒');
    expect(formatUptime(59)).toBe('59秒');
    expect(formatUptime(61)).toBe('1分 1秒');
    expect(formatUptime(3600)).toBe('1小时');
    expect(formatUptime(3661)).toBe('1小时 1分 1秒');
    expect(formatUptime(90061)).toBe('1天 1小时 1分 1秒');
  });
});

describe('formatNumber / truncate / genId', () => {
  it('数字千分位', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('截断字符串（超出追加省略号）', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello world', 5)).toBe('hello…');
  });

  it('genId 生成带前缀的唯一 id', () => {
    const a = genId();
    const b = genId();
    expect(a).toMatch(/^id_[a-z0-9_]+$/);
    expect(genId('msg')).toMatch(/^msg_/);
    expect(a).not.toBe(b);
  });
});

describe('safeJsonParse / prettyJson', () => {
  it('安全解析合法 JSON', () => {
    expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 });
    expect(safeJsonParse('[1,2]', [])).toEqual([1, 2]);
  });

  it('非法 JSON 返回 fallback', () => {
    expect(safeJsonParse('not-json', 'fallback')).toBe('fallback');
    expect(safeJsonParse('', { d: 1 })).toEqual({ d: 1 });
  });

  it('prettyJson 格式化为缩进 JSON', () => {
    expect(prettyJson('{"a":1,"b":[1,2]}')).toBe(JSON.stringify({ a: 1, b: [1, 2] }, null, 2));
  });

  it('prettyJson 非法输入原样返回', () => {
    expect(prettyJson('plain text')).toBe('plain text');
  });
});
