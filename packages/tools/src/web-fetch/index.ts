import { BaseTool } from '../base-tool.js';

export class WebFetchTool extends BaseTool {
  readonly id = 'web-fetch';
  readonly name = '网页获取';
  readonly description = '获取网页内容';
  readonly category = 'web';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法，使用共享 sanitizeUrl 工具校验 URL 协议
  validate(input: Record<string, unknown>): void {
    const { url } = input as { url: string };
    this.sanitizeUrl(url);
  }
}
