import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '@/components/project/FileTree';
import { useProjectPanel } from '@/stores/project-panel-store';
import { apiClient } from '@/services/api-client';

vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn() } }));
const get = vi.mocked(apiClient.get);
const file = (name: string) => ({ name, type: 'file', size: 10 });
beforeEach(() => { vi.resetAllMocks(); useProjectPanel.setState({ treeVersion: 0, currentFile: '' }); });

describe('project file refresh', () => {
  it('replaces a previous empty directory when a tool finishes and opens the new file', async () => {
    get.mockResolvedValueOnce({ entries: [] }).mockResolvedValueOnce({ entries: [file('snake.html')] });
    render(<FileTree root="E:/测试" />);
    await screen.findByText('（空目录）');
    act(() => useProjectPanel.getState().bumpTreeVersion());
    fireEvent.click(await screen.findByText('snake.html'));
    expect(screen.queryByText('（空目录）')).toBeNull();
    expect(useProjectPanel.getState().currentFile).toBe('E:/测试/snake.html');
  });

  it('refreshes expanded nested folders without collapsing them or losing current files', async () => {
    let added = false;
    get.mockImplementation(async (url) => String(url).includes(encodeURIComponent('E:/测试/src'))
      ? { entries: [file('first.ts'), ...(added ? [file('new.ts')] : [])] }
      : { entries: [{ name: 'src', type: 'dir', size: 0 }] });
    render(<FileTree root="E:/测试" />);
    fireEvent.click(await screen.findByText('src'));
    await screen.findByText('first.ts');
    added = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }));
    expect(screen.getByText('first.ts')).toBeInTheDocument();
    await screen.findByText('new.ts');
    expect(screen.getByText('first.ts')).toBeInTheDocument();
  });

  it('does not show an error or invalid response as an empty directory and can retry', async () => {
    get.mockResolvedValueOnce({ unexpected: true }).mockResolvedValueOnce({ entries: [file('ok.txt')] });
    render(<FileTree root="E:/测试" />);
    await screen.findByRole('alert');
    expect(screen.queryByText('（空目录）')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('ok.txt');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores an obsolete response after switching project folders', async () => {
    let resolveOld!: (value: unknown) => void;
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ entries: [file('current.txt')] });
    const view = render(<FileTree root="E:/old" />);
    view.rerender(<FileTree root="E:/new" />);
    await screen.findByText('current.txt');
    await act(async () => resolveOld({ entries: [file('stale.txt')] }));
    expect(screen.queryByText('stale.txt')).toBeNull();
    expect(screen.getByText('current.txt')).toBeInTheDocument();
  });

  it('refreshes external edits when the app regains focus', async () => {
    get.mockResolvedValueOnce([]).mockResolvedValueOnce([file('external.txt')]);
    render(<FileTree root="E:/测试" />);
    await screen.findByText('（空目录）');
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByText('external.txt')).toBeInTheDocument());
  });
});
