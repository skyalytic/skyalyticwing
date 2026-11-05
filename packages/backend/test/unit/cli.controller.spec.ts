import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { CliController } from '../../src/modules/ai/chat/cli.controller.js';

function response() {
  const res = new EventEmitter() as any;
  res.status = jest.fn(() => res);
  res.set = jest.fn(() => res);
  res.flushHeaders = jest.fn();
  res.write = jest.fn(() => true);
  res.end = jest.fn();
  res.destroyed = false;
  return res;
}
describe('CLI harness transport', () => {
  it('passes all harness capabilities without reduced budgets and redacts secret fields', async () => {
    const run = jest.fn(async function* (_id, _message, _options) {
      yield {
        type: 'tool_call',
        toolName: 'mcp',
        args: { apiKey: 'private', path: 'x' },
        callId: '1',
      };
      yield { type: 'assistant_message', content: 'done' };
      yield { type: 'done', usage: { totalTokens: 12 } };
    });
    const res = response();
    await new CliController({ run } as never).turn(
      { session: 's1', message: 'work', model: 'm', agent: 'a' },
      res,
    );
    expect(run.mock.calls[0]?.[2]).toEqual({
      model: 'm',
      agentId: 'a',
      signal: expect.any(AbortSignal),
    });
    const events = res.write.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    expect(events.map((e: any) => e.type)).toEqual(['tool_call', 'assistant_message', 'done']);
    expect(events[0].args.apiKey).toBe('***');
    expect(events[2].usage.totalTokens).toBe(12);
    expect(res.end).toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
  it('disconnect aborts only the owned request and drains generator cleanup', async () => {
    let aborted = false,
      cleaned = false;
    const run = async function* (_id: any, _message: any, options: any) {
      try {
        yield { type: 'tool_call', toolName: 'shell' };
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          }),
        );
      } finally {
        cleaned = true;
      }
    };
    const res = response();
    const pending = new CliController({ run } as never).turn(
      { session: 'own', message: 'work' },
      res,
    );
    await new Promise((resolve) => setImmediate(resolve));
    res.destroyed = true;
    res.emit('close');
    await pending;
    expect(aborted).toBe(true);
    expect(cleaned).toBe(true);
  });
});
