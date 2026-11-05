import { BaseTool } from '../base-tool.js';

export class NodeTool extends BaseTool {
  readonly id = 'node';
  readonly name = 'Node 执行';
  readonly description = '执行 Node.js 代码';
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
