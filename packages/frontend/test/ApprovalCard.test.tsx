// 审批组件测试（原全局弹窗 ApprovalDialog 已重组为内嵌卡 + 接管条）：
//   ApprovalInlineCard：4 种决策按钮 / 审批信息展示 / 命令工具 / 参数截断 / 已决态
//   ApprovalTakeover：Enter 批准一次 / Esc 拒绝 / 队列数
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalInlineCard } from '@/components/chat/ApprovalInlineCard';
import { ApprovalTakeover } from '@/components/chat/ApprovalTakeover';
import { useApprovalStore } from '@/stores/approval-store';
import { useSessionStore } from '@/stores/session-store';
import { apiClient } from '@/services/api-client';
import type { ToolApprovalRequest } from '@/types';

vi.mock('@/services/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);

const makeRequest = (overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest => ({
  id: 'ap-1',
  toolName: 'file-write',
  args: { path: '/tmp/demo.txt', content: 'hello' },
  sessionId: 's1',
  reason: '写入敏感目录',
  timestamp: Date.now(),
  ...overrides,
});

const resetStore = (): void => {
  useApprovalStore.getState().clear();
  useSessionStore.setState({ currentSessionId: 's1' });
};

describe('ApprovalInlineCard（内嵌审批卡）', () => {
  it('keeps failed submissions pending and permits retry without falsely approving', async () => {
    mockedPost.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({});
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalTakeover />);
    fireEvent.click(screen.getByRole('button', { name: '批准一次' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '批准一次' })).toBeEnabled());
    expect(useApprovalStore.getState().pendingApprovals).toHaveLength(1);
    expect(useApprovalStore.getState().resolvedApprovals['ap-1']).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '批准一次' }));
    await waitFor(() => expect(screen.queryByText('等待审批')).toBeNull());
    expect(mockedPost).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repeated keyboard decisions while a response is pending', async () => {
    let finish!: (value: unknown) => void;
    mockedPost.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalTakeover />);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(screen.getByText('等待审批')).toBeInTheDocument();
    await act(async () => finish({}));
    expect(screen.queryByText('等待审批')).toBeNull();
  });

  it('does not approve or reject a request while a modal owns keyboard input', () => {
    useApprovalStore.getState().addApproval(makeRequest());
    render(<><ApprovalTakeover /><div role="dialog" aria-modal="true">生成记录</div></>);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('does not turn Enter on a focused deny button into approval', () => {
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalTakeover />);
    fireEvent.keyDown(screen.getByRole('button', { name: '拒绝', exact: true }), { key: 'Enter' });
    expect(mockedPost).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockedGet.mockResolvedValue({ approvals: [] } as never);
    mockedPost.mockResolvedValue({} as never);
  });

  it('展示审批信息：工具名 / 原因 / 参数 JSON / 等待审批徽标', () => {
    render(<ApprovalInlineCard request={makeRequest()} />);

    expect(screen.getByText('工具调用请求')).toBeInTheDocument();
    expect(screen.getByText('file-write')).toBeInTheDocument();
    expect(screen.getByText('写入敏感目录')).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/demo\.txt/)).toBeInTheDocument();
    expect(screen.getByText('等待审批')).toBeInTheDocument();
  });

  it('提供 4 种决策按钮', () => {
    render(<ApprovalInlineCard request={makeRequest()} />);

    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '始终拒绝' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '始终允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准一次' })).toBeInTheDocument();
  });

  it('点击"批准一次"提交 allow-once 决策并转为已决状态', async () => {
    // 审批请求需先入 store（respondApproval 从 pendingApprovals 取 request 记录已决结果）
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalInlineCard request={makeRequest()} />);

    fireEvent.click(screen.getByRole('button', { name: '批准一次' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'allow-once',
        reason: undefined,
      });
    });
    // 决策后本地立即移除待审批项并记录已决结果
    await waitFor(() => {
      expect(useApprovalStore.getState().pendingApprovals).toHaveLength(0);
      expect(useApprovalStore.getState().resolvedApprovals['ap-1']).toMatchObject({
        decision: 'allow-once',
      });
    });
  });

  it('点击"始终允许"提交 allow-always 决策', async () => {
    render(<ApprovalInlineCard request={makeRequest()} />);

    fireEvent.click(screen.getByRole('button', { name: '始终允许' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'allow-always',
        reason: undefined,
      });
    });
  });

  it('点击"拒绝"提交 denied 决策', async () => {
    render(<ApprovalInlineCard request={makeRequest()} />);

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'denied',
        reason: undefined,
      });
    });
  });

  it('点击"始终拒绝"提交 deny-always 决策', async () => {
    render(<ApprovalInlineCard request={makeRequest()} />);

    fireEvent.click(screen.getByRole('button', { name: '始终拒绝' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'deny-always',
        reason: undefined,
      });
    });
  });

  it('填写备注后随决策一并提交', async () => {
    render(<ApprovalInlineCard request={makeRequest()} />);

    const reasonBox = screen.getByPlaceholderText('备注（可选）') as HTMLInputElement;
    fireEvent.change(reasonBox, { target: { value: '仅本次允许' } });
    fireEvent.click(screen.getByRole('button', { name: '批准一次' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'allow-once',
        reason: '仅本次允许',
      });
    });
  });

  it('命令类工具（bash）显示命令专属信息与命令文本', () => {
    render(
      <ApprovalInlineCard request={makeRequest({ toolName: 'bash', args: { command: 'rm -rf node_modules' } })} />,
    );

    expect(screen.getByText('命令执行请求')).toBeInTheDocument();
    expect(screen.getByText('rm -rf node_modules')).toBeInTheDocument();
  });

  it('超长参数截断显示并可展开全部', () => {
    const longArgs = { blob: 'x'.repeat(600) };
    render(<ApprovalInlineCard request={makeRequest({ args: longArgs })} />);

    const expandBtn = screen.getByRole('button', { name: '展开全部' });
    expect(expandBtn).toBeInTheDocument();

    // 展开后显示完整参数，按钮切换为收起
    fireEvent.click(expandBtn);
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument();
    expect(screen.getByText(/x{600}/)).toBeInTheDocument();
  });

  it('已决状态：无决策按钮，展示决策徽标与原因', () => {
    render(
      <ApprovalInlineCard
        request={makeRequest()}
        resolved={{ request: makeRequest(), decision: 'allow-once', reason: '本次需要', resolvedAt: Date.now() }}
      />,
    );

    expect(screen.queryByRole('button', { name: '批准一次' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('备注（可选）')).not.toBeInTheDocument();
    expect(screen.getByText('已批准（本次）')).toBeInTheDocument();
    expect(screen.getByText('本次需要')).toBeInTheDocument();
  });
});

