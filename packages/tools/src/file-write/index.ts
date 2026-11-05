import { BaseTool } from '../base-tool.js';

export class FileWriteTool extends BaseTool {
  readonly id = 'file-write';
  readonly name = '文件写入';
  readonly description = '写入文件内容';
  readonly category = 'files';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法，使用共享 sanitizePath 工具规范化路径
  validate(input: Record<string, unknown>): void {
    const { path: filePath, content } = input as { path: string; content: string };
    this.sanitizePath(filePath);
    if (typeof content !== 'string') throw new Error('Parameter "content" is required');
  }
}
