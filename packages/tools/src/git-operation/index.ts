import { BaseTool } from '../base-tool.js';

export class GitOperationTool extends BaseTool {
  readonly id = 'git-operation';
  readonly name = 'Git 操作';
  readonly description = '执行 Git 操作';
  readonly category = 'code';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { operation, args } = input as { operation: string; args?: string[] };
    if (!operation || typeof operation !== 'string') throw new Error('Parameter "operation" is required');
    if (args !== undefined && !Array.isArray(args)) {
      throw new Error('Parameter "args" must be an array of strings when provided');
    }
    if (Array.isArray(args)) {
      for (const a of args) {
        if (typeof a !== 'string') throw new Error('Each item in "args" must be a string');
      }
    }
  }
}
