import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCenterPage } from '../src/modules/tasks/TaskCenterPage';
import { apiClient } from '../src/services/api-client';

vi.mock('../src/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
const empty = () => ({
  tasks: [],
  rules: [],
  deliveries: [],
  admissions: [],
  notices: [],
  questions: [],
  approvals: [],
});
const task = {
  id: 'chat:s',
  kind: 'chat',
  sourceId: 's',
  sessionId: 's',
  originSessionId: 's',
  title: 'Prepare report',
  stage: 'answer',
  detail: '',
  result: '',
  artifacts: [],
  inputs: [],
  history: [],
  updatedAt: 1,
};
let data: any;
beforeEach(() => {
  vi.resetAllMocks();
  data = empty();
  vi.mocked(apiClient.get).mockImplementation(async (path) =>
    path === '/scheduler/prompts' ? [{ id: 'agent', name: 'Agent' }] : data,
  );
  vi.mocked(apiClient.post).mockResolvedValue({ success: true });
});
afterEach(cleanup);
const open = () =>
  render(
    <MemoryRouter>
      <TaskCenterPage />
    </MemoryRouter>,
  );

describe('task supervision UI', () => {
  it('submits a free answer rather than forcing a suggested option', async () => {
    data.tasks = [task];
    data.questions = [
      {
        id: 'q',
        sessionId: 's',
        question: 'Which format?',
        options: ['PDF', 'Word'],
        multiple: false,
      },
    ];
    open();
    await screen.findByText('Which format?');
    fireEvent.click(screen.getByLabelText('PDF'));
    fireEvent.change(screen.getByLabelText('填写回答'), {
      target: { value: 'Spreadsheet please' },
    });
    fireEvent.click(screen.getByText('提交回答'));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/tools/ask-user/respond', {
        id: 'q',
        answer: ['Spreadsheet please'],
      }),
    );
  });
  it('only exposes uncertain-delivery replay after an explicit outcome check', async () => {
    data.deliveries = [
      {
        id: 'd',
        channel: 'mail',
        peer: 'alice',
        content: 'result',
        state: 'unknown',
        error: 'timeout',
        attempts: 1,
        nextAt: 0,
      },
    ];
    open();
    fireEvent.click(screen.getByText('发送队列'));
    await screen.findByText('mail · alice');
    expect(screen.getByText('重试发送')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('已核对接收方和实际发送结果'));
    fireEvent.click(screen.getByText('重试发送'));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/scheduler/deliveries/d/retry', {
        confirmed: true,
      }),
    );
  });
  it('passes the existing rule revision but excludes the server scheduling timestamp', async () => {
    const rule = {
      id: 'r',
      revision: 2,
      name: 'Reports',
      source: 'interval',
      mode: 'observe',
      channel: '',
      peer: '',
      contains: '',
      prompt: 'Check reports',
      agentId: '',
      intervalMinutes: 60,
      nextAt: 1000,
    };
    data.rules = [rule];
    vi.mocked(apiClient.post).mockResolvedValue({ ...rule, revision: 3 });
    open();
    fireEvent.click(screen.getByText('主动规则'));
    fireEvent.click(await screen.findByText('Reports · observe'));
    fireEvent.click(screen.getByText('保存规则'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const payload = vi.mocked(apiClient.post).mock.calls[0]?.[1];
    expect(payload).toMatchObject({ expectedRevision: 2, mode: 'observe' });
    expect(payload).not.toHaveProperty('nextAt');
    expect(payload).not.toHaveProperty('revision');
  });
  it('shows a failed save and keeps the users unsaved prompt', async () => {
    const doc = {
      id: 'agent',
      revisions: [{ revision: 1, text: 'old', reason: 'initial', at: 1 }],
      template: '',
      effective: 'Actual system instructions',
      diff: '',
    };
    vi.mocked(apiClient.get).mockImplementation(async (path) =>
      path === '/scheduler/prompts'
        ? [{ id: 'agent', name: 'Agent' }]
        : path.startsWith('/scheduler/prompts/')
          ? doc
          : data,
    );
    vi.mocked(apiClient.post).mockRejectedValue(new Error('Prompt changed; reload before saving'));
    open();
    fireEvent.click(screen.getByText('提示词版本'));
    await screen.findByText('Agent');
    fireEvent.change(screen.getByLabelText('智能体'), { target: { value: 'agent' } });
    await screen.findByDisplayValue('old');
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'my unsaved edit' } });
    fireEvent.click(screen.getByText('保存版本'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Prompt changed');
    expect(screen.getByLabelText('提示词')).toHaveValue('my unsaved edit');
    expect(apiClient.post).toHaveBeenCalledWith('/scheduler/prompts/agent', {
      text: 'my unsaved edit',
      expectedRevision: 1,
    });
  });
  it('keeps the edit base revision when refreshing the effective prompt after an external update', async () => {
    const revision = (n: number) => ({ revision: n, text: 'v' + n, reason: 'edit', at: n });
    let revisions = [revision(1)];
    vi.mocked(apiClient.get).mockImplementation(async (path) =>
      path === '/scheduler/prompts'
        ? [{ id: 'agent', name: 'Agent' }]
        : path.startsWith('/scheduler/prompts/')
          ? { id: 'agent', revisions, template: '', effective: 'effective', diff: '' }
          : data,
    );
    open();
    fireEvent.click(screen.getByText('提示词版本'));
    await screen.findByText('Agent');
    fireEvent.change(screen.getByLabelText('智能体'), { target: { value: 'agent' } });
    await screen.findByDisplayValue('v1');
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'unsaved' } });
    revisions = [revision(1), revision(2)];
    fireEvent.click(screen.getByText('刷新生效预览'));
    await screen.findByText(/v2 ·/);
    fireEvent.click(screen.getByText('保存版本'));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith('/scheduler/prompts/agent', {
        text: 'unsaved',
        expectedRevision: 1,
      }),
    );
  });
  it('keeps completed tasks available but starts with actionable tasks', async () => {
    data.tasks = [
      { ...task, stage: 'completed', title: 'Finished' },
      { ...task, id: 'blocked', stage: 'blocked', title: 'Needs repair' },
    ];
    open();
    await screen.findByText('Needs repair');
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('只看待处理'));
    expect(screen.getByText('Finished')).toBeInTheDocument();
  });
});
