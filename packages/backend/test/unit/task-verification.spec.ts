import 'reflect-metadata';
import { TaskVerification } from '../../src/modules/ai/agent/task-verification';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service';
import { ChatControlRegistry } from '../../src/modules/ai/chat/chat-control.registry';
import { visualObservation } from '../../src/modules/ai/agent/visual-observation';

const ok = { success: true, output: 'actual result' };
const report = (ids: string[], status = 'passed') => ({
  checks: [
    {
      requirement: '保存后的内容符合要求',
      status,
      evidence: ids,
      detail: status === 'blocked' ? '登录失效，无法检查' : '重新读取的内容包含要求的修改',
    },
  ],
});
describe('task verification evidence', () => {
  it('does not require extra tools for explanations or a successful read', () => {
    const v = new TaskVerification();
    expect(v.beforeFinish()).toBeUndefined();
    v.record('r', 'file-read', { path: 'a.txt' }, ok);
    expect(v.beforeFinish()).toBeUndefined();
  });
  it('does not turn desktop observation or failed exploration into new mutations', () => {
    const v = new TaskVerification();
    for (const action of [
      'list_windows',
      'list_roots',
      'look',
      'wait_for',
      'read_text',
      'screenshot',
      'zoom',
      'status',
    ]) {
      v.record(
        action,
        'computer_use',
        { action },
        action === 'wait_for' ? { success: false, error: 'not found' } : ok,
      );
    }
    expect(v.required).toBe(false);
    expect(v.beforeFinish()).toBeUndefined();
  });
  it('one final desktop observation covers repeated failed attempts and reads', () => {
    const v = new TaskVerification('给指定联系人发送一次消息');
    for (let i = 0; i < 120; i++) {
      v.record(
        'attempt' + i,
        'computer_use',
        { action: 'act', kind: 'click' },
        { success: false, error: 'stale reference' },
      );
      v.record('look' + i, 'computer_use', { action: 'look' }, ok);
    }
    v.record(
      'sent',
      'computer_use',
      { action: 'act', kind: 'keypress', params: { key: 'Enter' } },
      ok,
    );
    const missing = v.submit(report(['look119']));
    expect(missing.success).toBe(false);
    expect((missing.data as any).missing).toEqual([{ id: 'sent', name: 'computer_use' }]);
    expect(missing.error!.length).toBeLessThan(500);
    v.record('confirmed', 'computer_use', { action: 'look' }, ok);
    expect(v.submit(report(['confirmed'])).success).toBe(true);
    expect(v.beforeFinish()).toBeUndefined();
  });
  it('accepts a desktop action containing its actual post-action observation, but not input success alone', () => {
    const v = new TaskVerification();
    v.record('input', 'computer_use', { action: 'act' }, ok);
    expect(v.submit(report(['input'])).success).toBe(false);
    v.record(
      'final',
      'computer_use',
      { action: 'act' },
      {
        success: true,
        data: {
          desktopWorkflow: true,
          actionPerformed: true,
          lookId: 'new-shot',
          visualObservation: { base64: 'encoded-image' },
          input: { performed: true },
        },
      },
    );
    expect(v.submit(report(['final'])).success).toBe(true);
    v.record('later', 'computer_use', { action: 'act' }, ok);
    expect(v.submit(report(['final'])).success).toBe(false);
    v.record('checked', 'computer_use', { action: 'look' }, ok);
    expect(v.submit(report(['checked'])).success).toBe(true);
  });
  it('resolves a delivered screenshot ID to its real tool call without requiring another send', () => {
    const v = new TaskVerification();
    v.record(
      'sent',
      'computer_use',
      { action: 'act' },
      {
        success: true,
        data: {
          desktopWorkflow: true,
          actionPerformed: true,
          lookId: 'shot-after-send',
          visualEvidence: { kind: 'desktop', screenshotId: 'shot-after-send' },
        },
      },
    );
    const result = v.submit(report(['shot-after-send']));
    expect(result.success).toBe(true);
    expect((result.data as any).checks[0].evidence).toEqual(['sent']);
    expect(v.beforeFinish()).toBeUndefined();
    v.record('changed', 'computer_use', { action: 'act' }, ok);
    expect(v.submit(report(['shot-after-send'])).success).toBe(false);
    expect(new TaskVerification().submit(report(['shot-after-send'])).success).toBe(false);
  });
  it('does not accept an invented, undisplayed, failed or ambiguous screenshot receipt', () => {
    const v = new TaskVerification();
    v.record(
      'undisplayed',
      'computer_use',
      { action: 'look' },
      { success: true, data: { desktopWorkflow: true, lookId: 'not-delivered' } },
    );
    expect(v.submit(report(['not-delivered'])).success).toBe(false);
    for (const id of ['one', 'two'])
      v.record(
        id,
        'computer_use',
        { action: 'look' },
        {
          success: true,
          data: {
            desktopWorkflow: true,
            lookId: 'duplicate',
            visualEvidence: { kind: 'desktop', screenshotId: 'duplicate' },
          },
        },
      );
    expect(v.submit(report(['duplicate'])).success).toBe(false);
    v.record(
      'failed',
      'computer_use',
      { action: 'look' },
      {
        success: false,
        data: {
          desktopWorkflow: true,
          lookId: 'failed-image',
          visualEvidence: { kind: 'desktop', screenshotId: 'failed-image' },
        },
      },
    );
    expect(v.submit(report(['failed-image'])).success).toBe(false);
    expect(v.submit(report(['invented-image'])).success).toBe(false);
  });
  it('accepts UIA post-action observations and excludes explicitly unexecuted inputs', () => {
    const v = new TaskVerification();
    v.record(
      'denied',
      'computer_use',
      { action: 'act' },
      { success: false, approvalRequired: true },
    );
    v.record(
      'refresh',
      'computer_use',
      { action: 'act' },
      { success: true, data: { actionPerformed: false } },
    );
    expect(v.required).toBe(false);
    v.record(
      'uia',
      'computer_use',
      { action: 'act' },
      {
        success: true,
        data: {
          desktopWorkflow: true,
          lookId: 'new',
          input: { performed: true },
          observation: { lookId: 'new', outline: { text: 'sent' } },
        },
      },
    );
    expect(v.submit(report(['uia'])).success).toBe(true);
  });
  it('does not issue a screenshot receipt to a model that cannot receive the image', () => {
    const v = new TaskVerification();
    const raw = {
      success: true,
      data: {
        desktopWorkflow: true,
        actionPerformed: true,
        lookId: 'image',
        visualObservation: { base64: 'image' },
      },
    };
    const unsupported = visualObservation(raw, 'fixture', 'fixture');
    expect((unsupported.result as any).data.visualEvidence).toBeUndefined();
    v.record('send', 'computer_use', { action: 'act' }, unsupported.result);
    expect(v.submit(report(['send'])).success).toBe(false);
  });
  it('does not accept a desktop status or window inventory as proof of sending a message', () => {
    const v = new TaskVerification();
    v.record('send', 'computer_use', { action: 'act', kind: 'keypress' }, ok);
    v.record('status', 'computer_use', { action: 'status' }, ok);
    v.record('list', 'computer_use', { action: 'list_windows' }, ok);
    expect(v.submit(report(['status', 'list'])).success).toBe(false);
  });
  it('retains verification for each affected file and partially failed writes', () => {
    const v = new TaskVerification();
    v.record('w1', 'file-write', { path: 'a.txt' }, ok);
    v.record('w2', 'file-write', { path: 'b.txt' }, { success: false, error: 'partial write' });
    v.record('r1', 'file-read', { path: 'a.txt' }, ok);
    expect(v.submit(report(['r1'])).success).toBe(false);
    v.record('r2', 'file-read', { path: 'b.txt' }, ok);
    expect(v.submit(report(['r1', 'r2'])).success).toBe(true);
  });
  it('catches an execution claim without tools, without trapping ordinary conversation', () => {
    expect(new TaskVerification('请创建文件').beforeFinish('已创建文件')).toContain('验收');
    expect(
      new TaskVerification('解释一下完成是什么意思').beforeFinish('已完成表示工作结束'),
    ).toBeUndefined();
  });
  it('rejects made-up IDs, failed results, stale reads and unrelated files', () => {
    const v = new TaskVerification();
    v.record('old', 'file-read', { path: 'a.txt' }, ok);
    v.record('write', 'file-write', { path: 'a.txt' }, ok);
    v.record('other', 'file-read', { path: 'b.txt' }, ok);
    v.record('bad', 'file-read', { path: 'a.txt' }, { success: false, error: 'offline' });
    for (const id of ['invented', 'old', 'write', 'other', 'bad'])
      expect(v.submit(report([id])).success).toBe(false);
    v.record('fresh', 'file-read', { path: 'a.txt' }, ok);
    expect(v.submit(report(['fresh'])).success).toBe(true);
    expect(v.beforeFinish()).toBeUndefined();
  });
  it('invalidates previous acceptance after further edits, then accepts new readback', () => {
    const v = new TaskVerification();
    v.record('w1', 'office_edit', { path: 'a.docx' }, ok);
    v.record('r1', 'office_read', { path: 'a.docx' }, ok);
    expect(v.submit(report(['r1'])).success).toBe(true);
    v.record('w2', 'office_edit', { path: 'a.docx' }, ok);
    expect(v.beforeFinish()).toContain('尚未验收');
    expect(v.submit(report(['r1'])).success).toBe(false);
    v.record('r2', 'office_read', { path: 'a.docx' }, ok);
    expect(v.submit(report(['r2'])).success).toBe(true);
  });
  it('requires independent browser observation on the acted-on page', () => {
    const v = new TaskVerification();
    v.record('click', 'builtin_browser', { action: 'click', pageId: 'p1' }, ok);
    v.record('wrong', 'builtin_browser', { action: 'snapshot', pageId: 'p2' }, ok);
    expect(v.submit(report(['click'])).success).toBe(false);
    expect(v.submit(report(['wrong'])).success).toBe(false);
    v.record('observe', 'builtin_browser', { action: 'snapshot', pageId: 'p1' }, ok);
    expect(v.submit(report(['observe'])).success).toBe(true);
  });
  it('requires built-in browser validation for changed UI files, in addition to builds', () => {
    const v = new TaskVerification();
    v.record('w', 'file-write', { path: 'app.tsx' }, ok);
    v.record('test', 'powershell', { command: 'npm test' }, { ...ok, data: { exitCode: 0 } });
    expect(v.submit(report(['test'])).success).toBe(false);
    v.record('open', 'builtin_browser', { action: 'navigate', url: 'http://localhost:3000' }, ok);
    v.record('check', 'builtin_browser', { action: 'snapshot' }, ok);
    expect(v.submit(report(['test', 'check'])).success).toBe(true);
  });
  it('does not accept failed commands or silently succeed on blocked checks', () => {
    const v = new TaskVerification();
    v.record('test', 'bash', {}, { success: true, data: { exitCode: 1 } });
    expect(v.submit(report(['test'])).success).toBe(false);
    expect(v.submit(report([], 'blocked')).success).toBe(false);
    expect(v.beforeFinish()).toBeUndefined();
    expect(v.finalText('全部成功')).toContain('未验证');
    expect(v.finalText('全部成功')).not.toContain('全部成功');
  });
  it('continues verification after repeated premature finish attempts, then finishes after a real check', () => {
    const v = new TaskVerification();
    v.record('w', 'file-write', {}, ok);
    expect(v.submit(report([], 'failed')).success).toBe(false);
    expect(v.beforeFinish()).toContain('修复');
    expect(v.beforeFinish()).toBeTruthy();
    expect(v.beforeFinish()).toContain('只读检查');
    expect(() => v.beforeFinish()).toThrow('没有新增验收证据');
    v.record('checked', 'file-read', {}, ok);
    expect(v.submit(report(['checked'])).success).toBe(true);
    expect(v.beforeFinish()).toBeUndefined();
  });
});

