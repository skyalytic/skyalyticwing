import { BaseTool } from '../base-tool.js';

export class CodeFormatTool extends BaseTool {
  readonly id = 'code-format';
  readonly name = '代码格式化';
  readonly description = '格式化代码';
  readonly category = 'code';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法，使用共享 sanitizePath 工具规范化路径
  validate(input: Record<string, unknown>): void {
    const { path: filePath } = input as { path: string };
    this.sanitizePath(filePath);
  }
}
