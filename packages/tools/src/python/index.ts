import { BaseTool } from '../base-tool.js';

export class PythonTool extends BaseTool {
  readonly id = 'python';
  readonly name = 'Python 执行';
  readonly description = '执行 Python 代码';
  readonly category = 'runtime';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { code } = input as { code: string };
    if (!code || typeof code !== 'string') throw new Error('Parameter "code" is required');
  }
}
