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

/** 30s 请求超时（安全约束） */
const REQUEST_TIMEOUT_MS = 30_000;
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic 强制要求 max_tokens，未提供时默认值 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * AnthropicAdapter - Anthropic Messages API 适配器
 *
 * - 端点：${baseUrl}/messages
 * - 请求头：x-api-key: ${apiKey}, anthropic-version: 2023-06-01, Content-Type: application/json
 * - system 角色消息提取到顶层 system 字段（Anthropic 不允许 messages 中出现 system）
 * - tool 角色消息转换为 user + tool_result content block
 * - assistant 工具调用转换为 assistant + tool_use content block
 * - user 多模态 content 数组映射为 Anthropic text/image content block
 * - 解析 SSE 事件：content_block_delta / message_delta / message_stop 等
 * - 30s 超时（AbortController）
 */
@Injectable()
export class AnthropicAdapter {
  async *chat(params: ChatParams, config: ProviderConfig): AsyncGenerator<ChatChunk> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/messages`;

    const payload = toAnthropicPayload(params.messages, params);
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: payload.maxTokens,
      messages: payload.messages,
      stream: true,
    };
    if (payload.system) body['system'] = payload.system;
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.tools && params.tools.length > 0) {
      body['tools'] = params.tools.map(toAnthropicTool);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: params.signal ? AbortSignal.any([controller.signal, params.signal]) : controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        yield { type: 'error', error: `Anthropic API ${res.status}: ${text}` };
        return;
      }
      if (!res.body) {
        yield { type: 'error', error: 'Anthropic API returned no body' };
        return;
      }

      const toolBuffers = new Map<number, { id: string; name: string; inputJson: string }>();
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;
      let streamDone = false;

      for await (const { event, data } of parseSse(res.body)) {
        if (!data) continue;
        let json: {type?: string; error?: unknown; index?: number; message?: {usage?: {input_tokens?: number}}; content_block?: {type?: string; id?: string; name?: string}; delta?: {type?: string; text?: string; partial_json?: string; stop_reason?: string}; usage?: {output_tokens?: number}};
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const evt = event ?? json?.type;
        if (evt === 'error' || json?.error) {
          yield {type:'error',error:'Anthropic 模型返回流错误，请重试'};
          return;
        }

        if (evt === 'message_start') {
          const u = json?.message?.usage;
          if (u && typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
        } else if (evt === 'content_block_start') {
          const cb = json?.content_block;
          if (cb && cb.type === 'tool_use') {
            const idx = typeof json.index === 'number' ? json.index : toolBuffers.size;
            toolBuffers.set(idx, { id: cb.id ?? '', name: cb.name ?? '', inputJson: '' });
          }
        } else if (evt === 'content_block_delta') {
          const delta = json?.delta;
          if (delta) {
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'content', content: delta.text };
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              const idx = typeof json.index === 'number' ? json.index : 0;
              const buf = toolBuffers.get(idx);
              if (buf) buf.inputJson += delta.partial_json;
            }
          }
        } else if (evt === 'message_delta') {
          const d = json?.delta;
          if (d && typeof d.stop_reason === 'string' && d.stop_reason) {
            stopReason = d.stop_reason;
          }
          const u = json?.usage;
          if (u && typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
        } else if (evt === 'message_stop') {
          streamDone = true;
          break;
        }
      }
      if (!streamDone) { yield {type:'error',error:'Anthropic 模型连接中断，未收到完成标记'}; return; }
      if (toolBuffers.size && stopReason === 'max_tokens') { yield {type:'error',error:'模型工具调用被截断，未执行不完整的操作'}; return; }
      for (const buf of toolBuffers.values()) {
        try {
          const args: unknown = JSON.parse(buf.inputJson || '{}');
          if (!buf.id || !buf.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool');
        } catch { yield {type:'error',error:'模型返回了不完整或无效的工具调用'}; return; }
      }

      // 派发累积的完整工具调用
      const indices = Array.from(toolBuffers.keys()).sort((a, b) => a - b);
      for (const idx of indices) {
        const buf = toolBuffers.get(idx);
        if (buf) {
          yield {
            type: 'tool_call',
            toolCall: { id: buf.id, name: buf.name, arguments: buf.inputJson || '{}' },
          };
        }
      }

      const usage: TokenUsage | undefined =
        inputTokens > 0 || outputTokens > 0
          ? {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
            }
          : undefined;
      const done: ChatChunk = { type: 'done' };
      if (stopReason) done.finishReason = stopReason;
      if (usage) done.usage = usage;
      yield done;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        yield { type: 'error', error: params.signal?.aborted ? 'Request cancelled' : `Anthropic API request timeout (${REQUEST_TIMEOUT_MS}ms)` };
      } else {
        yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
/**
 * 将 content 降级为字符串（字符串原样返回；数组降级为 JSON 字符串，
 * 用于 system/assistant/tool 等不支持多模态 block 的消息，保持纯字符串行为不变）。
 */
function contentToString(content: string | LlmContentPart[]): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * 将 user 多模态 content 数组映射为 Anthropic Messages API content block：
 *   - text part → { type: 'text', text }
 *   - image_url part（data:image/xxx;base64,yyy）→
 *     { type: 'image', source: { type: 'base64', media_type: xxx, data: yyy } }
 *   - 无法解析的图片 URL 降级为文本占位
 */
function toAnthropicUserContent(parts: LlmContentPart[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(part.image_url.url);
    if (match) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      });
    } else {
      blocks.push({ type: 'text', text: '[图片附件 URL 格式不受支持，无法内联]' });
    }
  }
  return blocks;
}

/** 将 LlmMessage[] 转换为 Anthropic Messages API 的 messages + system */
function toAnthropicPayload(
  messages: LlmMessage[],
  params: ChatParams,
): { system?: string; messages: unknown[]; maxTokens: number } {
  const systemParts: string[] = [];
  const out: unknown[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const text = contentToString(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === 'tool') {
      // Anthropic 工具结果以 user + tool_result content block 表达
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: contentToString(m.content) },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: unknown[] = [];
      const text = contentToString(m.content);
      if (text) content.push({ type: 'text', text });
      for (const tc of m.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    // user 多模态 content 数组 → Anthropic text/image content block
    if (m.role === 'user' && Array.isArray(m.content)) {
      out.push({ role: 'user', content: toAnthropicUserContent(m.content) });
      continue;
    }
    out.push({ role: m.role, content: contentToString(m.content) });
  }

  const result: { system?: string; messages: unknown[]; maxTokens: number } = {
    messages: out,
    maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) result.system = systemParts.join('\n\n');
  return result;
}

/** 将 LlmToolDefinition 映射为 Anthropic tools 项 */
function toAnthropicTool(t: LlmToolDefinition): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
