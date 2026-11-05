import { BaseTool } from '../base-tool.js';

export class FileEditTool extends BaseTool {
  readonly id = 'file-edit';
  readonly name = '文件编辑';
  readonly description = '编辑文件内容';
  readonly category = 'files';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法，使用共享 sanitizePath 工具规范化路径
  validate(input: Record<string, unknown>): void {
    const { path: filePath, oldContent, newContent } = input as { path: string; oldContent: string; newContent: string };
    this.sanitizePath(filePath);
    if (typeof oldContent !== 'string') throw new Error('Parameter "oldContent" is required');
    if (typeof newContent !== 'string') throw new Error('Parameter "newContent" is required');
  }
}
