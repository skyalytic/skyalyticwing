import { createHash, createHmac } from 'node:crypto';
import type { ChatParams, ChatChunk } from './types.js';
import { post, requestSignal, schema } from './http-chat.js';

export interface BedrockConfig { region: string; accessKeyId: string; secretAccessKey: string; sessionToken: string; apiKey: string; }
export function signBedrock(url: URL, body: string, config: BedrockConfig, now = new Date()): Record<string, string> {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = stamp.slice(0, 8);
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();
  const headers: Record<string, string> = { 'content-type': 'application/json', host: url.host, 'x-amz-date': stamp };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;
  const keys = Object.keys(headers).sort(), signed = keys.join(';');
  const canonicalPath = url.pathname.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  const canonical = ['POST', canonicalPath, '', keys.map(k => k + ':' + headers[k] + '\n').join(''), signed, hash(body)].join('\n');
  const scope = `${day}/${config.region}/bedrock/aws4_request`;
  const key = hmac(hmac(hmac(hmac('AWS4' + config.secretAccessKey, day), config.region), 'bedrock'), 'aws4_request');
  const signature = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', stamp, scope, hash(canonical)].join('\n')).digest('hex');
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
export async function* bedrockChat(params: ChatParams, config: BedrockConfig): AsyncGenerator<ChatChunk> {
  if (!params.model) throw new Error('Configure an AWS model ID or inference profile ID');
  if (!config.apiKey && (!config.accessKeyId || !config.secretAccessKey)) throw new Error('Configure Bedrock API key or AWS access credentials');
  const system: Array<{text: string}> = [], messages: Array<{role: string; content: unknown[]}> = [];
  for (const m of params.messages) {
    if (m.role === 'system') { system.push({text: typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')}); continue; }
    const content: unknown[] = [];
    if (m.role === 'tool') {
      if (!m.toolCallId) throw new Error('Tool result is missing toolCallId');
      content.push({ toolResult: { toolUseId: m.toolCallId, content: [{text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}] } });
    } else {
      for (const part of typeof m.content === 'string' ? [{type: 'text' as const, text: m.content}] : m.content) {
        if (part.type === 'text') { if (part.text) content.push({text: part.text}); }
        else {
          const image = /^data:image\/(png|jpeg|gif|webp);base64,(.+)$/.exec(part.image_url.url);
          if (!image) throw new Error('Bedrock images require inline base64 image data');
          content.push({image: {format: image[1], source: {bytes: image[2]}}});
        }
      }
      for (const t of m.toolCalls || []) content.push({toolUse: {toolUseId: t.id, name: t.name, input: t.input}});
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
    else messages.push({role, content});
  }
  const suffix = config.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const url = new URL(`https://bedrock-runtime.${config.region}.${suffix}/model/${encodeURIComponent(params.model)}/converse`);
  const body = {messages, ...(system.length ? {system} : {}), inferenceConfig: {
    maxTokens: params.maxTokens ?? 4096, ...(params.temperature === undefined ? {} : {temperature: params.temperature}),
  }, ...(params.tools?.length ? {toolConfig: {tools: params.tools.map(t => ({toolSpec: {name: t.name, description: t.description, inputSchema: {json: schema(t.parameters)}}}))}} : {})};
  const headers = config.apiKey ? {Authorization: 'Bearer ' + config.apiKey} : signBedrock(url, JSON.stringify(body), config);
  const response = await post(url.href, headers, body, requestSignal(params));
  const data = await response.json() as {stopReason?: string; output?: {message?: {content?: Array<{text?: string; toolUse?: {toolUseId: string; name: string; input: Record<string, unknown>}}>}}};
  if (!['end_turn', 'tool_use', 'stop_sequence'].includes(data.stopReason || '') || !data.output?.message?.content) throw new Error('Bedrock did not complete the response');
  for (const block of data.output.message.content) {
    if (block.text) yield {type: 'content', content: block.text};
    if (block.toolUse) yield {type: 'tool_call', toolCall: {id: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input}};
  }
  yield {type: 'done'};
}
