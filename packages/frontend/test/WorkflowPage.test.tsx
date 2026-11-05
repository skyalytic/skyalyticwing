import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowPage } from '@/modules/workflow/WorkflowPage';
import { apiClient } from '@/services/api-client';
import i18n from '@/i18n';
vi.mock('@/services/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/components/modals/ConfirmDialog', () => ({ showConfirm: vi.fn(async () => true) }));
const get = vi.mocked(apiClient.get);
const wf = {
  id: 'wf-a',
  name: 'Report pipeline',
  description: 'old description',
  createdAt: 1,
  updatedAt: 1,
  steps: [
    { id: 'a', name: 'Draft', prompt: 'draft' },
    { id: 'b', name: 'Review', prompt: 'review', dependsOn: ['a'] },
  ],
};
const mount = () =>
  render(
    <MemoryRouter>
      <WorkflowPage />
    </MemoryRouter>,
  );
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage('zh-CN');
  get.mockImplementation(async (path) => (path === '/workflow' ? [structuredClone(wf)] : []));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('workflow page', () => {
  it('lets users inspect earlier run results without replacing the latest list status', async () => {
    get.mockImplementation(async (path) =>
      path === '/workflow'
        ? [wf]
        : path.endsWith('/logs')
          ? [
              {
                id: 'old',
                status: 'error',
                error: 'Earlier failure',
                startedAt: 1,
                stepResults: [],
              },
              { id: 'new', status: 'success', startedAt: 2, stepResults: [] },
            ]
          : [],
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '运行记录' }));
    fireEvent.change(await screen.findByLabelText('选择运行记录'), { target: { value: 'old' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Earlier failure');
    expect(screen.getByRole('article')).toHaveTextContent('成功');
  });
  it('renders a useful empty state and opens the actual editor', async () => {
    get.mockResolvedValue([]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '创建第一个工作流' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('新建工作流');
    expect(screen.getByRole('link', { name: /智能体/ })).toHaveAttribute('href', '/agents');
  });
  it('reports a load error instead of claiming no workflows exist', async () => {
    get.mockImplementation(async (path) => {
      if (path === '/workflow') throw Error('Service offline');
      return [];
    });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Service offline');
    expect(screen.queryByRole('button', { name: '创建第一个工作流' })).toBeNull();
  });
  it('clears descriptions and removes deleted dependency IDs when saving', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByDisplayValue('old description'), { target: { value: '' } });
    fireEvent.click(dialog.getAllByRole('button', { name: '删除' })[0]);
    fireEvent.click(dialog.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith(
        '/workflow/wf-a',
        expect.objectContaining({
          description: '',
          steps: [expect.objectContaining({ id: 'b', dependsOn: [] })],
        }),
      ),
    );
  });
  it('creates a workflow with stable step IDs and a review point', async () => {
    get.mockResolvedValue([]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '创建第一个工作流' }));
    fireEvent.change(screen.getByPlaceholderText('例：周报生成流水线'), {
      target: { value: 'Weekly report' },
    });
    fireEvent.change(screen.getByPlaceholderText('本步骤的提示词（发送给 AI 的任务指令）'), {
      target: { value: 'Create report' },
    });
    fireEvent.click(screen.getByLabelText('执行前暂停，让我审核前序产物'));
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        '/workflow',
        expect.objectContaining({
          name: 'Weekly report',
          steps: [
            expect.objectContaining({
              id: expect.any(String),
              reviewBefore: true,
              prompt: 'Create report',
            }),
          ],
        }),
      ),
    );
  });
  it('updates the card after completion and rejects duplicate run clicks', async () => {
    let resolveRun!: (value: any) => void;
    vi.mocked(apiClient.post).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );
    get.mockImplementation(async (path) =>
      path === '/workflow'
        ? [wf]
        : path.endsWith('/logs')
          ? [{ id: 'run', status: 'success', startedAt: 1, finishedAt: 2, stepResults: [] }]
          : [],
    );
    mount();
    const button = await screen.findByRole('button', { name: '运行', exact: true });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolveRun({ id: 'run', status: 'running', startedAt: 1, stepResults: [] }),
    );
    await waitFor(() => expect(screen.getByRole('article')).toHaveTextContent('成功'));
    expect(screen.getByRole('button', { name: '运行', exact: true })).not.toBeDisabled();
  });
  it('ignores a late log response after closing and opening another workflow', async () => {
    let resolveOld!: (value: any) => void;
    get.mockImplementation(async (path) =>
      path === '/workflow'
        ? [wf, { ...wf, id: 'wf-b', name: 'Other' }]
        : path === '/workflow/wf-a/logs'
          ? new Promise((resolve) => {
              resolveOld = resolve;
            })
          : path === '/workflow/wf-b/logs'
            ? [
                {
                  id: 'new',
                  status: 'error',
                  error: 'Current result',
                  startedAt: 1,
                  stepResults: [],
                },
              ]
            : [],
    );
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: '运行记录' }))[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: '关闭' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '运行记录' })[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Current result');
    await act(async () =>
      resolveOld([{ id: 'old', status: 'success', startedAt: 1, stepResults: [] }]),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Current result');
  });
});
