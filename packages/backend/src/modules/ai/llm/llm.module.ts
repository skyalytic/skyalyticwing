import { Module } from '@nestjs/common';
import { LLMClientService } from './llm-client.service.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { ProviderService } from './provider.service.js';
import { ProviderController } from './provider.controller.js';

/**
 * LlmModule - LLM 调用层模块
 *
 * 提供 LLMClientService（统一 LLM 客户端）及 OpenAI/Anthropic 适配器。
 * Chat / Agent 等业务模块通过导入本模块使用 LLMClientService。
 *
 * 同时提供 ProviderController / ProviderService，承担 /api/providers 与 /api/models
 * 供应商与模型管理 REST API；ProviderService 亦导出供 ConfigModule 实现
 * /api/config/test-provider 端点。
 */
@Module({
  providers: [LLMClientService, OpenAIAdapter, AnthropicAdapter, ProviderService],
  controllers: [ProviderController],
  exports: [LLMClientService, ProviderService],
})
export class LlmModule {}
