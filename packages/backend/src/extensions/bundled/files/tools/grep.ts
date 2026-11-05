import { readdir, stat } from 'node:fs/promises';
import { createReadStream, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { globToRegExp } from '../../shared/tools/glob-utils.js';

interface GrepArgs {
  pattern: string;
  path: string;
  include?: string;
  offset?: number;
}

/** Long lines are searched too; output previews can be read in full through file-read. */

/** 最大递归深度 */

/** 最大返回匹配行数 */
const MAX_MATCHES = 500;

/**
 * grep 工具：递归搜索文件内容。
 * 安全：根目录须在白名单内；遍历逐路径校验。include 为文件名 glob 过滤。
 * pattern 作为正则表达式匹配（无法编译为正则时退化为字面量匹配）。
 */
export function createGrepTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'grep',
    description: '流式递归搜索文件内容（正则匹配），支持大文件。每页最多 500 条，使用 nextOffset 继续。无法完整搜索的文件或超长单行会显式报告。',
    category: 'filesystem',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（正则表达式）' },
        path: { type: 'string', description: '搜索根目录，须在白名单内' },
        include: { type: 'string', description: '文件名 glob 过滤，如 "*.ts"（可选）' },
        offset: { type: 'number', description: '跳过的匹配条数；使用返回的 nextOffset 获取下一页' },
      },
      required: ['pattern', 'path'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as GrepArgs;
      if (!a || typeof a.pattern !== 'string' || a.pattern.length === 0) {
        return { success: false, error: 'Parameter "pattern" is required and must be a non-empty string' };
      }
      if (typeof a.path !== 'string' || a.path.length === 0) {
        return { success: false, error: 'Parameter "path" is required and must be a non-empty string' };
      }
      if (a.path.includes('\0')) {
        return { success: false, error: 'Path must not contain null bytes' };
      }
      const root = resolve(_ctx.workspace || process.cwd(), a.path);
      if (!security.isPathAllowed(root)) {
        return { success: false, error: `Path not allowed: ${a.path}`, blocked: true };
      }
      let matcher: RegExp;
      try {
        matcher = new RegExp(a.pattern);
      } catch {
        matcher = new RegExp(escapeRegex(a.pattern));
      }
      const includeRe =
        typeof a.include === 'string' && a.include.length > 0 ? globToRegExp(a.include) : null;

      const matches: string[] = [];
      const warnings: string[] = [];
      const offset = Number.isSafeInteger(a.offset) && a.offset! >= 0 ? a.offset! : 0;
      let found = 0, more = false;
      const warn = (message: string) => { warnings.push(message); };
      const visited = new Set<string>();
      try {
        if ((await stat(root)).isFile()) await scan(root); else await walk(root, 0);
        return {
          success: true,
          output: (matches.length > 0 ? matches.join('\n') : '(no matches in searched content)') + (warnings.length ? '\n[搜索不完整]\n' + warnings.join('\n') : ''),
          data: { nextOffset: more ? offset + matches.length : null, truncated: more, incomplete: warnings.length > 0, warnings },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      async function walk(dir: string, depth: number): Promise<void> {
        if (more) return;
        if (_ctx.signal?.aborted) throw new Error('cancelled');
        if (!security.isPathAllowed(dir)) { warn(`路径未授权：${dir}`); return; }
        const key = dir.replace(/\\/g, '/').replace(/\/+$/, '');
        if (visited.has(key)) return;
        visited.add(key);
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          warn(`目录不可读：${dir}`);
          return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (more) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await walk(full, depth + 1);
          } else if (entry.isFile()) {
            if (includeRe && !includeRe.test(entry.name)) continue;
            if (!security.isPathAllowed(full)) continue;
            await scan(full);
          }
        }
      }
      async function scan(full: string) {
        let tail = '', line = 0;
        const accept = (text: string) => {
          line++;
          if (!matcher.test(text)) return;
          if (found++ < offset) return;
          if (matches.length >= MAX_MATCHES) { more = true; return; }
          matches.push(`${full}:${line}:${text.length > 4000 ? text.slice(0, 4000) + ' [匹配行预览已截短，请用 file-read 读取]' : text}`);
        };
        try {
          for await (const chunk of createReadStream(full, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
            if (_ctx.signal?.aborted) throw new Error('cancelled');
            if (more) break;
            const text = String(chunk);
            if (text.includes('\0')) { warn(`二进制文件未搜索：${full}`); return; }
            tail += text;
            let end: number;
            while ((end = tail.indexOf('\n')) >= 0) {
              const value = tail.slice(0, end).replace(/\r$/, ''); tail = tail.slice(end + 1);
              accept(value);
              if (more) return;
            }
          }
          if (tail) accept(tail);
        } catch (e) { warn(`文件读取失败：${full}: ${String(e)}`); }
      }
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
