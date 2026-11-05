import { BaseTool } from '../base-tool.js';

export class PowerShellTool extends BaseTool {
  readonly id = 'powershell';
  readonly name = 'PowerShell 执行';
  readonly description = '执行 PowerShell 命令';
  readonly category = 'runtime';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { command } = input as { command: string };
    if (!command || typeof command !== 'string') throw new Error('Parameter "command" is required');
  }
}
