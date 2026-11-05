import { openaiChat } from '../http-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class AzureProvider extends BaseProvider {
  readonly id = 'azure';
  readonly name = 'Azure OpenAI';
  readonly region = 'international';

  private apiKey = '';
  private endpoint = '';
  private deploymentName = '';
  private apiVersion = '2024-10-21';

  configure(config: Record<string, unknown>): void {
    const c = config as { apiKey?: string; endpoint?: string; deploymentName?: string; apiVersion?: string };
    // 校验必填字段 apiKey/endpoint/deploymentName
    this.apiKey = this._requireString(c.apiKey, 'apiKey');
    // 校验 endpoint scheme 与目标地址，拒绝私网/环回/链路本地 IP 防止 SSRF
    this.endpoint = this._validateApiBase(this._requireString(c.endpoint, 'endpoint'));
    this.deploymentName = this._requireString(c.deploymentName, 'deploymentName');
    if (c.apiVersion) this.apiVersion = this._requireString(c.apiVersion, 'apiVersion');
  }

  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (!this.apiKey || !this.endpoint || !this.deploymentName) throw new Error('Configure Azure credentials, endpoint and deployment first');
    const url = this.endpoint.replace(/\/$/, '') + '/openai/deployments/' + encodeURIComponent(this.deploymentName) + '/chat/completions?api-version=' + encodeURIComponent(this.apiVersion);
    yield* openaiChat({...params, model: this.deploymentName}, url, {'api-key': this.apiKey});
  }
  listModels(): ModelDefinition[] {
    return [{ id: 'azure-gpt-4o', name: 'Azure GPT-4o', provider: 'azure', maxTokens: 16384, supportsStreaming: true, supportsTools: true, region: 'international' }];
  }
}
