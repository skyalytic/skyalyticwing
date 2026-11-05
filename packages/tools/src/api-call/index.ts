import { BaseTool } from '../base-tool.js';

export class ApiCallTool extends BaseTool {
  readonly id = 'api-call';
  readonly name = 'API 调用';
  readonly description = '调用外部 API';
  readonly category = 'web';

  async execute(input: Record<string, unknown>): Promise<unknown> {
    // 调用 validate() 统一校验输入
    this.validate(input);
    throw new Error('Not implemented yet');
  }

  // 强制实现的输入校验方法，使用共享 sanitizeUrl 工具校验 URL 协议
  validate(input: Record<string, unknown>): void {
    const { url, method } = input as { url: string; method?: string };
    this.sanitizeUrl(url);
    if (method !== undefined && (typeof method !== 'string' || method.length === 0)) {
      throw new Error('Parameter "method" must be a non-empty string when provided');
    }
  }
}