describe('ApprovalTakeover（审批接管条）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockedGet.mockResolvedValue({ approvals: [] } as never);
    mockedPost.mockResolvedValue({} as never);
  });

  it('无待审批时不渲染任何内容', () => {
    const { container } = render(<ApprovalTakeover />);
    expect(container.innerHTML).toBe('');
  });

  it('Enter 批准一次 / Esc 拒绝（键盘接管）', async () => {
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalTakeover />);

    expect(screen.getByText(/审批接管/)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'allow-once',
        reason: undefined,
      });
    });
  });

  it('Esc 提交 denied 决策', async () => {
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalTakeover />);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/approvals/ap-1', {
        decision: 'denied',
        reason: undefined,
      });
    });
  });

  it('多个待决时显示队列数', () => {
    useApprovalStore.getState().addApproval(makeRequest({ id: 'ap-1' }));
    useApprovalStore.getState().addApproval(makeRequest({ id: 'ap-2' }));
    render(<ApprovalTakeover />);

    expect(screen.getByText('待决队列 2')).toBeInTheDocument();
  });

  it('备注输入框内回车不触发批准', () => {
    useApprovalStore.getState().addApproval(makeRequest());
    render(<ApprovalTakeover />);

    // 接管条内嵌 ApprovalInlineCard 的备注输入框中回车：仅换行语义，不触发批准
    const reasonBox = screen.getByPlaceholderText('备注（可选）');
    fireEvent.keyDown(reasonBox, { key: 'Enter' });

    expect(mockedPost).not.toHaveBeenCalled();
  });
});
