import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { DesktopControlBar } from '../src/components/layout/DesktopControlBar';
import { apiClient } from '../src/services/api-client';
const sessionState = vi.hoisted(() => ({
  sessions: [{ id: 'owner', title: '客户回复' }, { id: 'current', title: '报表整理' }],
  currentSessionId: 'owner',
}));
vi.mock('../src/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/stores/session-store', () => ({ useSessionStore: (select: (s: typeof sessionState) => unknown) => select(sessionState) }));
vi.mock('../src/i18n/workbench-text', () => ({
  wt: (text: string, vars: Record<string, string> = {}) => text.replace(/{{(\w+)}}/g, (_, key: string) => vars[key] || ''),
  useWorkbenchLanguage: () => 'zh-CN',
}));
const running = {
  active: true, mode: 'visual', phase: 'ready', paused: false, available: true,
  target: { title: 'Fixture' }, sessionId: 'owner', lastAction: 'click', verification: 'matched',
};
const renderControl = () => act(async () => { render(<DesktopControlBar />); });

describe('desktop takeover control', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    sessionState.currentSessionId = 'owner';
    vi.mocked(apiClient.get).mockResolvedValue(running);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('does not offer mouse mode changes while a task is running', async () => {
    await renderControl();
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('keeps the compact external control focused on the active operation', async () => {
    sessionState.currentSessionId = 'current'; await renderControl();
    expect(screen.getByText('Wing 正在控制桌面')).toBeInTheDocument();
    expect(screen.queryByText('目标窗口：Fixture')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '结束控制' })); });
    expect(apiClient.post).toHaveBeenCalledWith('/automation/desktop/control/stop', { sessionId: 'owner' });
  });

  it('pauses, resumes, and ends control only after the server confirms each action', async () => {
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ ...running, phase: 'paused', paused: true })
      .mockResolvedValueOnce({ ...running, phase: 'needs_observation' })
      .mockResolvedValueOnce({ active: false, phase: 'stopped', paused: true });
    await renderControl();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '暂停并接管' })); });
    expect(screen.getByText('桌面控制已暂停')).toBeInTheDocument();
    expect(apiClient.post).toHaveBeenCalledWith('/automation/desktop/control/pause', { sessionId: 'owner' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '允许继续操作' })); });
    expect(apiClient.post).toHaveBeenCalledWith('/automation/desktop/control/resume', { sessionId: 'owner' });
    expect(screen.getByText('Wing 正在控制桌面')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '结束控制' })); });
    expect(apiClient.post).toHaveBeenCalledWith('/automation/desktop/control/stop', { sessionId: 'owner' });
    expect(screen.getByText('桌面控制已停止')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许继续操作' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '结束控制' })).not.toBeInTheDocument();
  });

  it('reports connection loss without hiding the stop control and clears the warning on recovery', async () => {
    vi.mocked(apiClient.get)
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error('Disconnected'))
      .mockResolvedValueOnce({ ...running, mode: 'uia' });
    await renderControl();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('alert')).toHaveTextContent('桌面控制状态待确认');
    expect(screen.getByRole('button', { name: '结束控制' })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Wing 正在控制桌面')).toBeInTheDocument();
  });

  it('does not let an older status request resurrect control after stopping', async () => {
    let resolveOld: (value: typeof running) => void = () => {};
    vi.mocked(apiClient.get).mockResolvedValueOnce(running)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    vi.mocked(apiClient.post).mockResolvedValue({ active: false, phase: 'stopped', paused: true });
    await renderControl();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '结束控制' })); });
    await act(async () => { resolveOld(running); });
    expect(screen.getByText('桌面控制已停止')).toBeInTheDocument();
    expect(screen.queryByText('Wing 正在控制桌面')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许继续操作' })).toBeEnabled();
  });

  it.each([
    { phase: 'idle', sessionId: undefined },
    { phase: 'stopped', sessionId: 'owner' },
  ])('retains the resume entry for inactive paused state ($phase)', async ({ phase, sessionId }) => {
    sessionState.currentSessionId = 'current';
    vi.mocked(apiClient.get).mockResolvedValue({ ...running, active: false, phase, sessionId, paused: true });
    vi.mocked(apiClient.post).mockResolvedValue({ active: false, phase: 'needs_observation', paused: false });
    await renderControl();
    expect(screen.getByText('桌面控制已停止')).toBeInTheDocument();
    expect(screen.queryByText('Wing 正在控制桌面')).not.toBeInTheDocument();
    expect(screen.queryByText('另一个会话正在控制桌面，下方按钮作用于该控制任务。')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '结束控制' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '允许继续操作' })); });
    expect(apiClient.post).toHaveBeenCalledWith('/automation/desktop/control/resume', { sessionId });
    expect(screen.queryByRole('region', { name: '桌面操作' })).not.toBeInTheDocument();
  });

  it('keeps controls available and shows the failure when stopping was not confirmed', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error('Connection lost'));
    await renderControl();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '结束控制' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('未能更改桌面控制状态');
    expect(screen.getByRole('button', { name: '结束控制' })).toBeEnabled();
  });

  it('does not poll while a control action is pending or hide a first-load connection error', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(running);
    await renderControl();
    expect(screen.getAllByText('桌面控制状态待确认').length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: '暂停并接管' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '结束控制' })).toBeDisabled();
  });

  it('hides inactive state and cancels outstanding polling when unmounted', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ active: false, phase: 'idle', paused: false });
    await renderControl();
    expect(screen.queryByRole('region', { name: '桌面操作' })).not.toBeInTheDocument();
    vi.mocked(apiClient.get).mockImplementation(() => new Promise(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const requestOptions = vi.mocked(apiClient.get).mock.calls.at(-1)?.[1];
    cleanup();
    expect(requestOptions?.signal?.aborted).toBe(true);
  });
});
