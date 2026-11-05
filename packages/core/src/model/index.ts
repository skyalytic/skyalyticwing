import type { ModelConfig } from '../types/index.js';
import { createLogger, type Logger } from '@skyalyticwing/shared';

export interface ChatParams {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: unknown[];
}

export interface ChatChunk {
  type: 'content' | 'tool_call' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; input: Record<string, unknown> };
}

export abstract class BaseModelProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly region: 'international' | 'china' | 'both';

  protected logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'provider' });
  }

  abstract chat(params: ChatParams): AsyncGenerator<ChatChunk>;
  abstract listModels(): ModelConfig[];
}

export class ModelRegistry {
  private providers: Map<string, BaseModelProvider> = new Map();
  private logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'model-registry' });
  }

  register(provider: BaseModelProvider): void {
    this.providers.set(provider.id, provider);
    this.logger.info({ provider: provider.id, region: provider.region }, 'Provider registered');
  }

  get(providerId: string): BaseModelProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): BaseModelProvider[] {
    return Array.from(this.providers.values());
  }

  listModels(): ModelConfig[] {
    return this.list().flatMap(p => p.listModels());
  }
}
