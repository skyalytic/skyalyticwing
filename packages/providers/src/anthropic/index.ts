import { anthropicChat } from '../anthropic-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  readonly region = 'international';

  private apiKey = '';
  private apiBase = 'https://api.anthropic.com/v1';

  configure(config: Record<string, unknown>): void {
    const c = config as { apiKey?: string; apiBase?: string };
    // 校验 apiKey 必填字段
    this.apiKey = this._requireString(c.apiKey, 'apiKey');
    // 校验 apiBase scheme 与目标地址，拒绝私网/环回/链路本地 IP 防止 SSRF
    if (c.apiBase) this.apiBase = this._validateApiBase(c.apiBase);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* anthropicChat(params, this.apiBase.replace(/\/$/, '') + '/messages', this.apiKey);
  }

  listModels(): ModelDefinition[] {
    return [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', maxTokens: 8192, supportsStreaming: true, supportsVision: true, supportsTools: true, region: 'international' },
      { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', provider: 'anthropic', maxTokens: 32768, supportsStreaming: true, supportsVision: true, supportsTools: true, region: 'international' },
    ];
  }
}
