/**
 * 终端输出格式化辅助（零依赖，无 ANSI 颜色库）
 */

/**
 * 打印简易对齐表格（按码点数对齐；中日韩全角字符按单宽处理，存在轻微错位）。
 * 表格输出到 stdout。
 */
export function printTable(headers: readonly string[], rows: readonly string[][]): void {
  const widths = headers.map((h, col) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0, ' ')).join('  ');

  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

/** 毫秒时间戳 → 本地时间字符串；空值显示 '-' */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return '-';
  return new Date(ms).toLocaleString('sv-SE').replace('T', ' ');
}

/** 秒数 → 人类可读运行时长，如 "2d 3h 4m"、"5m 12s" */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** 截断过长文本，超出部分以 … 结尾 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}
