import { Injectable } from '@nestjs/common';
import type { TokenUsage } from '@skyalyticwing/shared';
import type {
  ChatChunk,
  ChatParams,
  LlmContentPart,
  LlmMessage,
  LlmToolDefinition,
  ProviderConfig,
} from '../types.js';
import { parseSse } from './stream-parser.js';
import { chatResponses } from './responses-adapter.js';

/** Default connection/stream inactivity timeout; active generation renews it. */
const REQUEST_TIMEOUT_MS = 30_000;
interface OpenAIStreamEvent {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    finish_reason?: string;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

/**
 * OpenAIAdapter - OpenAI 兼容 API 适配器
 *
 * 兼容 OpenAI / Qwen / DeepSeek / Moonshot / Zhipu / Groq / Mistral / xAI / Ollama 等
 * 所有遵循 OpenAI Chat Completions 协议的 provider。
 *
 * - 端点：${baseUrl}/chat/completions
 * - 请求头：Authorization: Bearer ${apiKey}, Content-Type: application/json
 * - 流式：stream: true，解析 `data: {...}\n\n` SSE，以 `data: [DONE]` 结束
 * - 有界连接/流空闲超时（AbortController），持续输出会续期
 * - 工具调用增量累积，在流结束时一次性派发完整 tool_call
 */
@Injectable()
export class OpenAIAdapter {
  async *chat(params: ChatParams, config: ProviderConfig): AsyncGenerator<ChatChunk> {
    if (
      config.apiFormat === 'responses' ||
      ((!config.apiFormat || config.apiFormat === 'auto') &&
        new URL(config.baseUrl).hostname === 'api.openai.com' &&
        /^(gpt-[56]|o[134])/.test(params.model))
    ) {
      yield* chatResponses(params, config);
      return;
    }
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages.map(toOpenaiMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    // OpenAI reasoning models reject legacy max_tokens and custom sampling.
    // Do not apply vendor-specific fields to unrelated compatible gateways.
    const nativeReasoning =
      config.baseUrl.startsWith('https://api.openai.com/') &&
      /^(gpt-[56]|o[134])/.test(params.model);
    const kimiReasoning =
      ['api.moonshot.cn', 'api.moonshot.ai'].includes(new URL(config.baseUrl).hostname) &&
      /^kimi-k3(?:\.|$)/.test(params.model);
    const minimaxReasoning =
      ['api.minimax.cn', 'api.minimax.io'].includes(new URL(config.baseUrl).hostname) &&
      params.model === 'MiniMax-M3.1-Flash';
    if (params.temperature !== undefined && !nativeReasoning && !kimiReasoning && !minimaxReasoning)
      body['temperature'] = params.temperature;
    if (params.maxTokens !== undefined)
      body[
        nativeReasoning || kimiReasoning || minimaxReasoning
          ? 'max_completion_tokens'
          : 'max_tokens'
      ] = params.maxTokens;
    if (minimaxReasoning) body['reasoning_split'] = true;
    if (params.tools && params.tools.length > 0) {
      body['tools'] = params.tools.map(toOpenaiTool);
    }

    const controller = new AbortController();
    const timeoutMs = kimiReasoning || minimaxReasoning ? 130000 : REQUEST_TIMEOUT_MS;
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          ...config.headers,
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: params.signal
          ? AbortSignal.any([controller.signal, params.signal])
          : controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        yield { type: 'error', error: `OpenAI API ${res.status}: ${text}` };
        return;
      }
      if (!res.body) {
        yield { type: 'error', error: 'OpenAI API returned no body' };
        return;
      }

      const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | undefined;
      let usage: TokenUsage | undefined;
      let streamDone = false;
      let reasoningContent = '';

      for await (const { data } of parseSse(res.body)) {
        // Bound inactivity, not total generation time: long reasoning may stream for minutes.
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), timeoutMs);
        if (!data) continue;
        if (data === '[DONE]') {
          streamDone = true;
          break;
        }
        let json: OpenAIStreamEvent;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json?.error) {
          yield {
            type: 'error',
            error: typeof json.error.message === 'string' ? json.error.message : '模型流中断',
          };
          return;
        }

        // usage 通常在最后一个 chunk（stream_options.include_usage）
        if (json?.usage) {
          const p = typeof json.usage.prompt_tokens === 'number' ? json.usage.prompt_tokens : 0;
          const c =
            typeof json.usage.completion_tokens === 'number' ? json.usage.completion_tokens : 0;
          usage = { promptTokens: p, completionTokens: c, totalTokens: p + c };
        }

        const choices = json?.choices;
        if (Array.isArray(choices) && choices.length > 0) {
          const choice = choices[0];
          const delta = choice?.delta;
          if (delta) {
            if (typeof delta.reasoning_content === 'string')
              reasoningContent += delta.reasoning_content;
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { type: 'content', content: delta.content };
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                let buf = toolBuffers.get(idx);
                if (!buf) {
                  buf = { id: '', name: '', args: '' };
                  toolBuffers.set(idx, buf);
                }
                if (tc.id) buf.id = tc.id;
                const fn = tc.function;
                if (fn && fn.name) buf.name = fn.name;
                if (fn && typeof fn.arguments === 'string') buf.args += fn.arguments;
              }
            }
          }
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      }

      if (!streamDone && !finishReason) {
        yield { type: 'error', error: '模型连接中断，未收到完成标记' };
        return;
      }
      if (toolBuffers.size && ['length', 'content_filter'].includes(finishReason || '')) {
        yield { type: 'error', error: '模型工具调用被截断，未执行不完整的操作' };
        return;
      }
      for (const buf of toolBuffers.values()) {
        try {
          const args: unknown = JSON.parse(buf.args);
          if (!buf.id || !buf.name || !args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('invalid tool');
        } catch {
          yield { type: 'error', error: '模型返回了不完整或无效的工具调用' };
          return;
        }
      }
      // 派发累积的完整工具调用（按 index 排序）
      const indices = Array.from(toolBuffers.keys()).sort((a, b) => a - b);
      for (const idx of indices) {
        const buf = toolBuffers.get(idx);
        if (buf) {
          yield {
            type: 'tool_call',
            toolCall: { id: buf.id, name: buf.name, arguments: buf.args },
          };
        }
      }

      const done: ChatChunk = { type: 'done' };
      if (reasoningContent) done.reasoningContent = reasoningContent;
      if (finishReason) done.finishReason = finishReason;
      if (usage) done.usage = usage;
      yield done;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        yield {
          type: 'error',
          error: params.signal?.aborted
            ? 'Request cancelled'
            : `OpenAI API request timeout (${timeoutMs}ms)`,
        };
      } else {
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
/**
 * 将多模态内容数组降级为拼接文本（assistant 工具调用消息仅接受字符串 content，
 * 数组时序列化文本部分拼接，保持纯字符串消息行为不变）。
 */
function flattenContent(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * 将 LlmMessage 映射为 OpenAI Chat Completions 消息体：
 *   - content 为字符串时原样透传（与既有行为一致）
 *   - content 为多模态数组时直接透传（OpenAI 原生 content 数组格式）
 *   - assistant 携带 toolCalls 时 content 仅为字符串或 null（数组降级为文本拼接）
 */
function toOpenaiMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: flattenContent(m.content) || null,
      ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }
  return {
    role: m.role,
    content: m.content,
    ...(m.role === 'assistant' && m.reasoningContent !== undefined
      ? { reasoning_content: m.reasoningContent }
      : {}),
  };
}

/** 将 LlmToolDefinition 映射为 OpenAI tools 项 */
function toOpenaiTool(t: LlmToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}
