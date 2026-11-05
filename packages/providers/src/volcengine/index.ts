import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class VolcengineProvider extends BaseProvider {
  readonly id = 'volcengine';
  readonly name = '火山引擎';
  readonly region = 'china';

  private apiKey = '';
  private endpointId = '';
  private apiBase = 'https://ark.cn-beijing.volces.com/api/v3';

  configure(config: Record<string, unknown>): void {
    const c = config as { apiKey?: string; endpointId?: string; apiBase?: string };
    // 校验必填字段 apiKey/endpointId
    this.apiKey = this._requireString(c.apiKey, 'apiKey');
    this.endpointId = this._requireString(c.endpointId, 'endpointId');
    // 校验 apiBase scheme 与目标地址，拒绝私网/环回/链路本地 IP 防止 SSRF
    if (c.apiBase) this.apiBase = this._validateApiBase(c.apiBase);
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (!this.apiKey) throw new Error('Configure the provider API key first');
    yield* openaiChat({ ...params, model: params.model || this.endpointId }, (this.apiBase).replace(/\/$/, '') + '/chat/completions', { Authorization: 'Bearer ' + this.apiKey });
  }
  listModels(): ModelDefinition[] {
    return [
      { id: 'doubao-pro', name: '豆包 Pro', provider: 'volcengine', maxTokens: 16384, supportsStreaming: true, supportsTools: true, region: 'china' },
    ];
  }
}
