import { readFile, realpath, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { fileContentKind } from '../../../../modules/tools/files/file-content-kind.js';
import { LargeTextStore, FULL_TEXT_BYTES } from '../../../../modules/tools/files/large-text.store.js';
import { isAbsolute, resolve } from 'node:path';
import { observeVersion } from '../../../../modules/tools/files/observed-versions.js';
import type { ToolDefinition, ToolResult, ToolContext } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';

interface FileReadArgs {
  path: string;
  offset?: number;
  limit?: number;
  byteOffset?: number;
}

/**
 * file-read 工具：读取文件内容，支持 offset/limit 行级分页。
 * 安全：调用 SecurityManagerService.isPathAllowed 进行路径白名单校验。
 */
export function createFileReadTool(security: SecurityManagerService): ToolDefinition {
  return {
    name: 'file-read',
    description: '读取本地文本或图片。PNG/JPEG/WebP 等图片作为视觉观察返回给支持视觉的模型，不按文本解码；PDF、音视频、压缩包等二进制请使用对应解析工具。文本支持 offset/limit 行分页，大文本使用 byteOffset 和 nextByteOffset 分段读取。仅允许访问白名单路径。',
    category: 'filesystem',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的文件绝对路径' },
        offset: { type: 'number', description: '起始行号（从 1 开始），可选' },
        limit: { type: 'number', description: '读取的最大行数，可选' },
        byteOffset: { type: 'number', description: '大文件分段起始字节位置，默认 0；使用返回的 nextByteOffset 继续读取' },
      },
      required: ['path'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as FileReadArgs;
      if (!a || typeof a.path !== 'string' || a.path.length === 0) {
        return { success: false, error: 'Parameter "path" is required and must be a non-empty string' };
      }
      if (a.path.includes('\0')) {
        return { success: false, error: 'Path must not contain null bytes' };
      }
      const targetPath=isAbsolute(a.path)?a.path:resolve(ctx.workspace || process.cwd(),a.path);
      if (!security.isPathAllowed(targetPath)) {
        return { success: false, error: `Path not allowed: ${a.path}`, blocked: true };
      }
      try {
        const actualPath = await realpath(targetPath);
        if (!security.isPathAllowed(actualPath)) return {success:false,error:'Path not allowed',blocked:true};
        const info = await stat(actualPath);
        if (!info.isFile()) return {success:false,error:'请指定一个普通文件'};
        const kind = await fileContentKind(actualPath);
        if (kind === 'image') {
          const original = await sharp(actualPath).metadata();
          const preview = await sharp(actualPath).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true})
            .flatten({background:'#ffffff'}).jpeg({quality:82}).toBuffer({resolveWithObject:true});
          return {success:true,output:`图片已读取：${targetPath}（${original.width}×${original.height}）。画面已作为视觉观察提供，请基于图片检查，不要把二进制当作文字。`,data:{path:targetPath,size:info.size,width:original.width,height:original.height,
            visualObservation:{kind:'image',base64:preview.data.toString('base64'),width:preview.info.width,height:preview.info.height}}};
        }
        if (kind === 'binary') return {success:false,error:'此文件是二进制或非 UTF-8 文本，不能按 UTF-8 读取。图片请用受支持的图片格式；音视频使用 inspect_video/FFmpeg，PDF/Office 使用相应解析工具，其他文本请明确正确编码。',data:{path:targetPath,size:info.size,binary:true}};
        if (info.size > FULL_TEXT_BYTES || a.byteOffset !== undefined) {
          if (a.offset !== undefined || a.limit !== undefined) return { success: false, error: '大文件请使用 byteOffset 分段读取；offset/limit 行分页仅用于普通文件' };
          const page = await new LargeTextStore(p => security.isPathAllowed(p)).page(targetPath, a.byteOffset ?? 0);
          return { success: true, output: page.content, data: { path: targetPath, byteOffset: page.offset, nextByteOffset: page.end < page.size ? page.end : null, size: page.size, partial: page.end < page.size || page.offset > 0, note: '当前仅为一个分段；继续读取 nextByteOffset，不能将此片段作为完整文件覆盖写回。' } };
        }
        const content = await readFile(targetPath, 'utf-8');
        const version=observeVersion(ctx.sessionId,targetPath,content);
        const lines = content.split(/\r?\n/);
        const offset =
          typeof a.offset === 'number' && a.offset > 0 ? Math.floor(a.offset) : 1;
        const limit =
          typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : lines.length;
        const sliced = lines.slice(offset - 1, offset - 1 + limit);
        return { success: true, output: sliced.join('\n'), data:{path:targetPath,version} };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
