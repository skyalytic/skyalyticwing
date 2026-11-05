import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSurfaceCoordinator } from '../src/components/layout/DesktopSurfaces';
import { apiClient } from '../src/services/api-client';
import { nativeInvoke } from '../src/services/native-browser';
import { useApprovalStore } from '../src/stores/approval-store';
import { useAskUserStore } from '../src/stores/ask-user-store';

vi.mock('../src/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/services/native-browser', () => ({ nativeInvoke: vi.fn() }));
vi.mock('../src/services/tauri-bridge', () => ({ isTauri: () => true }));
vi.mock('../src/components/chat/ApprovalInlineCard', () => ({ ApprovalInlineCard: () => null }));
vi.mock('../src/components/layout/DesktopControlBar', () => ({ DesktopControlBar: () => null }));

describe('independent desktop surfaces', () => {
  const request = { id: 'approval', toolName: 'computer_use', args: { kind: 'click' }, sessionId: 'other-chat', reason: 'test', timestamp: 1 };
  let approvals: typeof request[];
  let mode: string;
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); useApprovalStore.getState().clear(); useAskUserStore.getState().sync([]);
    approvals = [request]; mode = 'physical';
    vi.mocked(nativeInvoke).mockResolvedValue(undefined);
    vi.mocked(apiClient.get).mockImplementation(async (path) => (path === '/approvals' ? approvals : path === '/tools/ask-user/pending' ? [] : {
      active: true, paused: false, inputMode: mode, cursor: { x: -100, y: 60, visible: true },
    }) as never);
  });
  afterEach(() => { cleanup(); useApprovalStore.getState().clear(); vi.useRealTimers(); });
  it('opens action-time questions from another chat and closes after cancellation without sending input', async () => {
    let questions = [{ id: 'send-confirmation', sessionId: 'other-chat', question: '发送指定消息？', options: ['确认','取消'], multiple: false }];
    vi.mocked(apiClient.get).mockImplementation(async path => path === '/tools/ask-user/pending' ? questions as never : path === '/approvals' ? [] as never : { active: true, inputMode: 'physical', platform: 'win32' } as never);
    await act(async () => { render(<DesktopSurfaceCoordinator />); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'approval', visible: true });
    expect(useAskUserStore.getState().requests).toEqual(questions);
    questions = []; await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'approval', visible: false });
    expect(apiClient.post).not.toHaveBeenCalled();
  });
  it('opens approval separately from the viewed chat and hides it after a decision elsewhere', async () => {
    await act(async () => { render(<DesktopSurfaceCoordinator />); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'approval', visible: true });
    expect(useApprovalStore.getState().pendingApprovals).toEqual([request]);
    approvals = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'approval', visible: false });
    expect(useApprovalStore.getState().pendingApprovals).toEqual([]);
  });
  it('uses one external control plus desktop effects on non-Windows desktops', async () => {
    await act(async () => { render(<DesktopSurfaceCoordinator />); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'effects', visible: true });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'control', visible: true });
    expect(vi.mocked(nativeInvoke).mock.calls.some(([, args]) => (args as any).surface === 'cursor')).toBe(false);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
  it('uses the native Windows stop bar for physical input without a second covering window', async () => {
    vi.mocked(apiClient.get).mockImplementation(async path => (path === '/approvals' ? [] : {
      active: true, paused: false, inputMode: 'physical', platform: 'win32',
    }) as never);
    await act(async () => { render(<DesktopSurfaceCoordinator />); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'control', visible: false });
  });
  it('still opens approval when desktop status cannot be fetched', async () => {
    vi.mocked(apiClient.get).mockImplementation(async path => {
      if (path === '/approvals') return approvals as never;
      throw new Error('status disconnected');
    });
    await act(async () => { render(<DesktopSurfaceCoordinator />); });
    expect(nativeInvoke).toHaveBeenCalledWith('desktop_surface', { surface: 'approval', visible: true });
    expect(useApprovalStore.getState().pendingApprovals).toEqual([request]);
  });
  it('retains approval on native failure and retries instead of accepting it', async () => {
    vi.mocked(nativeInvoke).mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => { render(<DesktopSurfaceCoordinator />); });
    expect(useApprovalStore.getState().pendingApprovals).toEqual([request]);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([, args]) => (args as any).surface === 'approval')).toHaveLength(2);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
