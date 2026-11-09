import { NativeOfficeService } from '../../../../modules/tools/files/native-office.service.js';
import { RemoteWorkspaceService } from '../../../../modules/core/remote-workspace/remote-workspace.service.js';
import type { ToolDefinition } from '@skyalyticwing/shared';
import { OfficeService } from '../../../../modules/tools/files/office.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
export function createOfficeTools(resolve: ServiceResolver): ToolDefinition[] {
  const tools: ToolDefinition[] = [false, true].map((write) => ({
    name: write ? 'office_edit' : 'office_read',
    category: 'file',
    dangerous: write,
    description: write
      ? '按 office_read 返回的原文件版本和元素 ID 修改 Word/PPT 文字或 Excel 单元格，保留其他格式。版本冲突时先重新读取，不覆盖用户修改。'
      : '读取当前工作区 Word、Excel、PPT 的文字/单元格结构与版本，用于分析和后续精确修改。返回不是原始二进制。',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const },
        revision: { type: 'string' as const },
        changes: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: { id: { type: 'string' as const }, value: { type: 'string' as const } },
            required: ['id', 'value'],
          },
        },
      },
      required: write ? ['path', 'revision', 'changes'] : ['path'],
    },
    async execute(raw: unknown) {
      const service = resolve<OfficeService>(OfficeService);
      if (!service) return { success: false, error: 'Office 文件服务不可用' };
      try {
        const args = raw as {
          path: string;
          revision: string;
          changes: Array<{ id: string; value: string }>;
        };
        const data = write
          ? await service.save(args.path, args.revision, args.changes)
          : await service.read(args.path);
        return { success: true, data, output: JSON.stringify(data) };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }));
  tools.push({
    name: 'office_live',
    category: 'file',
    dangerous: true,
    description:
      '操作用户已在内置 Office 中打开的文档，与手动编辑使用同一个实时引擎。可在光标处插入文字、修改表格单元格（坐标从 0 开始，value 支持公式）、新增幻灯片、格式设置或读取选中内容。操作后自动保存；不要同时用文件工具覆盖此文档。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        action: {
          type: 'string',
          enum: ['insert_text', 'set_cell', 'insert_slide', 'format', 'read_selection', 'save'],
        },
        text: { type: 'string' },
        sheet: { type: 'number' },
        row: { type: 'number' },
        column: { type: 'number' },
        value: { type: 'string' },
        command: {
          type: 'string',
          enum: ['bold', 'italic', 'underline', 'undo', 'redo', 'align_center', 'align_left'],
        },
      },
      required: ['path', 'action'],
    },
    async execute(raw: unknown, ctx) {
      const service = resolve<NativeOfficeService>(NativeOfficeService);
      if (!service) return { success: false, error: '内置 Office 服务不可用' };
      try {
        const { path, action, ...args } = raw as {
          path: string;
          action: string;
          [key: string]: unknown;
        };
        const workspace = resolve<RemoteWorkspaceService>(RemoteWorkspaceService)?.binding(
          ctx.sessionId,
        );
        const data = await service.live(path, action, args, workspace?.id);
        return { success: true, data, output: JSON.stringify(data) };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
  return tools;
}
