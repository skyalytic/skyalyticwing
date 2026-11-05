import { BaseTool } from '../base-tool.js';

export class NotifyTool extends BaseTool {
  readonly id = 'notify';
  readonly name = '通知';
  readonly description = '发送通知';
  readonly category = 'ui';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { message, type } = input as { message: string; type?: string };
    if (!message || typeof message !== 'string') throw new Error('Parameter "message" is required');
    if (type !== undefined && (typeof type !== 'string' || type.length === 0)) {
      throw new Error('Parameter "type" must be a non-empty string when provided');
    }
  }
}
