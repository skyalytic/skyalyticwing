import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, basename } from 'node:path';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { globToRegExp } from '../../shared/tools/glob-utils.js';

interface GlobArgs {
  pattern: string;
  path?: string;
  offset?: number;
}

/** 单页大小；nextOffset 可继续读取，结果总量和遍历深度不设上限。 */
const PAGE_SIZE = 1000;
/** 最大递归深度 */


/**
 * glob 工具：按 glob 模式递归匹配文件路径。
 * 安全：根目录（path，默认 cwd）须在白名单内；遍历过程逐路径校验。
 */
export function createGlobTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'glob',
    description: '按 glob 模式递归匹配文件路径（支持 *、**、?、{a,b}）。不限制搜索深度或结果总量，使用 nextOffset 继续读取后续页。',
    category: 'filesystem',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: '匹配结果起点；用 nextOffset 继续获取全部结果' },
        pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"' },
        path: { type: 'string', description: '搜索根目录（默认当前工作区），须在白名单内' },
      },
      required: ['pattern'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as GlobArgs;
      if (!a || typeof a.pattern !== 'string' || a.pattern.length === 0) {
        return { success: false, error: 'Parameter "pattern" is required and must be a non-empty string' };
      }
      const root = typeof a.path === 'string' && a.path.length > 0 ? a.path : ctx.workspace;
      if (root.includes('\0')) {
        return { success: false, error: 'Path must not contain null bytes' };
      }
      if (!security.isPathAllowed(root)) {
        return { success: false, error: `Path not allowed: ${root}`, blocked: true };
      }
      const re = globToRegExp(a.pattern);
      const results: string[] = [];
      const offset = Number.isSafeInteger(a.offset) && a.offset! >= 0 ? a.offset! : 0;
      let found = 0, more = false;
      const visited = new Set<string>();
      try {
        await walk(root, 0);
        return {
          success: true,
          output: results.length > 0 ? results.join('\n') : '(no matches)',
          data: {nextOffset: more ? offset + results.length : null, partial: more},
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      async function walk(dir: string, depth: number): Promise<void> {
        if (more) return;
        if (ctx.signal?.aborted) throw new Error('cancelled');
        if (!security.isPathAllowed(dir)) return;
        const real = resolveKey(dir);
        if (visited.has(real)) return;
        visited.add(real);
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return; // 无权限或不存在则跳过
        }
        for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
          if (more) return;
          const full = join(dir, entry.name);
          const rel = full.slice(root.length).replace(/^[/\\]+/, '');
          // 同时尝试用相对路径和 basename 匹配
          if (entry.isFile() && (re.test(rel) || re.test(basename(full)))) {
            if (!security.isPathAllowed(full)) continue;
            if (found++ < offset) continue;
            if (results.length >= PAGE_SIZE) { more = true; return; }
            results.push(full);
          }
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await walk(full, depth + 1);
          }
        }
      }
    },
  };
}

function resolveKey(p: string): string {
  // 简单规范化用于去重（不解析 symlink 以避免额外 IO）
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
