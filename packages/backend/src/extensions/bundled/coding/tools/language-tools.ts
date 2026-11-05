import { resolve as pathResolve } from 'node:path';
import type { ToolDefinition, ToolContext } from '@skyalyticwing/shared';
import { LspService, type LanguageQuery } from '../../../../modules/tools/lsp/lsp.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

export function createLanguageTools(resolve: ServiceResolver): ToolDefinition[] {
  return [
    {
      name: 'lsp_query',
      category: 'development',
      dangerous: false,
      description:
        '真实项目语言服务：定义、引用、实现、悬浮信息、符号、补全、签名、文件/项目诊断。rename/format 返回可审查预览，不直接写入。位置从 1 开始。其他语言需要已安装语言服务器。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'diagnostics',
              'projectDiagnostics',
              'definition',
              'references',
              'implementation',
              'hover',
              'symbols',
              'workspaceSymbols',
              'completion',
              'signature',
              'rename',
              'format',
              'codeActions',
              'organizeImports',
            ],
          },
          file: { type: 'string' },
          root: { type: 'string' },
          line: { type: 'number' },
          col: { type: 'number' },
          newName: { type: 'string' },
          query: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['action', 'file'],
      },
      async execute(raw: unknown, ctx: ToolContext) {
        try {
          const service = resolve<LspService>(LspService);
          if (!service) throw new Error('Language service unavailable');
          const input = raw as LanguageQuery;
          const root = pathResolve(ctx.workspace || process.cwd(), input.root || '.');
          const data = await service.query(
            { ...input, root, file: pathResolve(root, input.file) },
            ctx.signal,
            ctx.sessionId,
          );
          return { success: true, data, output: JSON.stringify(data) };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      },
    },
    {
      name: 'lsp_apply',
      category: 'development',
      dangerous: true,
      description:
        '应用本会话已审查的语言服务重命名/格式化预览。检查全部文件版本，拒绝覆盖后来修改，保留文件恢复记录。',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(raw: unknown, ctx: ToolContext) {
        try {
          const service = resolve<LspService>(LspService);
          if (!service) throw new Error('Language service unavailable');
          if (ctx.signal?.aborted) throw new Error('Cancelled');
          const data = await service.apply((raw as { id: string }).id, ctx.sessionId);
          return { success: true, data, output: JSON.stringify(data) };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }
      },
    },
  ];
}
