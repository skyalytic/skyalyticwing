import type { ChatParams, ChatChunk } from './types.js';
import { post, requestSignal, schema, sse } from './http-chat.js';

export function anthropicMessages(params: ChatParams) {
  const system: string[] = [], messages: Array<{role: string; content: unknown[]}> = [];
  for (const m of params.messages) {
    if (m.role === 'system') { system.push(typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')); continue; }
    const content: unknown[] = [];
    if (m.role === 'tool') {
      if (!m.toolCallId) throw new Error('Tool result is missing toolCallId');
      content.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else {
      for (const p of typeof m.content === 'string' ? [{type: 'text' as const, text: m.content}] : m.content) {
        if (p.type === 'text') { if (p.text) content.push(p); }
        else {
          const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(p.image_url.url);
          if (!match) throw new Error('Anthropic images require an inline base64 image');
          content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        }
      }
      for (const t of m.toolCalls || []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
    else messages.push({ role, content });
  }
  return { system: system.join('\n'), messages };
}
interface Event {
  type: string; index?: number; error?: unknown;
  content_block?: {type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string};
  delta?: {type?: string; text?: string; partial_json?: string; stop_reason?: string};
}
export async function* anthropicChat(params: ChatParams, url: string, key: string): AsyncGenerator<ChatChunk> {
  if (!key || !params.model) throw new Error('Configure an Anthropic API key and model ID');
  const response = await post(url, {'x-api-key': key, 'anthropic-version': '2023-06-01'}, {
    ...anthropicMessages(params), model: params.model, max_tokens: params.maxTokens ?? 4096, stream: true,
    ...(params.temperature === undefined ? {} : {temperature: params.temperature}),
    ...(params.tools?.length ? {tools: params.tools.map(t => ({name: t.name, description: t.description, input_schema: schema(t.parameters)}))} : {}),
  }, requestSignal(params));
  const tools = new Map<number, {id: string; name: string; json: string; input: Record<string, unknown>}>();
  let done = false;
  for await (const data of sse(response)) {
    const event = JSON.parse(data) as Event;
    if (event.type === 'error' || event.error) throw new Error('Anthropic stream error');
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use') tools.set(event.index ?? 0, {id: block.id || '', name: block.name || '', json: '', input: block.input || {}});
      if (block?.type === 'text' && block.text) yield {type: 'content', content: block.text};
    }
    if (event.delta?.type === 'text_delta' && event.delta.text) yield {type: 'content', content: event.delta.text};
    if (event.delta?.partial_json) {
      const tool = tools.get(event.index ?? 0); if (!tool) throw new Error('Unknown tool stream block'); tool.json += event.delta.partial_json;
    }
    if (event.delta?.stop_reason && !['end_turn', 'tool_use', 'stop_sequence'].includes(event.delta.stop_reason)) throw new Error(`Anthropic stopped before completion: ${event.delta.stop_reason}`);
    if (event.type === 'message_stop') { done = true; break; }
  }
  if (!done) throw new Error('Anthropic stream ended before completion');
  for (const tool of tools.values()) {
    const input: unknown = tool.json ? JSON.parse(tool.json) : tool.input;
    if (!tool.id || !tool.name || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Anthropic tool call');
    yield {type: 'tool_call', toolCall: {id: tool.id, name: tool.name, input: input as Record<string, unknown>}};
  }
  yield {type: 'done'};
}
