import type { z } from 'zod';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  type: PluginType;
  entry: string;
  baseDir?: string;
  dependencies?: Record<string, string>;
  config?: Record<string, unknown>;
}

export type PluginType =
  | 'channel' | 'provider' | 'tool' | 'tts' | 'stt'
  | 'image-generation' | 'video-generation' | 'music-generation'
  | 'realtime-voice' | 'realtime-transcription'
  | 'model-catalog' | 'memory' | 'hook' | 'command';

export interface ChannelPluginApi {
  id: string;
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(peerId: string, content: string): Promise<void>;
  // onMessage 返回取消订阅函数，与 BaseChannel 实现一致。
  // 调用方可在不再需要消息通知时调用返回的函数移除已注册的处理器，避免处理器泄漏。
  onMessage(handler: (message: ChannelMessage) => void | Promise<void>): () => void;
  // 在接口中定义 configure(config)，使所有渠道实现统一的多态配置入口。
  // 各渠道子类按自身 config 形状实现此方法（运行时仍由子类自行校验字段）。
  // 基类 BaseChannel 提供默认空实现，子类按需重写。
  configure(config: unknown): void;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  peerId: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderPluginApi {
  id: string;
  name: string;
  region: 'international' | 'china' | 'both';
  chat(params: ChatParams): AsyncGenerator<ChatChunk>;
  listModels(): ModelInfo[];
  configure(config: Record<string, unknown>): void;
}

export interface ChatParams {
  messages: Array<{ role: string; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>; toolCallId?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> }>;
  signal?: AbortSignal;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ProviderToolDefinition[];
}

export type ChatChunk =
  | { type: 'content'; content: string }
  | { type: 'tool_call'; toolCall: { id: string; name: string; input: Record<string, unknown> } }
  | { type: 'done' };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  maxTokens?: number;
  supportsStreaming?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  region: 'international' | 'china' | 'both';
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType<unknown>;
}

export interface ToolResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface TTSPluginApi {
  id: string;
  name: string;
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
}

export interface TTSOptions {
  voice?: string;
  speed?: number;
  pitch?: number;
  format?: 'mp3' | 'wav' | 'pcm';
}

export interface TTSResult {
  audio: Buffer;
  format: string;
  duration?: number;
}

export interface STTPluginApi {
  id: string;
  name: string;
  recognize(audio: Buffer, options?: STTOptions): Promise<STTResult>;
}

export interface STTOptions {
  language?: string;
  format?: 'wav' | 'mp3' | 'pcm';
}

export interface STTResult {
  text: string;
  confidence?: number;
  language?: string;
}
