import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class ZhipuProvider extends BaseProvider {
  readonly id = 'zhipu';
  readonly name = '智谱';
  readonly region = 'china';

  private apiKey = '';
  private apiBase = 'https://open.bigmodel.cn/api/paas/v4';

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
      { id: 'glm-4-plus', name: 'GLM-4 Plus', provider: 'zhipu', maxTokens: 16384, supportsStreaming: true, supportsVision: true, supportsTools: true, region: 'china' },
    ];
  }
}
