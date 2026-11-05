import { BrowserService } from '../../src/modules/automation/browser.service.js';
import { ChatControlService } from '../../src/modules/ai/chat/chat-control.service.js';
import { DashScopeVideoProvider } from '../../src/modules/automation/video-provider.service.js';
import type { ChatMessage } from '@skyalyticwing/shared';

describe('live acceptance regressions', () => {
  it('rejects a completed video task without an artifact URL', async () => {
    jest.useFakeTimers();
    try {
      const provider = new DashScopeVideoProvider({ apiKey: 'test-only' }, {
        post: jest.fn().mockResolvedValue({ status: 200, data: { output: { task_id: 'fixture-task' } } }),
        get: jest.fn().mockResolvedValue({ status: 200, data: { output: { task_status: 'SUCCEEDED' } } }),
      } as never);
      const assertion = expect(provider.generate({ prompt: 'test' })).rejects.toThrow('no video URL');
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally { jest.useRealTimers(); }
  });
  it('navigates to the requested screenshot URL and exposes connection failures', async () => {
    const service = new BrowserService({ warn: jest.fn() } as never);
    const navigate = jest
      .spyOn(service, 'navigate')
      .mockResolvedValue({ ok: true, targetId: 'fixture' });
    const capture = jest
      .spyOn(service, 'browserScreenshot')
      .mockResolvedValue({ ok: true, path: 'fixture.png' });
    expect(await service.screenshot('https://example.com')).toEqual({
      success: true,
      path: 'fixture.png',
    });
    expect(navigate).toHaveBeenCalledWith('https://example.com');
    expect(capture).toHaveBeenCalledWith({ targetId: 'fixture' });
    navigate.mockRejectedValueOnce(new Error('browser disconnected'));
    expect(await service.screenshot('https://example.com')).toMatchObject({
      success: false,
      error: 'browser disconnected',
    });
  });
  it('keeps tool-call pairs together and stores manual summaries as contextual data', async () => {
    const messages: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      role: 'user',
      content: 'old context'.repeat(200),
      timestamp: i,
    }));
    messages.push({
      id: 'call',
      role: 'assistant',
      content: '',
      timestamp: 6,
      toolCalls: [{ id: 'call-id', type: 'function', function: { name: 'read', arguments: '{}' } }],
    });
    messages.push({
      id: 'result',
      role: 'tool',
      content: 'result',
      timestamp: 7,
      toolCallId: 'call-id',
    });
    messages.push(
      ...Array.from({ length: 7 }, (_, i): ChatMessage => ({
        id: 'recent-' + i,
        role: 'user',
        content: 'recent context',
        timestamp: 8 + i,
      })),
    );
    const setContextMessages = jest.fn().mockReturnValue(true);
    const service = new ChatControlService(
      {
        chatSync: jest.fn().mockResolvedValue({ content: 'summary' }),
        getDefaultModel: () => 'test',
      } as never,
      { info: jest.fn() } as never,
      { getSession: () => ({ messages }), setContextMessages } as never,
    );
    await service.compact('fixture');
    const output = setContextMessages.mock.calls[0]?.[2] as ChatMessage[];
    expect(output[0]?.role).toBe('user');
    expect(output[1]?.id).toBe('call');
    expect(output[2]?.id).toBe('result');
  });
  it('fails promptly on video polling errors instead of silently polling for fifteen minutes', async () => {
    jest.useFakeTimers();
    try {
      const provider = new DashScopeVideoProvider({ apiKey: 'test-only' }, {
        post: jest
          .fn()
          .mockResolvedValue({ status: 200, data: { output: { task_id: 'fixture-task' } } }),
        get: jest
          .fn()
          .mockResolvedValue({
            status: 402,
            data: { code: 'InsufficientBalance', message: 'No balance' },
          }),
      } as never);
      const assertion = expect(provider.generate({ prompt: 'test' })).rejects.toThrow('HTTP 402');
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});


