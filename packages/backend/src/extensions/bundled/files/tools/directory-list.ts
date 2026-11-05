import { readdir } from 'node:fs/promises';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { globToRegExp } from '../../shared/tools/glob-utils.js';

interface DirectoryListArgs {
  path: string;
  ignore?: string[];
}

/**
 * directory-list 工具：列出目录内容。
 * 安全：路径白名单校验。ignore 为 glob 模式数组，匹配的条目将被排除。
 */
export function createDirectoryListTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'directory-list',
    description: '列出指定目录的内容。仅允许访问白名单路径。',
    category: 'filesystem',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出的目录绝对路径' },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: '要忽略的 glob 模式数组（可选）',
        },
      },
      required: ['path'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as DirectoryListArgs;
      if (!a || typeof a.path !== 'string' || a.path.length === 0) {
        return { success: false, error: 'Parameter "path" is required and must be a non-empty string' };
      }
      if (a.path.includes('\0')) {
        return { success: false, error: 'Path must not contain null bytes' };
      }
      if (!security.isPathAllowed(a.path)) {
        return { success: false, error: `Path not allowed: ${a.path}`, blocked: true };
      }
      const ignorePatterns = Array.isArray(a.ignore)
        ? a.ignore.filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => globToRegExp(p))
        : [];
      try {
        const entries = await readdir(a.path, { withFileTypes: true });
        const lines: string[] = [];
        for (const entry of entries) {
          const name = entry.name;
          if (ignorePatterns.some((re) => re.test(name))) continue;
          const type = entry.isDirectory()
            ? 'dir'
            : entry.isFile()
              ? 'file'
              : entry.isSymbolicLink()
                ? 'link'
                : 'other';
          lines.push(`${type}\t${name}`);
        }
        // 排序：目录在前
        lines.sort();
        return { success: true, output: lines.join('\n') || '(empty)' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
