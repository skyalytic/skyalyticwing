import { unlink, stat } from 'node:fs/promises';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';

interface FileDeleteArgs {
  paths: string[];
}

/**
 * file-delete 工具：删除一个或多个文件。
 * 危险：true。安全：对每个路径进行白名单校验；仅删除文件（不递归目录）。
 */
export function createFileDeleteTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'file-delete',
    description: '删除一个或多个文件。仅允许删除白名单路径下的文件。',
    category: 'filesystem',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的文件绝对路径数组',
        },
      },
      required: ['paths'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as FileDeleteArgs;
      if (!a || !Array.isArray(a.paths) || a.paths.length === 0) {
        return { success: false, error: 'Parameter "paths" is required and must be a non-empty array' };
      }
      const results: string[] = [];
      const errors: string[] = [];
      for (const p of a.paths) {
        if (typeof p !== 'string' || p.length === 0) {
          errors.push(`Invalid path: ${String(p)}`);
          continue;
        }
        if (p.includes('\0')) {
          errors.push(`Path contains null bytes: ${p}`);
          continue;
        }
        if (!security.isPathAllowed(p, 'write')) {
          errors.push(`Path not allowed: ${p}`);
          continue;
        }
        try {
          const s = await stat(p);
          if (s.isDirectory()) {
            errors.push(`Cannot delete directory (use a directory tool): ${p}`);
            continue;
          }
          await unlink(p);
          results.push(`Deleted: ${p}`);
        } catch (err) {
          errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const output = [...results, ...errors].join('\n');
      const result: ToolResult = { success: errors.length === 0, output };
      if (errors.length > 0) result.error = `${errors.length} error(s)`;
      return result;
    },
  };
}
