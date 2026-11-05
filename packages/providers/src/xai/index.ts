import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class XAIProvider extends BaseProvider {
  readonly id = 'xai';
  readonly name = 'xAI';
  readonly region = 'international';

  private apiKey = '';
  private apiBase = 'https://api.x.ai/v1';

  configure(config: Record<string, unknown>): void {
    const c = config as { apiKey?: string; apiBase?: string };
    // 校验 apiKey 必填字段
    this.apiKey = this._requireString(c.apiKey, 'apiKey');
    // 校验 apiBase scheme 与目标地址，拒绝私网/环回/链路本地 IP 防止 SSRF
    if (c.apiBase) this.apiBase = this._validateApiBase(c.apiBase);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (!this.apiKey) throw new Error('Configure the provider API key first');
    yield* openaiChat(params, (this.apiBase).replace(/\/$/, '') + '/chat/completions', { Authorization: 'Bearer ' + this.apiKey });
  }
  listModels(): ModelDefinition[] {
    return [
      { id: 'grok-3', name: 'Grok 3', provider: 'xai', maxTokens: 32768, supportsStreaming: true, supportsTools: true, region: 'international' },
    ];
  }
}
