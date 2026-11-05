import { BaseTool } from '../base-tool.js';

export class AskUserTool extends BaseTool {
  readonly id = 'ask-user';
  readonly name = '询问用户';
  readonly description = '向用户提问并等待回复';
  readonly category = 'ui';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { question } = input as { question: string };
    if (!question || typeof question !== 'string') throw new Error('Parameter "question" is required');
  }
}
