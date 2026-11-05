import { BaseTool } from '../base-tool.js';

export class GlobTool extends BaseTool {
  readonly id = 'glob';
  readonly name = '文件匹配';
  readonly description = '使用 glob 模式匹配文件';
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
