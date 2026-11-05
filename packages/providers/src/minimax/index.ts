import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class MinimaxProvider extends BaseProvider {
  readonly id = 'minimax';
  readonly name = 'MiniMax';
  readonly region = 'china';

  private apiKey = '';
  private groupId = '';
  private apiBase = 'https://api.minimax.io/v1';

  configure(config: Record<string, unknown>): void {
    const c = config as { apiKey?: string; groupId?: string; apiBase?: string };
    // 校验 apiKey 必填字段
    this.apiKey = this._requireString(c.apiKey, 'apiKey');
    this.groupId = c.groupId ?? '';
    // 校验 apiBase scheme 与目标地址，拒绝私网/环回/链路本地 IP 防止 SSRF
    if (c.apiBase) this.apiBase = this._validateApiBase(c.apiBase);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (!this.apiKey) throw new Error('Configure the provider API key first');
    yield* openaiChat(params, (this.apiBase).replace(/\/$/, '') + '/chat/completions', { Authorization: 'Bearer ' + this.apiKey });
  }
  listModels(): ModelDefinition[] {
    return [
      { id: 'minimax-text-01', name: 'MiniMax-Text-01', provider: 'minimax', maxTokens: 16384, supportsStreaming: true, supportsTools: true, region: 'china' },
    ];
  }
}
