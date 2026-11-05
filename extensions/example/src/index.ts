import { defineTool } from '@skyalyticwing/sdk/tool';
import { z } from 'zod';

// L-I1 fix: 使用 zod schema 对输入做严格校验，避免恶意/畸形输入进入扩展逻辑。
// 之前 ExampleInputSchema 仅要求 message 为 string，未限制长度/内容，
// 作为示例代码会引导用户写出不安全的扩展。
const ExampleInputSchema = z.object({
  message: z
    .string()
    .min(1, 'message must not be empty')
    .max(4096, 'message exceeds maximum length of 4096 characters')
    .refine(
      (val) => !/(<script|javascript:|on\w+\s*=)/i.test(val),
      'message contains potentially malicious content'
    ),
});

export const ExampleTool = defineTool({
  name: 'ExampleTool',
  description: 'An example tool from extension',
  category: 'custom',
  inputSchema: ExampleInputSchema,

  async execute(input, context) {
    // L-I1 fix: execute 内再次防御性校验 input.message 类型与长度。
    // schema 校验在框架层进行，但扩展内部不应假设输入已被校验（防御性编程）。
    if (typeof input.message !== 'string' || input.message.length === 0) {
      throw new Error('Invalid input: message must be a non-empty string');
    }
    if (input.message.length > 4096) {
      throw new Error('Invalid input: message exceeds maximum length');
    }
    return { result: `Processed: ${input.message}` };
  }
});

export default {
  id: 'example-extension',
  name: 'Example Extension',
  version: '1.0.0',
  tools: [ExampleTool],
  onLoad: async (context) => {
    context.logger.info('Example extension loaded');
  },
  onMessage: async (message, context) => {
    // L-I1 fix: onMessage 内对 message 做输入校验，示例代码应展示安全实践。
    // 之前仅 context.logger.debug('Message received:', message) 未做任何校验，
    // 作为示例会引导用户写出不安全的扩展（未校验 message 字段类型/长度/恶意内容）。
    if (!message || typeof message !== 'object') {
      context.logger.warn('onMessage received invalid message: expected object, got', typeof message);
      return;
    }
    // 校验 message 类型字段（根据实际消息结构扩展）。
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    if (msgStr.length > 10240) {
      context.logger.warn('onMessage received oversized message, ignoring (length: %d)', msgStr.length);
      return;
    }
    context.logger.debug('Message received:', msgStr);
  },
};
