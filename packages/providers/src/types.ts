export interface ModelDefinition {
  id: string;
  name: string;
  provider: string;
  maxTokens?: number;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  region: 'international' | 'china' | 'both';
}

export type { ChatParams, ChatChunk } from '@skyalyticwing/sdk';
