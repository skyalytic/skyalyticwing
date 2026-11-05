import { BaseTool } from '../base-tool.js';

export class BashTool extends BaseTool {
  readonly id = 'bash';
  readonly name = 'Shell 执行';
  readonly description = '执行 Shell 命令';
  readonly category = 'runtime';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    // 此基础工具尚未提供执行适配器，显式失败以免误报执行成功。
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { command } = input as { command: string };
    if (!command || typeof command !== 'string') throw new Error('Parameter "command" is required');
  }
}
