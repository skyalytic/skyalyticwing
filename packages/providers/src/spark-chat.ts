import { createHmac } from 'node:crypto';
import type { ChatChunk, ChatParams } from './types.js';
import { requestSignal } from './http-chat.js';

export async function* sparkChat(params: ChatParams, config: {url: string; appId: string; apiKey: string; apiSecret: string; domain: string}): AsyncGenerator<ChatChunk> {
  if (params.tools?.length) throw new Error('Spark WebSocket does not support function calls; configure apiPassword for the HTTP API');
  if (params.messages.some(m => typeof m.content !== 'string' || m.role === 'tool' || m.toolCalls?.length)) throw new Error('Spark WebSocket supports text messages only; use the HTTP API for tools and images');
  const url = new URL(config.url), date = new Date().toUTCString();
  const signature = createHmac('sha256', config.apiSecret).update(`host: ${url.host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`).digest('base64');
  url.searchParams.set('authorization', Buffer.from(`api_key="${config.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`).toString('base64'));
  url.searchParams.set('date', date); url.searchParams.set('host', url.host);
  const signal = requestSignal(params); signal.throwIfAborted();
  const socket = new WebSocket(url), queue: string[] = [];
  let wake: (() => void) | undefined, finished = false, failure: Error | undefined;
  const notify = () => { wake?.(); wake = undefined; };
  const abort = () => { failure = new Error('Spark request cancelled or timed out'); notify(); socket.close(); };
  signal.addEventListener('abort', abort, {once: true});
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    header: {app_id: config.appId}, parameter: {chat: {domain: config.domain, max_tokens: params.maxTokens ?? 4096, temperature: params.temperature ?? 0.5}}, payload: {message: {text: params.messages}},
  })));
  socket.addEventListener('message', event => {
    try {
      const data = JSON.parse(String(event.data)) as {header?: {code?: number}; payload?: {choices?: {status?: number; text?: Array<{content?: string}>}}};
      if (data.header?.code) throw new Error(`Spark API error (${data.header.code})`);
      for (const part of data.payload?.choices?.text || []) if (part.content) queue.push(part.content);
      if (data.payload?.choices?.status === 2) finished = true;
    } catch (error) { failure = error instanceof Error ? error : new Error('Invalid Spark response'); }
    notify();
  });
  socket.addEventListener('error', () => { failure = new Error('Spark connection failed'); notify(); });
  socket.addEventListener('close', () => { if (!finished) failure ||= new Error('Spark connection ended before completion'); notify(); });
  try {
    while (true) {
      if (failure) throw failure;
      if (queue.length) { yield {type: 'content', content: queue.shift()!}; continue; }
      if (finished) break;
      await new Promise<void>(resolve => { wake = resolve; });
    }
    yield {type: 'done'};
  } finally { signal.removeEventListener('abort', abort); socket.close(); }
}
