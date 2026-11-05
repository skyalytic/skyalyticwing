// AgentCenterPage 测试：代理详情面板（信箱/标记已读/发消息/对话历史）
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AgentCenterPage } from '@/modules/agents/AgentCenterPage';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';

vi.mock('react-i18next', async () => ({
  ...await vi.importActual<typeof import('react-i18next')>('react-i18next'),
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/components/modals/ConfirmDialog', () => ({
  showConfirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/services/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/components/ui/Toast', () => ({
  toast: {
    show: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    remove: vi.fn(),
  },
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);
const mockedToastError = vi.mocked(toast.error);

function agentMessage(over: Partial<{ id: string; from: string; content: string; read: boolean }> = {}) {
  return {
    id: over.id ?? 'msg-1',
    from: over.from ?? 'main',
    fromName: over.from === 'coder' ? '代码助手' : '主代理',
    to: over.from === 'coder' ? 'main' : 'coder',
    toName: over.from === 'coder' ? '主代理' : '代码助手',
    content: over.content ?? 'hello agent',
    type: 'text',
    timestamp: Date.now() - 60_000,
    read: over.read ?? false,
    ...over,
  };
}

const AGENTS = [{ id: 'coder', name: '代码助手', type: 'code', status: 'idle' }];

describe('AgentCenterPage 详情面板', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // apiClient 自动解包 ApiResponse：get 直接返回 data
    mockedGet.mockImplementation((url: string) => {
      if (url === '/agents') return Promise.resolve(AGENTS) as never;
      if (url === '/agents/teams') return Promise.resolve([]) as never;
      if (url === '/models') return Promise.resolve({ models: [] }) as never;
      if (url === '/agents/coder/workspace') return Promise.resolve(null) as never;
      if (url === '/agents/inbox/coder')
        return Promise.resolve({
          agentId: 'coder',
          messages: [agentMessage()],
          unreadCount: 1,
        }) as never;
      if (url === '/agents/conversation?agent1=main&agent2=coder')
        return Promise.resolve({
          agent1: 'main',
          agent2: 'coder',
          messages: [agentMessage({ read: true })],
        }) as never;
      return Promise.resolve(null) as never;
    });
    mockedPost.mockResolvedValue({} as never);
  });

  /** 打开 coder 详情弹窗并展开信箱 / 对话区 */
  async function openDetailWithMessenger() {
    render(
      <MemoryRouter>
        <AgentCenterPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('代码助手')).toBeInTheDocument();
    });
    // 点击智能体行打开详情弹窗（行式列表，整行可点）
    fireEvent.click(screen.getByText('代码助手'));
    // 详情弹窗信息卡（仅弹窗内渲染）
    await waitFor(() => {
      expect(screen.getByText('智能体 ID')).toBeInTheDocument();
    });
    // 展开「信箱 / 对话」折叠区（加载信箱与对话历史）
    fireEvent.click(screen.getByRole('button', { name: /信箱 \/ 对话/ }));
    await waitFor(() => {
      expect(screen.getByText('hello agent')).toBeInTheDocument();
    });
  }

  it('点击智能体行打开详情弹窗并加载信箱与对话', async () => {
    await openDetailWithMessenger();

    // 信箱与对话历史经 loadMessenger 拉取
    expect(mockedGet).toHaveBeenCalledWith('/agents/inbox/coder');
    expect(mockedGet).toHaveBeenCalledWith('/agents/conversation?agent1=main&agent2=coder');
  });

  it('输入消息并发送：POST /agents/message 并清空输入', async () => {
    await openDetailWithMessenger();

    const input = screen.getByPlaceholderText('以 main 身份发消息给该智能体…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '去写个脚本' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/agents/message', {
        from: 'main',
        to: 'coder',
        message: '去写个脚本',
      });
    });
    // 发送期间信箱区显示「加载中…」会卸载输入框，加载完成后输入框重新挂载且已清空
    await waitFor(() => {
      const fresh = screen.getByPlaceholderText('以 main 身份发消息给该智能体…') as HTMLInputElement;
      expect(fresh.value).toBe('');
    });
  });

  it('空消息点击发送不调用接口', async () => {
    await openDetailWithMessenger();

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // sendAgentMessage 对空消息直接 return
    expect(mockedPost).not.toHaveBeenCalledWith('/agents/message', expect.anything());
  });

  it('创建智能体：POST /agents 成功后关闭弹窗并刷新列表', async () => {
    render(
      <MemoryRouter>
        <AgentCenterPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('代码助手')).toBeInTheDocument();
    });

    // 页头「创建」按钮打开创建弹窗（列表非空时页头是唯一的「创建」按钮）
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    const nameInput = screen.getByPlaceholderText('请输入智能体名称') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '新助手' } });
    // 弹窗提交按钮与页头同名，取弹窗内（DOM 靠后）的一个
    const createButtons = screen.getAllByRole('button', { name: '创建' });
    fireEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/agents', expect.objectContaining({ name: '新助手' }));
    });
    // 提交成功后弹窗关闭
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('请输入智能体名称')).not.toBeInTheDocument();
    });
  });

  it('创建智能体失败：toast 错误且弹窗保留', async () => {
    mockedPost.mockImplementation((url: string) => {
      if (url === '/agents') return Promise.reject(new Error('agent already exists'));
      return Promise.resolve({} as never);
    });

    render(
      <MemoryRouter>
        <AgentCenterPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('代码助手')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    const nameInput = screen.getByPlaceholderText('请输入智能体名称') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'dup' } });
    const createButtons = screen.getAllByRole('button', { name: '创建' });
    fireEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('common.saveFailed', 'agent already exists');
    });
    // 失败时弹窗保留
    expect(screen.getByPlaceholderText('请输入智能体名称')).toBeInTheDocument();
  });
});
