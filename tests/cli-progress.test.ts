import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnProgress } from '../packages/cli/src/progress.js';

afterEach(() => vi.useRealTimers());

describe('CLI waiting feedback', () => {
  it('immediately shows activity, keeps long waits visible, and clears timers on stop', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const progress = new TurnProgress(true, write, true);
    progress.set('正在提交任务…');
    expect(write).toHaveBeenLastCalledWith('Wing · 正在提交任务…');
    progress.set('正在等待 AI 回复…');
    vi.advanceTimersByTime(15_000);
    expect(write).toHaveBeenLastCalledWith('Wing · 正在等待 AI 回复… · 已用时 15 秒');
    progress.set('正在执行工具：browser');
    expect(vi.getTimerCount()).toBe(1);
    progress.stop();
    const count = write.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not emit feedback or timers in machine output mode', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const progress = new TurnProgress(false, write, true);
    progress.set('正在等待 AI 回复…');
    expect(write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps redirected logs free of periodic heartbeat noise', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const progress = new TurnProgress(true, write, false);
    progress.set('正在等待 AI 回复…');
    vi.advanceTimersByTime(60_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
