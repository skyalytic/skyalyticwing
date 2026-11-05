import { bedrockChat } from '../bedrock-chat.js';
import { BaseProvider } from '../base-provider.js';
import type { ChatParams, ChatChunk, ModelDefinition } from '../types.js';

export class BedrockProvider extends BaseProvider {
  readonly id = 'bedrock';
  readonly name = 'AWS Bedrock';
  readonly region = 'international';

  private accessKeyId = '';
  private secretAccessKey = '';
  private awsRegion = 'us-east-1';
  private sessionToken = '';
  private apiKey = '';

  configure(config: Record<string, unknown>): void {
    const c = config as {accessKeyId?: string; secretAccessKey?: string; awsRegion?: string; sessionToken?: string; apiKey?: string};
    this.apiKey = typeof c.apiKey === 'string' ? c.apiKey : '';
    this.accessKeyId = this.apiKey ? '' : this._requireString(c.accessKeyId, 'accessKeyId');
    this.secretAccessKey = this.apiKey ? '' : this._requireString(c.secretAccessKey, 'secretAccessKey');
    this.sessionToken = typeof c.sessionToken === 'string' ? c.sessionToken : '';
    this.awsRegion = c.awsRegion || 'us-east-1';
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(this.awsRegion)) throw new Error('Invalid AWS region');
  }
  async *chat(params: ChatParams): AsyncGenerator<ChatChunk> {
    yield* bedrockChat(params, {region: this.awsRegion, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, sessionToken: this.sessionToken, apiKey: this.apiKey});
  }
  listModels(): ModelDefinition[] {
    return [{ id: 'us.anthropic.claude-sonnet-4-6', name: 'Bedrock Claude Sonnet 4', provider: 'bedrock', maxTokens: 8192, supportsStreaming: false, supportsTools: true, region: 'international' }];
  }
}
