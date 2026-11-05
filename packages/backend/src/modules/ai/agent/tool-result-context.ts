import type { ToolResult } from '@skyalyticwing/shared';
import { isDeepStrictEqual } from 'node:util';
import { repairBinaryFileReadContent } from '../../tools/files/file-content-kind.js';

/** Drop only identical payload copies, never distinct metadata or failure details. */
export function toolResultContext(result: ToolResult): string {
  const { output, data, ...status } = result;
  let duplicate = false;
  if (typeof output === 'string' && data !== undefined) {
    duplicate = output === JSON.stringify(data) || output === data;
    if (!duplicate) {
      try {
        const parsed = JSON.parse(output);
        duplicate = isDeepStrictEqual(parsed, data);
        // Screenshot processing can add a receipt to data after output was formed.
        // Preserve that receipt without replaying the entire window/geometry twice.
        if (result.success && parsed && data && typeof parsed === 'object' && typeof data === 'object' &&
            !Array.isArray(parsed) && !Array.isArray(data) &&
            Object.keys(parsed).every(key => Object.hasOwn(data, key) &&
              isDeepStrictEqual(parsed[key], (data as Record<string, unknown>)[key]))) {
          return JSON.stringify(data);
        }
      } catch { /* Non-JSON output is independent content. */ }
    }
  }
  if (result.success && (data === undefined || duplicate)) return output ?? '';
  if (result.success && output === undefined) return JSON.stringify(data ?? '');
  return JSON.stringify({ ...status, ...(output !== undefined ? { output } : {}), ...(!duplicate && data !== undefined ? { data } : {}) });
}

/** Legacy history remains untouched; replay uses the same representation as live results. */
export function replayToolResult(content: string, toolName?: string): string {
  const repaired = repairBinaryFileReadContent(content, toolName);
  try {
    const result = JSON.parse(repaired);
    if (result && typeof result === 'object' && typeof result.success === 'boolean' &&
        ['output', 'data', 'error', 'blocked'].some(key => Object.hasOwn(result, key))) {
      return toolResultContext(result);
    }
  } catch { /* Plain text and interrupted-result receipts are already valid context. */ }
  return repaired;
}
