import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { withFileMutation, recordFileCheckpoint } from '../../../../modules/tools/files/checkpoint-store.js';
import { assertObservedVersion, observeVersion } from '../../../../modules/tools/files/observed-versions.js';

interface FileEditArgs {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedVersion?: string;
}

/**
 * file-edit 工具：读取文件，替换文本，原子写回。
 * 危险：true。安全：路径白名单校验。
 */
export function createFileEditTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'file-edit',
    description: '编辑文件：将 oldText 替换为 newText，支持 replaceAll。仅允许访问白名单路径。',
    category: 'filesystem',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要编辑的文件绝对路径' },
        oldText: { type: 'string', description: '要被替换的文本' },
        newText: { type: 'string', description: '替换后的文本' },
        replaceAll: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
        expectedVersion: { type: 'string', description: 'file-read returned version; stale edits are rejected rather than overwriting newer work.' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as FileEditArgs;
      if (!a || typeof a.path !== 'string' || a.path.length === 0) {
        return { success: false, error: 'Parameter "path" is required and must be a non-empty string' };
      }
      if (typeof a.oldText !== 'string' || typeof a.newText !== 'string') {
        return { success: false, error: 'Parameters "oldText" and "newText" are required and must be strings' };
      }
      if (a.oldText.length === 0) {
        return { success: false, error: 'Parameter "oldText" must not be empty' };
      }
      if (a.path.includes('\0')) {
        return { success: false, error: 'Path must not contain null bytes' };
      }
      const path = resolve(ctx.workspace || process.cwd(), a.path);
      if (!security.isPathAllowed(path, 'write') || !security.isPathAllowed(dirname(path), 'write')) {
        return { success: false, error: `Path not allowed: ${a.path}`, blocked: true };
      }
      try {
        return await withFileMutation(path, async () => {
        const content = await readFile(path, 'utf-8');
        assertObservedVersion(ctx.sessionId, path, content, a.expectedVersion);
        let newContent: string;
        let replacements: number;
        if (a.replaceAll) {
          const parts = content.split(a.oldText);
          replacements = parts.length - 1;
          newContent = parts.join(a.newText);
        } else {
          const idx = content.indexOf(a.oldText);
          if (idx === -1) {
            return { success: false, error: 'oldText not found in file' };
          }
          // 检查是否有多处匹配（提示用户使用 replaceAll）
          const nextIdx = content.indexOf(a.oldText, idx + a.oldText.length);
          if (nextIdx !== -1) {
            return {
              success: false,
              error: 'oldText matches multiple occurrences; set replaceAll=true to replace all',
            };
          }
          replacements = 1;
          newContent = content.slice(0, idx) + a.newText + content.slice(idx + a.oldText.length);
        }
        if (replacements === 0) {
          return { success: false, error: 'oldText not found in file' };
        }
        // 原子写回
        const dir = dirname(path);
        const tmp = join(dir, `.skyalyticwing-tmp-${randomUUID()}`);
        recordFileCheckpoint(ctx.sessionId, path, content, newContent);
        try {
          await writeFile(tmp, newContent, 'utf-8');
          await rename(tmp, path);
        } finally { await unlink(tmp).catch(() => undefined); }
        const version = observeVersion(ctx.sessionId, path, newContent);
        return {
          success: true,
          output: `Edited ${path}: ${replacements} replacement(s)`,
          data: { path, version, replacements, diff: createTwoFilesPatch(path, path, content, newContent, '', '', {context: 3, timeout: 200, maxEditLength: 10000}) || '' },
        };
        });
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
