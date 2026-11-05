// 聊天全链路集成测试（设计 §7.3）：
// ChatInput 发送 → useChat.sendMessage → POST /sessions + /chat/send →
// chat-store 更新（用户消息 + isStreaming）→ MessageList 渲染 →
// WS chat_stream 帧驱动流式内容累积 → done 后助手消息落库并解除输入禁用
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatView } from '@/components/chat/ChatView';
import { useWebSocket } from '@/hooks/use-websocket';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { apiClient } from '@/services/api-client';
import { wsClient } from '@/services/ws-client';

vi.mock('@/services/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

// ws-client mock：本地事件总线，__emit 模拟后端推送
type Handler = (e: { type: string; data: any }) => void;
const handlers = new Map<string, Handler[]>();
vi.mock('@/services/ws-client', () => ({
  wsClient: {
    on: vi.fn((type: string, cb: Handler) => {
        handlers.set(type, [...(handlers.get(type) ?? []), cb]);
        return () => {
          handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== cb));
        };
      }),
    onStatus: vi.fn(() => () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    send: vi.fn(),
    getStatus: vi.fn(() => 'connected'),
  },
}));

vi.mock('react-i18next', async () => ({
  ...await vi.importActual<typeof import('react-i18next')>('react-i18next'),
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);

/** 模拟后端经 WS 推送事件 */
function emitWs(type: string, data: unknown): void {
  act(() => {
    for (const cb of handlers.get(type) ?? []) cb({ type, data: {sessionId: 's-1', ...(data as object)} });
  });
}

/** 集成测试脚手架：真实 App 结构为 useWebSocket（根）+ ChatView，此处同构组合 */
function Harness() {
  useWebSocket();
  return (
    <MemoryRouter>
      <ChatView />
    </MemoryRouter>
  );
}

const SESSION = { id: 's-1', title: '集成会话', createdAt: 1, updatedAt: 1, messageCount: 0 };

describe('聊天全链路集成', () => {
  beforeAll(() => {
    // @tanstack/react-virtual 依赖 ResizeObserver / scrollTo（对齐 ChatView.test 的 stub）
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
    handlers.clear();
    useChatStore.getState().clear();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      loading: false,
      error: null,
    });
    mockedGet.mockImplementation(async (path: string) => path.endsWith('/messages') ? undefined : []);
    // /sessions 创建与 /chat/send 均成功
    mockedPost.mockImplementation(async (path: string) => {
      if (path === '/sessions') return SESSION;
      return { success: true };
    });
  });

  it('全链路：输入发送→建会话→用户消息入store并渲染→WS流式帧累积→done落库', async () => {
    // /chat/send 为非流式长请求（生成完才返回，期间经 WS 推送流式帧），
    // 挂起以模拟生成进行中：流式状态由 startStream 置位、由 WS done 帧解除
    let finish!: (value: unknown) => void;
    mockedPost.mockImplementation((path: string) => {
      if (path === '/sessions') return Promise.resolve(SESSION) as never;
      return new Promise(resolve => {finish = resolve;}) as never;
    });
    render(<Harness />);

    // 1. 输入并发送
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '帮我分析这段代码' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));

    // 2. 无当前会话 → 先建会话（POST /sessions），再发消息（POST /chat/send）
    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/sessions', {});
    });
    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith(
        '/chat/send',
        expect.objectContaining({ session: 's-1', message: '帮我分析这段代码', stream: true }),
        expect.objectContaining({ timeoutMs: 0 }),
      );
    });

    // 3. 用户消息已入 store 并渲染
    const state = useChatStore.getState();
    expect(state.messages.some((m) => m.role === 'user' && m.content === '帮我分析这段代码')).toBe(
      true,
    );
    expect(await screen.findByText('帮我分析这段代码')).toBeInTheDocument();

    // 4. 流式中：输入禁用
    await waitFor(() => {
      expect(useChatStore.getState().isStreaming).toBe(true);
    });
    expect(screen.getByRole('textbox')).toBeDisabled();

    // 5. WS 流式帧驱动内容累积并渲染
    emitWs('chat_stream', { content: '好的，' });
    emitWs('chat_stream', { content: '这是分析。' });
    expect(await screen.findByText('好的，这是分析。')).toBeInTheDocument();

    // 6. done 帧：助手消息落库、流结束、输入恢复
    emitWs('chat_stream', { content: '', done: true, message: {id: 'final', role: 'assistant', content: '好的，这是分析。', timestamp: 1} });
    await waitFor(() => {
      expect(useChatStore.getState().isStreaming).toBe(false);
    });
    const finalState = useChatStore.getState();
    const assistantMsg = finalState.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('好的，这是分析。');
    expect(screen.getByRole('textbox')).toBeEnabled();
    await act(async () => {finish({}); await Promise.resolve();});
  });

  it('已有当前会话：不重复建会话，直接携带 session 发送', async () => {
    useSessionStore.setState({ sessions: [SESSION], currentSessionId: 's-1' });
    render(<Harness />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith(
        '/chat/send',
        expect.objectContaining({ session: 's-1', message: '继续' }),
        expect.anything(),
      );
    });
    expect(mockedPost).not.toHaveBeenCalledWith('/sessions', {});
    expect(await screen.findByText('继续')).toBeInTheDocument();
  });

  it('发送失败：落错误提示消息并解除流式锁定', async () => {
    mockedPost.mockImplementation(async (path: string) => {
      if (path === '/sessions') return SESSION;
      throw new Error('后端超时');
    });

    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '会失败的消息' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));

    await waitFor(() => {
      expect(useChatStore.getState().isStreaming).toBe(false);
    });
    // 错误提示作为 assistant 消息渲染
    expect(await screen.findByText(/发送失败：后端超时/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });
});