function harness(responses: unknown[]) {
  const saved: any[] = [];
  const llm = {
    getDefaultModel: () => 'fixture',
    getMaxContextTokens: () => 100000,
    usesOfficialContext: () => false,
    chatSync: jest.fn().mockImplementation(async () => responses.shift()),
  };
  const session = {
    addMessage: (_id: string, m: unknown) => saved.push(m),
    flush: jest.fn().mockResolvedValue(undefined),
  };
  const service = new (AgentLoopService as any)(
    llm,
    {},
    { validateString: () => {} },
    { info: () => {}, warn: () => {}, debug: () => {} },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    session,
  ) as AgentLoopService;
  jest.spyOn(service as any, 'buildContext').mockResolvedValue([]);
  jest
    .spyOn(service as any, 'getToolDefinitions')
    .mockReturnValue(
      ['file-write', 'file-read', 'file-edit', 'computer_use', 'node_repl', 'powershell'].map(
        (name) => ({ name, parameters: {}, description: name }),
      ),
    );
  jest.spyOn(service as any, 'checkToolGate').mockReturnValue({ action: 'pass' });
  jest.spyOn(service as any, 'emitHook').mockImplementation(() => {});
  const execute = jest.spyOn(service as any, 'executeTool').mockResolvedValue(ok);
  const run = async () => {
    const events = [];
    for await (const e of service.run('verify-fixture', '请修改文件')) events.push(e);
    return events;
  };
  return { service, llm, saved, execute, run };
}
const call = (id: string, name: string, args: unknown) => ({
  content: '',
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
describe('live task loop verification wiring', () => {
  it('allows repeated reads when the observed progress changes', async () => {
    const h = harness([
      ...Array.from({ length: 12 }, (_, i) => call('poll-' + i, 'file-read', { path: 'a.txt' })),
      call('write', 'file-write', { path: 'a.txt' }),
      call('check', 'file-read', { path: 'a.txt' }),
      call('verify', 'task_verify', report(['check'])),
      { content: '已修复并验证' },
    ]);
    let progress = 0;
    h.execute.mockImplementation(async () => ({ success: true, output: 'progress ' + ++progress }));
    const events = await h.run();
    expect(h.execute).toHaveBeenCalledTimes(14);
    expect(events.at(-1)?.type).toBe('done');
  });
  it('rejects duplicate IDs in a batch before executing or recording any call', async () => {
    const h = harness([
      {
        content: '',
        toolCalls: [
          { id: 'same', name: 'file-write', arguments: '{}' },
          { id: 'same', name: 'file-write', arguments: '{}' },
        ],
      },
    ]);
    const events = await h.run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('error');
    expect(h.saved.some((m) => m.toolCalls?.length)).toBe(false);
  });
  it('finishes a desktop task using its returned screenshot without sending again', async () => {
    const h = harness([
      call('explore', 'computer_use', { action: 'wait_for', text: '联系人' }),
      call('send', 'computer_use', { action: 'act', kind: 'keypress', params: { key: 'Enter' } }),
      call('verify', 'task_verify', {
        checks: [
          {
            requirement: '指定消息已发送一次',
            status: 'passed',
            evidence: ['after-send'],
            detail: '操作后截图显示目标聊天中的已发送消息',
          },
        ],
      }),
      { content: '已核对发送结果' },
    ]);
    (h.llm as any).resolveProviderForModel = () => ({ id: 'openai', model: 'gpt-4o' });
    h.execute
      .mockResolvedValueOnce({ success: false, error: 'not found' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          desktopWorkflow: true,
          actionPerformed: true,
          lookId: 'after-send',
          visualObservation: { base64: 'image' },
          input: { performed: true },
        },
      });
    const events = await h.run();
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe('done');
    expect(
      events.find((e) => e.type === 'assistant_message' && e.message?.phase === 'final')?.content,
    ).toBe('已核对发送结果');
  });
  it('suppresses premature completion, checks, repairs, checks again, then emits final', async () => {
    const h = harness([
      call('w', 'file-write', { path: 'a.txt' }),
      { content: '已完成' },
      call('r', 'file-read', { path: 'a.txt' }),
      call('v1', 'task_verify', report(['r'], 'failed')),
      call('fix', 'file-edit', { path: 'a.txt' }),
      call('r2', 'file-read', { path: 'a.txt' }),
      call('v2', 'task_verify', report(['r2'])),
      { content: '已修复并验证' },
    ]);
    const events = await h.run();
    expect(
      events.filter((e) => e.type === 'assistant_message' && e.message?.phase === 'final'),
    ).toEqual([
      {
        type: 'assistant_message',
        content: '已修复并验证',
        message: expect.objectContaining({
          id: expect.any(String),
          role: 'assistant',
          content: '已修复并验证',
        }),
      },
    ]);
    const delivered = events.find(
      (e) => e.type === 'assistant_message' && e.message?.phase === 'final',
    );
    expect(delivered?.type === 'assistant_message' && delivered.message?.id).toBe(
      [...h.saved].reverse().find((m) => m.role === 'assistant' && m.content === '已修复并验证')
        ?.id,
    );
    expect(events.at(-1)?.type).toBe('done');
    expect(h.execute).toHaveBeenCalledTimes(4);
    expect(h.saved.filter((m) => m.role === 'tool')).toHaveLength(6);
    expect(h.llm.chatSync.mock.calls[0][0].tools.some((t: any) => t.name === 'task_verify')).toBe(
      true,
    );
  });
  it('keeps failing command status in context even with nonempty stdout', async () => {
    const h = harness([
      call('bad', 'powershell', { command: 'failing test' }),
      call('v', 'task_verify', report([], 'blocked')),
      { content: '成功' },
    ]);
    h.execute.mockResolvedValue({
      success: false,
      output: 'partial output',
      error: 'exit 1',
      data: { exitCode: 1 },
    });
    const events = await h.run();
    expect(h.saved.find((m) => m.toolCallId === 'bad').content).toContain('"success":false');
    expect(
      events.find((e) => e.type === 'assistant_message' && e.message?.phase === 'final')?.content,
    ).toContain('未验证');
  });
  it('pairs remaining tool calls when cancelled and does not publish a late final response', async () => {
    const h = harness([
      {
        content: '',
        toolCalls: [
          { id: 'one', name: 'file-write', arguments: '{}' },
          { id: 'two', name: 'file-write', arguments: '{}' },
        ],
      },
    ]);
    h.execute.mockImplementation(async () => {
      ChatControlRegistry.requestAbort('verify-fixture');
      return ok;
    });
    const events = await h.run();
    expect(events.at(-1)?.type).toBe('error');
    expect(h.saved.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual([
      'one',
      'two',
    ]);
    expect(h.saved.at(-1).content).toContain('Not executed');
  });
});
