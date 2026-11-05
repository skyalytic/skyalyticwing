import { writeFile, rename, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { recordFileCheckpoint, withFileMutation } from '../../../../modules/tools/files/checkpoint-store.js';
import { assertObservedVersion, observeVersion } from '../../../../modules/tools/files/observed-versions.js';

interface FileWriteArgs {
  path: string;
  content: string;
  expectedVersion?: string;
}

/** 轻量差异块：公共前后缀定位变更区，输出 IDE 风格 -/+ 行（限 200 行防刷屏） */
function buildDiff(oldContent: string | null, newContent: string): string {
  const oldLines = oldContent === null ? [] : oldContent.split('\n');
  const newLines = newContent.split('\n');
  let p = 0;
  const maxP = Math.min(oldLines.length, newLines.length);
  while (p < maxP && oldLines[p] === newLines[p]) p++;
  let s = 0;
  const maxS = Math.min(oldLines.length - p, newLines.length - p);
  while (s < maxS && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) s++;
  const removed = oldLines.slice(p, oldLines.length - s);
  const added = newLines.slice(p, newLines.length - s);
  if (removed.length === 0 && added.length === 0) return '';
  const out: string[] = [];
  for (let i = Math.max(0, p - 3); i < p; i++) out.push('  ' + oldLines[i]);
  for (const l of removed.slice(0, 200)) out.push('- ' + l);
  for (const l of added.slice(0, 200)) out.push('+ ' + l);
  const tailStart = newLines.length - s;
  for (let i = tailStart; i < Math.min(tailStart + 3, newLines.length); i++)
    out.push('  ' + newLines[i]);
  return out.join('\n');
}

/**
 * file-write 工具：原子写入文件（先写临时文件再 rename，避免半写状态）。
 * 危险：true。安全：路径白名单校验。
 * 相对路径按 ctx.workspace 解析（工程模式：projectDir 优先，否则智能体工作区/cwd）。
 */
export function createFileWriteTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'file-write',
    description:
      '写入文件（原子写入：先写临时文件再 rename）。仅允许访问白名单路径。相对路径按当前工作目录解析（已选择项目文件夹时即工程目录），产物文件建议用相对路径写入当前工作目录。',
    category: 'filesystem',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要写入的文件路径（绝对路径，或相对当前工作目录的相对路径）',
        },
        content: { type: 'string', description: '文件内容' },
        expectedVersion: {type:'string',description:'file-read 返回的版本；版本不符时拒绝覆盖，请重新读取合并'},
      },
      required: ['path', 'content'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as FileWriteArgs;
      if (!a || typeof a.path !== 'string' || a.path.length === 0) {
        return {
          success: false,
          error: 'Parameter "path" is required and must be a non-empty string',
        };
      }
      if (typeof a.content !== 'string') {
        return { success: false, error: 'Parameter "content" is required and must be a string' };
      }
      if (a.path.includes('\0')) {
        return { success: false, error: 'Path must not contain null bytes' };
      }
      // 相对路径按 ctx.workspace 解析（工程模式产物落点统一入口）
      const targetPath = isAbsolute(a.path)
        ? a.path
        : resolve(ctx.workspace || process.cwd(), a.path);
      if (!security.isPathAllowed(targetPath, 'write')) {
        return { success: false, error: `Path not allowed: ${targetPath}`, blocked: true };
      }
      // 临时文件须与目标在同一目录，确保 rename 是原子操作（同分区）
      if (!security.isPathAllowed(dirname(targetPath), 'write')) {
        return {
          success: false,
          error: `Directory not allowed: ${dirname(targetPath)}`,
          blocked: true,
        };
      }
      try {
        return await withFileMutation(targetPath, async () => {
          const dir = dirname(targetPath);
          const tmp = join(dir, `.skyalyticwing-tmp-${randomUUID()}`);
          // 检查点：记录写入前内容（支持前端"回退到本轮对话发起前"恢复 AI 更改）
          const oldContent = await readFile(targetPath, 'utf-8').catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          });
          assertObservedVersion(ctx.sessionId,targetPath,oldContent,a.expectedVersion);
          recordFileCheckpoint(ctx.sessionId, targetPath, oldContent, a.content);
          await writeFile(tmp, a.content, 'utf-8');
          await rename(tmp, targetPath);
          observeVersion(ctx.sessionId,targetPath,a.content);
          // diff 摘要：前端工具卡渲染 -/+ 变更行（AI 改文件的可视化对比）
          const diff = buildDiff(oldContent, a.content);
          return {
            success: true,
            output: `Wrote ${Buffer.byteLength(a.content, 'utf-8')} bytes to ${targetPath}`,
            data: {
              path: targetPath,
              created: oldContent === null,
              ...(diff ? { diff } : {}),
            },
          };
        });
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
