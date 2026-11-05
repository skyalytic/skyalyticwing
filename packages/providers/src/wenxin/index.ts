import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class WenxinProvider extends BaseProvider {
  readonly id = 'wenxin';
  readonly name = '文心一言';
  readonly region = 'china';

  private apiKey = '';
  private apiBase = 'https://qianfan.baidubce.com/v2';
  configure(config: Record<string, unknown>): void {
    if (config['secretKey']) throw new Error('Qianfan v2 requires a Bearer API key from the Qianfan console, not the legacy API Key/Secret Key pair');
    const key = this._requireString(config['apiKey'], 'apiKey');
    const base = this._validateApiBase(typeof config['apiBase'] === 'string' ? config['apiBase'] : 'https://qianfan.baidubce.com/v2');
    if (!base.startsWith('https://')) throw new Error('Qianfan requires https');
    this.apiKey = key; this.apiBase = base;
  }
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (!this.apiKey) throw new Error('Configure a Qianfan v2 API key first');
    yield* openaiChat(params, this.apiBase.replace(/\/$/, '') + '/chat/completions', {Authorization: 'Bearer ' + this.apiKey});
  }
  listModels(): ModelDefinition[] {
    return [
      { id: 'ernie-4.5', name: 'ERNIE 4.5', provider: 'wenxin', maxTokens: 16384, supportsStreaming: true, supportsTools: true, region: 'china' },
    ];
  }
}
