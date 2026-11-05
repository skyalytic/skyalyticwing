import { BaseTool } from '../base-tool.js';

export class CodeTestTool extends BaseTool {
  readonly id = 'code-test';
  readonly name = '代码测试';
  readonly description = '运行代码测试';
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
