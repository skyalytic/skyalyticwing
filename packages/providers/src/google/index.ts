import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class GoogleProvider extends BaseProvider {
  readonly id = 'google';
  readonly name = 'Google';
  readonly region = 'international';

  private apiKey = '';

  configure(config: Record<string, unknown>): void {
    const c = config as { apiKey?: string };
    // 校验 apiKey 必填字段
    this.apiKey = this._requireString(c.apiKey, 'apiKey');
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (!this.apiKey) throw new Error('Configure the provider API key first');
    yield* openaiChat(params, ('https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '') + '/chat/completions', { Authorization: 'Bearer ' + this.apiKey });
  }
  listModels(): ModelDefinition[] {
    return [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', maxTokens: 32768, supportsStreaming: true, supportsVision: true, supportsTools: true, region: 'international' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google', maxTokens: 16384, supportsStreaming: true, supportsVision: true, supportsTools: true, region: 'international' },
    ];
  }
}
