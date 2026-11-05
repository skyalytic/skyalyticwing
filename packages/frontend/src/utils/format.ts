import { wt } from '@/i18n/workbench-text';
import i18n from '@/i18n';
// 格式化工具

/** 格式化时间戳为本地时间字符串 */
export function formatTime(ts: number | string | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 仅日期 */
export function formatDate(ts: number | string | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 相对时间（如 "3 分钟前"） */
export function formatRelativeTime(ts: number | string | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  const time = date.getTime();
  if (Number.isNaN(time)) return '--';
  const diff = Date.now() - time;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return wt('刚刚');
  const min = Math.floor(sec / 60);
  if (min < 60) return wt('{{v0}} 分钟前', { v0: min });
  const hour = Math.floor(min / 60);
  if (hour < 24) return wt('{{v0}} 小时前', { v0: hour });
  const day = Math.floor(hour / 24);
  if (day < 30) return wt('{{v0}} 天前', { v0: day });
  const month = Math.floor(day / 30);
  if (month < 12) return wt('{{v0}} 个月前', { v0: month });
  const year = Math.floor(month / 12);
  return wt('{{v0}} 年前', { v0: year });
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** 格式化时长（ms -> 可读） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const min = Math.floor(sec / 60);
  const rest = Math.floor(sec % 60);
  return `${min}m ${rest}s`;
}

/** 格式化运行时长（秒 -> 可读，空值显示 --） */
export function formatUptime(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(wt('{{v0}}天', { v0: d }));
  if (h > 0) parts.push(wt('{{v0}}小时', { v0: h }));
  if (m > 0) parts.push(wt('{{v0}}分', { v0: m }));
  if (s > 0 || parts.length === 0) parts.push(wt('{{v0}}秒', { v0: s }));
  return parts.join(' ');
}

/** 数字千分位 */
export function formatNumber(n: number | undefined | null): string {
  // 后端监控字段可能缺失（undefined），空值显示 0 防止整页崩溃
  return (n ?? 0).toLocaleString(i18n.resolvedLanguage || i18n.language);
}

/** 截断字符串 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

/** 生成唯一 id */
export function genId(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** 安全 JSON 解析 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 尝试将字符串格式化为缩进 JSON */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
