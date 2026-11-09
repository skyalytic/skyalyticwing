import 'reflect-metadata';
import { OpenAIAdapter } from '../../src/modules/ai/llm/openai-adapter.js';
import { responsesInput } from '../../src/modules/ai/llm/responses-adapter.js';
import { TurnCoordinator } from '../../src/modules/ai/chat/turn-coordinator.js';
import { ProgressGuard } from '../../src/modules/ai/agent/progress-guard.js';
import { microcompactContext } from '../../src/modules/ai/agent/context-compaction.js';
import type { AgentLoopEvent, LlmMessage } from '../../src/modules/ai/types.js';
import { randomUUID } from 'node:crypto';
const config = {
  id: 'fixture',
  type: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-only',
};
const call = { type: 'function_call', name: 'read', call_id: 'c1', arguments: '{}' };
const response = (...events: unknown[]) =>
  new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
const complete = (output: unknown[]) => ({
  type: 'response.completed',
  response: { status: 'completed', output, usage: { input_tokens: 2, output_tokens: 3 } },
});
async function collect<T>(source: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
describe('Responses protocol and task safety', () => {
  afterEach(() => jest.restoreAllMocks());
  it('surfaces a nested API error without dispatching tools', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        response({
          type: 'error',
          error: { message: 'Account quota exceeded', code: 'insufficient_quota' },
        }),
      );
    const chunks = await collect(
      new OpenAIAdapter().chat({ model: 'gpt-5.4', messages: [] }, config),
    );
    expect(chunks.at(-1)).toMatchObject({ type: 'error', error: 'Account quota exceeded' });
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(false);
  });
  it('routes native models and only dispatches validated completed calls', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        response(
          {
            type: 'response.output_text.delta',
            item_id: 'm',
            content_index: 0,
            sequence_number: 1,
            delta: 'ok',
          },
          {
            type: 'response.output_text.delta',
            item_id: 'm',
            content_index: 0,
            sequence_number: 1,
            delta: 'ok',
          },
          complete([
            { type: 'reasoning', encrypted_content: 'opaque' },
            {
              type: 'message',
              id: 'm',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
            call,
          ]),
        ),
      );
    const chunks = await collect(
      new OpenAIAdapter().chat(
        { model: 'gpt-5.4', messages: [{ role: 'user', content: 'read' }] },
        config,
      ),
    );
    expect(fetcher.mock.calls[0][0]).toBe(config.baseUrl + '/responses');
    expect(
      chunks
        .filter((c) => c.type === 'content')
        .map((c) => c.content)
        .join(''),
    ).toBe('ok');
    expect(chunks.filter((c) => c.type === 'tool_call')).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      usage: { totalTokens: 5 },
      responseState: { provider: 'fixture', model: 'gpt-5.4' },
    });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
    });
  });
  it.each([
    [{ type: 'response.output_item.done', item: call }],
    [complete([call, { ...call, call_id: 'c2', arguments: 'broken' }])],
    [complete([call, call])],
    [{ type: 'response.incomplete', response: { status: 'incomplete' } }],
  ])('never partially executes incomplete or malformed responses', async (events) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(events));
    const chunks = await collect(
      new OpenAIAdapter().chat({ model: 'gpt-5.4', messages: [] }, config),
    );
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(false);
    expect(chunks.at(-1)?.type).toBe('error');
  });
  it('replays opaque state only to its originating provider and model', () => {
    const messages: LlmMessage[] = [
      {
        role: 'assistant',
        content: 'ok',
        responseState: { provider: 'fixture', model: 'gpt-5.4', items: [call] },
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', content: 'file', toolCallId: 'c1' },
    ];
    expect(responsesInput(messages, 'fixture', 'gpt-5.4')[0]).toEqual(call);
    expect(responsesInput(messages, 'other', 'gpt-5.4')[0]).toEqual({
      role: 'assistant',
      content: 'ok',
    });
    expect(responsesInput(messages, 'fixture', 'gpt-4o')[1]).toEqual(call);
  });
  it('deduplicates concurrent subscriptions and durable retries without repeating actions', async () => {
    const coordinator = new TurnCoordinator(),
      id = randomUUID();
    let count = 0;
    async function* producer(): AsyncGenerator<AgentLoopEvent> {
      count++;
      await new Promise((r) => setTimeout(r, 10));
      yield { type: 'done' };
    }
    await Promise.all([
      collect(coordinator.run('test', 's', id, {}, producer)),
      collect(coordinator.run('test', 's', id, {}, producer)),
    ]);
    await collect(new TurnCoordinator().run('test', 's', id, {}, producer));
    expect(count).toBe(1);
    await expect(
      collect(coordinator.run('test', 's', id, { different: 1 }, producer)),
    ).rejects.toThrow('another request');
  });
  it('does not rerun an uncertain crashed turn', async () => {
    const id = randomUUID();
    let count = 0;
    async function* producer(): AsyncGenerator<AgentLoopEvent> {
      count++;
      throw Error('uncertain');
    }
    expect(
      (await collect(new TurnCoordinator().run('test', 's', id, {}, producer)))[0],
    ).toMatchObject({ type: 'error' });
    await expect(collect(new TurnCoordinator().run('test', 's', id, {}, producer))).rejects.toThrow(
      'interrupted',
    );
    expect(count).toBe(1);
  });
  it('continues a turn when a subscriber disconnects', async () => {
    const id = randomUUID();
    let done = false;
    async function* producer(): AsyncGenerator<AgentLoopEvent> {
      yield {
        type: 'assistant_delta',
        message: { id: 'm', role: 'assistant', content: 'a', timestamp: 0 },
      };
      await new Promise((r) => setTimeout(r, 10));
      done = true;
      yield { type: 'done' };
    }
    const stream = new TurnCoordinator().run('test', 's', id, {}, producer);
    await stream.next();
    await stream.return(undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(true);
  });
  it('blocks repeated call IDs before execution and catches alternating no-progress loops', () => {
    const guard = new ProgressGuard();
    guard.before('c');
    expect(() => guard.before('c')).toThrow();
    for (let i = 0; i < 3; i++) {
      guard.after('read', { path: 'a' }, { text: 'same', timestamp: i });
      guard.after('list', {}, []);
    }
    guard.after('read', { path: 'a' }, { text: 'same', timestamp: 9 });
    expect(() => guard.after('list', {}, [])).toThrow();
    const progressing = new ProgressGuard();
    for (let i = 0; i < 10; i++) {
      progressing.after('read', { path: 'shared' }, { text: 'same' });
      progressing.after('read', { path: 'file-' + i }, { text: String(i) });
    }
  });
  it('compacts only old tool payloads without mutating original history or recent receipts', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'keep my constraints' },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: 'tool' as const,
        content: 'x'.repeat(10000),
        toolCallId: String(i),
      })),
    ];
    const next = microcompactContext(messages);
    expect(next[0]).toBe(messages[0]);
    expect(next[1].content).toContain('excerpt');
    expect(next.slice(-6)).toEqual(messages.slice(-6));
    expect(messages[1].content.length).toBe(10000);
    expect(microcompactContext(next)).toBe(next);
  });
});
