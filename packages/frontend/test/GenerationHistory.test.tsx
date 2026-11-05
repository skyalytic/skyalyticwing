import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationHistory } from '@/modules/tools/GenerationHistory';
import { apiClient } from '@/services/api-client';

vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
const get = vi.mocked(apiClient.get);
beforeEach(() => { vi.resetAllMocks(); get.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });
describe('generation history overlay', () => {
  it('escapes the clipped chat pane, aligns content left, and closes through its visible controls', async () => {
    const { container } = render(<MemoryRouter><div style={{ overflow: 'hidden', transform: 'translateX(0)' }}><GenerationHistory /></div></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '生成记录' }));
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest('.modal-overlay')?.parentElement).toBe(document.body);
    expect(screen.getByRole('region', { name: '视频生成任务' }).parentElement).toHaveClass('text-left');
    await screen.findByText('暂无生成任务，返回对话开始创作。');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '生成记录' }));
    fireEvent.click(screen.getByRole('button', { name: '返回对话' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('distinguishes loading and errors from an empty task list and clears a recovered error', async () => {
    vi.useFakeTimers();
    get.mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce([]);
    render(<MemoryRouter><GenerationHistory /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '生成记录' }));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('暂无生成任务，返回对话开始创作。')).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('alert')).toHaveTextContent('网络中断');
    expect(screen.queryByText('暂无生成任务，返回对话开始创作。')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('暂无生成任务，返回对话开始创作。')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
