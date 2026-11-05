// ChatView 组件测试：渲染消息列表 / 空状态 / 流式状态 / 新建会话
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatView } from '@/components/chat/ChatView';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useApprovalStore } from '@/stores/approval-store';
import { apiClient } from '@/services/api-client';
import type { ChatMessage } from '@/types';

vi.mock('@/services/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

// ChatInput 内部使用 useTranslation，mock 为直接返回 key
vi.mock('react-i18next', async () => ({
  ...await vi.importActual<typeof import('react-i18next')>('react-i18next'),
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);

const msg = (id: string, role: ChatMessage['role'], content: string): ChatMessage => ({
  id,
  role,
  content,
  timestamp: Date.now(),
});

const resetStores = (): void => {
  useChatStore.getState().clear();
  useApprovalStore.getState().clear();
  useChatStore.setState({
    messages: [],
    isStreaming: false,
    streamingContent: '',
    streamingSessionId: null,
    toolCalls: {},
  });
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    loading: false,
    error: null,
  });
};

describe('ChatView', () => {
  it('removes a completed approval from the composer and pinned stack, retaining its history', async () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    useApprovalStore.getState().addApproval({ id: 'approval-one', sessionId: 's1', toolName: 'file-write', args: {}, reason: 'write', timestamp: Date.now() });
    mockedPost.mockResolvedValue({});
    render(<MemoryRouter><ChatView /></MemoryRouter>);
    expect(screen.getByText('等待审批')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '始终允许' }));
    await waitFor(() => expect(screen.queryByText('等待审批')).toBeNull());
    expect(screen.queryByText(/已批准/)).toBeNull();
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(useApprovalStore.getState().resolvedApprovals['approval-one'].decision).toBe('allow-always');
  });

  it('another session approval does not replace the current composer', async () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    render(<MemoryRouter><ChatView /></MemoryRouter>);
    act(() => useApprovalStore.getState().addApproval({ id: 'other', sessionId: 's2', toolName: 'file-write', args: {}, reason: 'other', timestamp: Date.now() }));
    expect(screen.queryByText('等待审批')).toBeNull();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });
  beforeAll(() => {
    // @tanstack/react-virtual 依赖 ResizeObserver / scrollTo，jsdom 无实现。
    // observe 时立即上报视口尺寸，否则虚拟列表因高度 0 不渲染任何行。
    globalThis.ResizeObserver = class {
      private readonly cb: (entries: Array<{ borderBoxSize: Array<{ inlineSize: number; blockSize: number }> }>) => void;
      constructor(cb: (entries: Array<{ borderBoxSize: Array<{ inlineSize: number; blockSize: number }> }>) => void) {
        this.cb = cb;
      }
      observe(target: Element): void {
        this.cb([{ target, borderBoxSize: [{ inlineSize: 600, blockSize: 800 }] } as never]);
      }
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollTo = (): void => {};
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    mockedGet.mockResolvedValue([]);
  });

  it('空状态：无消息时显示欢迎区与快捷按钮（新会话入口已移至会话侧栏）', () => {
    render(
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>,
    );

    // react-i18next 被 mock 为 t(key)=key，空态文案为 i18n key
    expect(screen.getByText('workbench.headline')).toBeInTheDocument();
    expect(screen.getByText('workbench.description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workbench.officeTitle/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workbench.channelsTitle/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workbench.browserTitle/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workbench.designTitle/ })).toBeInTheDocument();
  });

  it('空态卡片先填写可编辑草稿，不直接调用模型', async () => {
    // 无当前会话时先建会话再发送
    mockedPost.mockImplementation(async (path: string) => {
      if (path === '/sessions') {
        return { id: 's-quick', title: '快捷会话', createdAt: 1, updatedAt: 1, messageCount: 0 } as never;
      }
      return {} as never;
    });

    render(
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /workbench.officeTitle/ }));
    expect(screen.getByRole('textbox')).toHaveValue('workbench.officePrompt');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('渲染用户与助手消息列表', async () => {
    // useChat 在 currentSessionId 存在时通过 /sessions/:id/messages 加载历史
    mockedGet.mockImplementation(async (path: string) => {
      if (path === '/sessions/s-1/messages') {
        return [
          msg('m-1', 'user', '你好，帮我看看代码'),
          msg('m-2', 'assistant', '好的，这是**分析结果**'),
        ];
      }
      return [];
    });
    useSessionStore.setState({ currentSessionId: 's-1' });

    render(
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>,
    );

    expect(await screen.findByText('你好，帮我看看代码')).toBeInTheDocument();
    // assistant 消息经 MarkdownRenderer 渲染（含加粗）
    expect(await screen.findByText('分析结果')).toBeInTheDocument();
    expect(screen.getByText('分析结果').tagName).toBe('STRONG');
  });

  it('流式响应中：显示停止按钮且输入框禁用', () => {
    useSessionStore.setState({currentSessionId: 'stream-view'});
    useChatStore.setState({
      messages: [msg('m-1', 'user', 'go')],
      isStreaming: true,
      streamingContent: '正在生成的流式内容',
    });

    render(
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>,
    );

    expect(screen.getByText('chat.stop')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
    // 流式内容作为临时助手消息展示
    expect(screen.getByText('正在生成的流式内容')).toBeInTheDocument();
  });

  it('非流式状态：无停止按钮且输入框可用', () => {
    render(
      <MemoryRouter>
        <ChatView />
      </MemoryRouter>,
    );

    expect(screen.queryByText('chat.stop')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });
});
