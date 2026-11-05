import { randomUUID } from 'node:crypto';
import { RunJournal } from '../../src/modules/ai/agent/run-journal';
import { recoverToolHistory } from '../../src/modules/ai/agent/recover-tool-history';
describe('durable execution evidence', () => {
  it('distinguishes completed and unknown tools after an interrupted run and isolates identities', () => {
    const identity = randomUUID(),
      session = randomUUID();
    const run = new RunJournal(identity, session, 'task');
    run.toolStarted('read', 'file-read', {});
    run.toolFinished('read', { success: true, output: 'ok' });
    run.toolStarted('write', 'file-write', {});
    expect(RunJournal.list(identity, session)[0]!.state).toBe('running');
    run.finish('interrupted');
    const recovered = RunJournal.list(identity, session)[0]!;
    expect(recovered.state).toBe('interrupted');
    expect(recovered.uncertainTools).toEqual([
      { callId: 'write', name: 'file-write', state: 'unknown' },
    ]);
    expect(RunJournal.list(identity + 'other', session)).toEqual([]);
    expect(RunJournal.list(identity, session + 'other')).toEqual([]);
    run.toolFinished('write', { success: true });
    run.finish('completed');
    expect(RunJournal.list(identity, session)[0]!.state).toBe('completed');
    expect(RunJournal.list(identity, session)[0]!.uncertainTools).toHaveLength(0);
  });
  it('repairs partial parallel tool results before the next user message without replay', () => {
    const history: any[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'write', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', toolCallId: 'b', content: 'real result' },
      { role: 'user', content: 'continue' },
    ];
    const repaired = recoverToolHistory(history);
    expect(repaired.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(repaired[1]!.content).toContain('Execution result unknown');
    expect(repaired[2]!.content).toBe('real result');
    expect(history).toHaveLength(3);
  });
});
