import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatChunk, ChatParams } from './types.js';

export function schema(parameters: NonNullable<ChatParams['tools']>[number]['parameters']) {
  return zodToJsonSchema(parameters, { $refStrategy: 'none' });
}
export function messages(params: ChatParams) {
  return params.messages.map(m => ({ role: m.role, content: m.content,
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls ? { tool_calls: m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}),
  }));
}
export function requestSignal(params: ChatParams) {
  const timeout = AbortSignal.timeout(120_000);
  return params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
}
export async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider request failed (HTTP ${response.status})`); }
  return response;
}
export async function* sse(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('Provider response has no body');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', lines: string[] = [], eventSize = 0;
  const limit = 4 * 1024 * 1024;
  const append = (line: string) => {
    eventSize += line.length + 1;
    if (eventSize > limit) throw new Error('Provider stream frame too large');
    lines.push(line);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (line.length > limit) throw new Error('Provider stream frame too large');
        if (!line) { if (lines.length) yield lines.join('\n'); lines = []; eventSize = 0; }
        else if (line.startsWith('data:')) append(line.slice(5).replace(/^ /, ''));
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Provider stream frame too large');
      if (done) { if (buffer.startsWith('data:')) append(buffer.slice(5).trimStart()); if (lines.length) yield lines.join('\n'); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
interface Completion {
  error?: unknown;
  choices?: Array<{ finish_reason?: string | null; delta?: { content?: string; tool_calls?: Array<{index?: number; id?: string; function?: {name?: string; arguments?: string}}> } }>;
}
export async function* openaiChat(params: ChatParams, url: string, headers: Record<string, string>): AsyncGenerator<ChatChunk> {
  if (!params.model?.trim()) throw new Error('Configure a model ID before calling chat');
  const nativeReasoning = new URL(url).hostname === 'api.openai.com' && /^(gpt-[56]|o[134])/.test(params.model);
  const body = { model: params.model, messages: messages(params), stream: true,
    ...(params.maxTokens === undefined ? {} : { [nativeReasoning ? 'max_completion_tokens' : 'max_tokens']: params.maxTokens }),
    ...(params.temperature === undefined || nativeReasoning ? {} : { temperature: params.temperature }),
    ...(params.tools?.length ? { tools: params.tools.map(t => ({ type: 'function', function: {name: t.name, description: t.description, parameters: schema(t.parameters)} })) } : {}),
  };
  const response = await post(url, headers, body, requestSignal(params));
  const tools = new Map<number, {id: string; name: string; args: string}>();
  let finished = false;
  for await (const data of sse(response)) {
    if (data === '[DONE]') { finished = true; break; }
    const event = JSON.parse(data) as Completion;
    if (event.error) throw new Error('Provider reported a stream error');
    const choice = event.choices?.[0];
    if (choice?.delta?.content) yield { type: 'content', content: choice.delta.content };
    for (const part of choice?.delta?.tool_calls || []) {
      const index = part.index ?? 0, tool = tools.get(index) || { id: '', name: '', args: '' };
      if (part.id) tool.id = part.id;
      if (part.function?.name) tool.name += part.function.name;
      tool.args += part.function?.arguments || ''; tools.set(index, tool);
    }
    if (choice?.finish_reason) {
      if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) throw new Error(`Provider stopped before completion: ${choice.finish_reason}`);
      finished = true;
    }
  }
  if (!finished) throw new Error('Provider stream ended before completion');
  for (const [, tool] of [...tools].sort(([a], [b]) => a - b)) {
    const input: unknown = JSON.parse(tool.args || '{}');
    if (!tool.id || !tool.name || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid provider tool call');
    yield { type: 'tool_call', toolCall: { id: tool.id, name: tool.name, input: input as Record<string, unknown> } };
  }
  yield { type: 'done' };
}
