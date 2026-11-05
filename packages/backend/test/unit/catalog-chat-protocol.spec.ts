import 'reflect-metadata';
import { OpenAIAdapter } from '../../src/modules/ai/llm/openai-adapter.js';
import { PROVIDERS_REGISTRY } from '../../src/modules/ai/llm/provider-catalog.js';

describe('catalog chat protocol compatibility', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    ['https://api.openai.com/v1', 'gpt-5.4', 'max_completion_tokens', false],
    ['https://api.openai.com/v1', 'gpt-4o', 'max_tokens', true],
    ['https://gateway.example/v1', 'gpt-5.4', 'max_tokens', true],
    ['https://api.moonshot.cn/v1', 'kimi-k3.1-pro', 'max_completion_tokens', false],
    ['https://api.moonshot.cn/v1', 'kimi-k3.1-pro-highspeed', 'max_completion_tokens', false],
    ['https://gateway.example/v1', 'kimi-k3.1-pro', 'max_tokens', true],
    ['https://api.minimax.cn/v1', 'MiniMax-M3.1-Flash', 'max_completion_tokens', false],
    ['https://api.minimax.io/v1', 'MiniMax-M3.1-Flash', 'max_completion_tokens', false],
    ['https://gateway.example/v1', 'MiniMax-M3.1-Flash', 'max_tokens', true],
  ] as const)('uses the correct output budget for %s / %s', async (baseUrl, model, tokenField, sampling) => {
    const mocked = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    const result = [];
    for await (const chunk of new OpenAIAdapter().chat({ model, messages: [{ role: 'user', content: 'fixture' }], maxTokens: 8192, temperature: 0.7 }, { id: 'fixture', type: 'openai', baseUrl, apiKey: 'fixture-only' })) result.push(chunk);
    const body = JSON.parse(mocked.mock.calls[0]?.[1]?.body as string);
    expect(body[tokenField]).toBe(8192);
    expect(body.temperature).toBe(sampling ? 0.7 : undefined);
    expect(body.reasoning_split).toBe(baseUrl.startsWith('https://api.minimax.') ? true : undefined);
    expect(result.at(-1)?.type).toBe('done');
  });
  it('does not pretend Responses-only tool calling works through native Chat Completions', () => {
    const p = PROVIDERS_REGISTRY.find(p => p.id === 'openai')!;
    expect(p.models.some(id => id.startsWith('gpt-6'))).toBe(false);
    expect(p.catalog?.references?.some(m => m.id === 'gpt-6.1-sol')).toBe(true);
  });
  it.each([
    ['moonshot', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro'],
    ['minimax', 'https://api.minimax.cn/v1', 'MiniMax-M3.1-Flash'],
  ])('retains %s reasoning separately and replays it with assistant tool calls', async (id, baseUrl, model) => {
    const response = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(
      { choices: [{ delta: { reasoning_content: 'step one ' } }] },
      { choices: [{ delta: { reasoning_content: 'step two', tool_calls: [{index: 0, id: 'call1', function: {name: 'read', arguments: '{}'}}] }, finish_reason: 'tool_calls' }] },
    )).mockResolvedValueOnce(response({choices: [{delta: {content: 'answer'}, finish_reason: 'stop'}]}));
    const adapter = new OpenAIAdapter();
    const config = {id, type: 'openai' as const, baseUrl, apiKey: 'fixture-only'};
    const chunks = [];
    for await (const chunk of adapter.chat({model, messages: [{role: 'user', content: 'read'}]}, config)) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({type: 'done', reasoningContent: 'step one step two'});
    expect(chunks.some(c => c.type === 'content')).toBe(false);
    for await (const _ of adapter.chat({model, messages: [
      {role: 'assistant', content: '', reasoningContent: chunks.at(-1)?.reasoningContent, toolCalls: [{id: 'call1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
      {role: 'tool', content: 'file', toolCallId: 'call1'},
    ]}, config)) { /* consume */ }
    const body = JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string);
    expect(body.messages[0]).toMatchObject({reasoning_content: 'step one step two', tool_calls: [{id: 'call1'}]});
    expect(body.messages[1]).toEqual({role: 'tool', content: 'file', tool_call_id: 'call1'});
  });
});
