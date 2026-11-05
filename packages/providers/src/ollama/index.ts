import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  readonly region = 'both';

  private baseUrl = 'http://localhost:11434';

  configure(config: Record<string, unknown>): void {
    const c = config as { baseUrl?: string };
    // Ollama 为本地推理服务（默认 http://localhost:11434），通过 allowLoopback 放行
    // loopback 地址与非加密 http scheme；仍拒绝私网/链路本地等敏感地址（除 loopback 外）
    if (c.baseUrl) this.baseUrl = this._validateApiBase(c.baseUrl, { allowLoopback: true });
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* openaiChat(params, (this.baseUrl.replace(/\/$/, '') + '/v1').replace(/\/$/, '') + '/chat/completions', { Authorization: 'Bearer ' + 'ollama' });
  }
  listModels(): ModelDefinition[] {
    return [{ id: 'local', name: '本地模型', provider: 'ollama', supportsStreaming: true, region: 'both' }];
  }
}
