import type { ChatChunk, ChatParams, LlmMessage, ProviderConfig } from '../types.js';
import { parseSse } from './stream-parser.js';

type Item = Record<string, any>;
export function responsesInput(messages: LlmMessage[], provider: string, model: string): Item[] {
  return messages.flatMap((message) => {
    if (message.role === 'tool')
      return [
        {
          type: 'function_call_output',
          call_id: message.toolCallId,
          output:
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        },
      ];
    const state = message.responseState;
    if (message.role === 'assistant' && state?.provider === provider && state.model === model)
      return state.items;
    const items: Item[] = [];
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) =>
            part.type === 'text'
              ? {
                  type: message.role === 'assistant' ? 'output_text' : 'input_text',
                  text: part.text,
                }
              : {
                  type: 'input_image',
                  image_url: part.image_url.url,
                  detail: part.image_url.detail ?? 'auto',
                },
          );
    if (content.length) items.push({ role: message.role, content });
    for (const call of message.toolCalls ?? [])
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    return items;
  });
}

/** Complete and validate a whole response before releasing any side-effecting tool call. */
export async function* chatResponses(
  params: ChatParams,
  config: ProviderConfig,
): AsyncGenerator<ChatChunk> {
  const body: Item = {
    model: params.model,
    input: responsesInput(params.messages, config.id, params.model),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  };
  if (params.maxTokens !== undefined) body['max_output_tokens'] = params.maxTokens;
  if (params.temperature !== undefined && !/^(gpt-[56]|o[134])/.test(params.model))
    body['temperature'] = params.temperature;
  if (params.tools?.length)
    body['tools'] = params.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([controller.signal, params.signal])
    : controller.signal;
  let timer = setTimeout(() => controller.abort(), 130000);
  try {
    const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/responses', {
      method: 'POST',
      headers: {
        ...config.headers,
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    if (!response.ok)
      throw Error(
        'Responses API ' + response.status + ': ' + (await response.text()).slice(0, 4000),
      );
    if (!response.body) throw Error('Responses API returned no body');
    let completed: Item | undefined;
    const seen = new Set<number>();
    const emitted = new Map<string, string>();
    for await (const { data } of parseSse(response.body)) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 130000);
      if (!data || data === '[DONE]') continue;
      const event: Item = JSON.parse(data);
      if (typeof event['sequence_number'] === 'number') {
        if (seen.has(event['sequence_number'])) continue;
        seen.add(event['sequence_number']);
      }
      if (['error', 'response.failed', 'response.incomplete'].includes(event['type'])) {
        throw Error(
          event['message'] ||
            event['error']?.message ||
            event['response']?.error?.message ||
            event['type'],
        );
      }
      if (
        ['response.output_text.delta', 'response.refusal.delta'].includes(event['type']) &&
        typeof event['delta'] === 'string'
      ) {
        const key = String(event['item_id']) + ':' + (event['content_index'] ?? 0);
        emitted.set(key, (emitted.get(key) || '') + event['delta']);
        yield { type: 'content', content: event['delta'] };
      }
      if (event['type'] === 'response.completed') {
        completed = event['response'];
        break;
      }
    }
    if (signal.aborted) throw Error('Request cancelled');
    if (!completed || completed['status'] !== 'completed' || !Array.isArray(completed['output'])) {
      throw Error('Responses stream ended without completion; tools were not executed');
    }
    const output: Item[] = completed['output'];
    const calls = output.filter((item) => item['type'] === 'function_call');
    const ids = new Set<string>();
    for (const call of calls) {
      const args: unknown = JSON.parse(call['arguments']);
      if (
        typeof call['call_id'] !== 'string' ||
        !call['call_id'] ||
        typeof call['name'] !== 'string' ||
        !call['name'] ||
        ids.has(call['call_id']) ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args)
      )
        throw Error('Invalid or duplicate tool call');
      ids.add(call['call_id']);
    }
    for (const item of output)
      if (item['type'] === 'message') {
        for (const [index, part] of (item['content'] ?? []).entries()) {
          const text: string = part.text ?? part.refusal ?? '';
          const previous = emitted.get(String(item['id']) + ':' + index) || '';
          if (text.startsWith(previous) && text.length > previous.length)
            yield { type: 'content', content: text.slice(previous.length) };
        }
      }
    for (const call of calls)
      yield {
        type: 'tool_call',
        toolCall: { id: call['call_id'], name: call['name'], arguments: call['arguments'] },
      };
    const usage = completed['usage'];
    yield {
      type: 'done',
      finishReason: calls.length ? 'tool_calls' : 'stop',
      responseState: { provider: config.id, model: params.model, items: output },
      ...(usage
        ? {
            usage: {
              promptTokens: usage.input_tokens ?? 0,
              completionTokens: usage.output_tokens ?? 0,
              totalTokens:
                usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            },
          }
        : {}),
    };
  } catch (error) {
    yield {
      type: 'error',
      error: signal.aborted
        ? params.signal?.aborted
          ? 'Request cancelled'
          : 'Responses API timeout'
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
