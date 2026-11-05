import 'reflect-metadata';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BackgroundTaskService } from '../../src/modules/ai/background/background-task.service.js';
import { writeJsonAtomicSync } from '../../src/modules/core/utils/atomic-json.util.js';

describe('background execution recovery', () => {
  let dir: string;
  let old: string | undefined;
  const logger = { info: jest.fn(), warn: jest.fn() } as any;
  const ws = { broadcastToSession: jest.fn(), broadcast: jest.fn() } as any;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sky-background-'));
    old = process.env['SKYALYTICWING_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR'] = dir;
  });
  afterEach(() => {
    if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = old;
  });

  it('persists complete prompt, limits concurrency and cancels queued work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const engine = {
      async *run() {
        calls++;
        await gate;
        yield { type: 'done' };
      },
    };
    const service = new BackgroundTaskService(engine as any, ws, logger);
    service.onModuleInit();
    const first = service.submit({ sessionId: 's', prompt: 'x'.repeat(16000) });
    service.submit({ sessionId: 's', prompt: 'two' });
    const third = service.submit({ sessionId: 's', prompt: 'three' });
    expect(calls).toBe(2);
    expect(third.status).toBe('pending');
    expect(
      JSON.parse(readFileSync(join(dir, 'background-tasks.json'), 'utf8')).tasks.find(
        (t: any) => t.id === first.id,
      ).prompt,
    ).toHaveLength(16000);
    service.cancel(third.id);
    release();
    await tick();
    expect(calls).toBe(2);
    expect(third.status).toBe('cancelled');
    service.resume(third.id); await tick();
    expect(calls).toBe(3);
  });

  it('continues the same execution session and repairs unknown tool results without rerunning tools', async () => {
    const history: any[] = [
      {
        id: 'm',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call', type: 'function', function: { name: 'send', arguments: '{}' } }],
      },
    ];
    const session = {
      getMessages: () => history,
      addMessage: (_id: string, message: any) => history.push(message),
      flush: async () => undefined,
    };
    const run = jest.fn(async function* () {
      yield { type: 'assistant_message', content: 'continued' };
      yield { type: 'done' };
    });
    writeJsonAtomicSync(join(dir, 'background-tasks.json'), {
      tasks: [
        {
          id: 'task',
          taskSessionId: 'execution',
          sessionId: 'parent',
          prompt: 'goal',
          status: 'running',
          createdAt: 1,
          attempts: 1,
        },
      ],
    });
    const service = new BackgroundTaskService({ run } as any, ws, logger, session as any);
    service.onModuleInit();
    expect(run).not.toHaveBeenCalled();
    expect(service.get('task')?.status).toBe('interrupted');
    expect(service.resume('task')?.id).toBe('task');
    expect(service.resume('task')?.id).toBe('task');
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(
      expect.arrayContaining(['execution', expect.stringContaining('仅执行尚未完成')]),
    );
    const options = (run.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty('maxIterations');
    expect(options).not.toHaveProperty('maxDurationMs');
    expect(options).not.toHaveProperty('maxTotalTokens');
    expect(
      history.some(
        (m) => m.role === 'tool' && m.toolCallId === 'call' && m.content.includes('结果未知'),
      ),
    ).toBe(true);
    expect(service.get('task')?.status).toBe('completed');
    service.resume('task');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not restart side effects when execution history is missing', () => {
    writeJsonAtomicSync(join(dir, 'background-tasks.json'), {
      tasks: [
        {
          id: 'task',
          taskSessionId: 'execution',
          sessionId: 'parent',
          prompt: 'goal',
          status: 'running',
          createdAt: 1,
        },
      ],
    });
    const service = new BackgroundTaskService({ run: jest.fn() } as any, ws, logger, {
      getMessages: () => [],
    } as any);
    service.onModuleInit();
    expect(() => service.resume('task')).toThrow('执行历史不可用');
  });
});
