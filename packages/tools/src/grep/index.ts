import { BaseTool } from '../base-tool.js';

export class GrepTool extends BaseTool {
  readonly id = 'grep';
  readonly name = '内容搜索';
  readonly description = '在文件中搜索匹配内容';
  readonly category = 'files';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法，使用共享 sanitizePath 工具规范化可选路径
  validate(input: Record<string, unknown>): void {
    const { pattern, path: filePath } = input as { pattern: string; path?: string };
    if (!pattern || typeof pattern !== 'string') throw new Error('Parameter "pattern" is required');
    if (filePath !== undefined) this.sanitizePath(filePath);
  }
}
