import { openaiChat } from '../http-chat.js';
import { sparkChat } from '../spark-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class SparkProvider extends BaseProvider {
  readonly id = 'spark';
  readonly name = '讯飞星火';
  readonly region = 'china';

  private config = {appId: '', apiKey: '', apiSecret: '', url: '', domain: '4.0Ultra'};
  private apiPassword = '';
  configure(config: Record<string, unknown>): void {
    this.apiPassword = typeof config['apiPassword'] === 'string' ? config['apiPassword'] : '';
    if (this.apiPassword) {
      this.config = {appId: '', apiKey: '', apiSecret: '', domain: '', url: this._validateApiBase(typeof config['apiBase'] === 'string' ? config['apiBase'] : 'https://spark-api-open.xf-yun.com/v1')};
      if (!this.config.url.startsWith('https://')) throw new Error('Spark HTTP API requires https');
    } else {
      this.config = {appId: this._requireString(config['appId'], 'appId'), apiKey: this._requireString(config['apiKey'], 'apiKey'), apiSecret: this._requireString(config['apiSecret'], 'apiSecret'), domain: typeof config['domain'] === 'string' ? config['domain'] : '4.0Ultra', url: this._validateApiBase(typeof config['apiBase'] === 'string' ? config['apiBase'] : 'wss://spark-api.xf-yun.com/v4.0/chat')};
      if (!this.config.url.startsWith('wss://')) throw new Error('Spark legacy credentials require wss');
    }
  }
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    if (this.apiPassword) yield* openaiChat(params, this.config.url.replace(/\/$/, '') + '/chat/completions', {Authorization: 'Bearer ' + this.apiPassword});
    else {
      if (!this.config.apiSecret) throw new Error('Configure Spark credentials first');
      yield* sparkChat(params, this.config);
    }
  }
  listModels(): ModelDefinition[] {
    return [
      { id: 'spark-4.0-ultra', name: '星火 4.0 Ultra', provider: 'spark', maxTokens: 16384, supportsStreaming: true, supportsTools: !!this.apiPassword, region: 'china' },
    ];
  }
}
