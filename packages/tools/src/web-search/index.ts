import { BaseTool } from '../base-tool.js';

export class WebSearchTool extends BaseTool {
  readonly id = 'web-search';
  readonly name = '网页搜索';
  readonly description = '搜索网页内容';
  readonly category = 'web';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法
  validate(input: Record<string, unknown>): void {
    const { query } = input as { query: string };
    if (!query || typeof query !== 'string') throw new Error('Parameter "query" is required');
  }
}
