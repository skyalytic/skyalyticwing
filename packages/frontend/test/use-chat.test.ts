// useChat hook 测试：发送消息 / 会话创建 / 流式状态 / 停止 / 失败兜底 / 历史加载
import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '@/hooks/use-chat';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { apiClient } from '@/services/api-client';

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

const resetStores = (): void => {
  useChatStore.getState().clear();
  useChatStore.setState({
    messages: [],
    isStreaming: false,
    streamingContent: '',
    streamingSessionId: null,
    messagesSessionId: null,
    toolCalls: {},
  });
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    loading: false,
    error: null,
  });
};

describe('useChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    mockedGet.mockResolvedValue([]);
    mockedPost.mockResolvedValue({} as never);
  });

  it('初始状态：无消息、非流式', () => {
    const { result } = renderHook(() => useChat());

    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingContent).toBe('');
  });

  it('空白内容不发送', async () => {
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage('   ');
    });

    expect(mockedPost).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('sends an annotation-only message as an attachment without copying context into the bubble', async () => {
    useSessionStore.setState({currentSessionId:'annotation-session'});
    const attachment = {type:'file' as const, name:'网页批注 · 按钮', mimeType:'text/x-wing-browser-annotation', url:'data:text/x-wing-browser-annotation;base64,Y29udGV4dA=='};
    const {result}=renderHook(()=>useChat());
    await act(async()=>{await result.current.sendMessage(' ',[attachment]);});
    expect(mockedPost).toHaveBeenCalledWith('/chat/send',expect.objectContaining({message:'',attachments:[attachment]}),expect.anything());
    // The backend transcript is authoritative after completion; payload ownership is checked above.
  });

  it('passes an explicitly selected model to the backend even with an active agent', async () => {
    useSessionStore.setState({ currentSessionId: 's-selected-model', currentAgentId: 'custom-agent' });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.sendMessage('使用所选模型', undefined, 'wing/selected'); });
    expect(mockedPost).toHaveBeenCalledWith('/chat/send', expect.objectContaining({
      session: 's-selected-model', model: 'wing/selected', agent: 'custom-agent',
    }), expect.anything());
    useSessionStore.setState({ currentAgentId: null });
  });

  it('发送消息：追加用户消息、POST /chat/send（stream:true）并进入流式状态', async () => {
    useSessionStore.setState({ currentSessionId: 's-1' });
    // /chat/send 挂起为受控 promise：发送进行中验证流式状态，返回后验证兜底结束
    let resolveSend!: (v: unknown) => void;
    mockedPost.mockImplementation((path: string) => {
      if (path === '/chat/send') {
        return new Promise((r) => {
          resolveSend = r;
        }) as never;
      }
      return Promise.resolve({} as never);
    });

    const { result } = renderHook(() => useChat());

    // 先让挂载时的历史加载 effect（loadMessages → setMessages）完成，
    // 避免其异步覆盖本次发送追加的用户消息
    await act(async () => {
      await Promise.resolve();
    });

    let sending: Promise<void> = Promise.resolve();
    act(() => {
      sending = result.current.sendMessage('你好');
    });
    // 推进微任务链至 /chat/send 已发出（startStream 已置位）
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    // 用户消息已入列
    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好' });

    // 请求体
    expect(mockedPost).toHaveBeenCalledWith(
      '/chat/send',
      expect.objectContaining({ session: 's-1', message: '你好', stream: true }),
      expect.objectContaining({ timeoutMs: 0 }),
    );

    // 发送进行中：流式状态由 startStream 置位
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().streamingSessionId).toBe('s-1');

    // /chat/send 返回（生成结束）：兜底结束流式，防止 WS 事件丢失/迟到时 isStreaming 卡死
    resolveSend({});
    await act(async () => {
      await sending;
    });
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('无当前会话时先创建会话再用新 id 发送', async () => {
    mockedPost.mockImplementation(async (path: string) => {
      if (path === '/sessions') {
        return {
          id: 's-created',
          title: 'Session',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
        } as never;
      }
      return {} as never;
    });

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage('第一条消息');
    });

    expect(mockedPost).toHaveBeenCalledWith('/sessions', {});
    expect(mockedPost).toHaveBeenCalledWith(
      '/chat/send',
      expect.objectContaining({ session: 's-created' }),
      expect.anything(),
    );
    expect(useSessionStore.getState().currentSessionId).toBe('s-created');
  });

  it('创建会话失败时中止发送', async () => {
    mockedPost.mockImplementation(async (path: string) => {
      if (path === '/sessions') throw new Error('boom');
      return {} as never;
    });

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(mockedPost).toHaveBeenCalledTimes(1); // 仅 /sessions
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('发送失败：清除流式状态并追加"发送失败"助手消息', async () => {
    useSessionStore.setState({ currentSessionId: 's-1' });
    mockedPost.mockImplementation(async (path: string) => {
      if (path === '/chat/send') throw new Error('网络不可用');
      return {} as never;
    });

    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    const state = useChatStore.getState();
    expect(state.isStreaming).toBe(false);
    const failure = state.messages.find((m) => m.role === 'system');
    expect(failure?.content).toBe('发送失败：网络不可用');
  });

  it('stop waits for backend completion and only targets the selected session', async () => {
    useSessionStore.setState({currentSessionId: 'stop-session'});
    let finish!: (value: unknown) => void;
    mockedPost.mockImplementation((path: string) => path === '/chat/send'
      ? new Promise(resolve => {finish = resolve;}) as never : Promise.resolve({}) as never);
    const {result} = renderHook(() => useChat());
    let pending!: Promise<void>;
    act(() => {pending = result.current.sendMessage('slow');});
    act(() => result.current.stopStreaming());
    expect(mockedPost).toHaveBeenCalledWith('/chat/stop', {sessionId: 'stop-session'});
    expect(result.current.isStopping).toBe(true);
    expect(result.current.isStreaming).toBe(true);
    await act(async () => {finish({}); await pending;});
    expect(result.current.isStopping).toBe(false);
    expect(result.current.isStreaming).toBe(false);
  });

  it('切换会话时加载历史消息', async () => {
    const history = [
      { id: 'h1', role: 'assistant' as const, content: '历史回复', timestamp: 1 },
      { id: 'h2', role: 'user' as const, content: '历史提问', timestamp: 2 },
    ];
    mockedGet.mockResolvedValue(history as never);

    const { result } = renderHook(() => useChat());

    act(() => {
      useSessionStore.getState().selectSession('s-9');
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });
    expect(mockedGet).toHaveBeenCalledWith('/sessions/s-9/messages');
    expect(result.current.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('clearing selection removes the visible projection', async () => {
    useSessionStore.setState({currentSessionId: 'selection'});
    mockedGet.mockImplementation(async (path: string) => path.includes('/messages')
      ? [{id: 'm1', role: 'user', content: 'x', timestamp: 1}] as never : {active: false} as never);
    const {result} = renderHook(() => useChat());
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    act(() => useSessionStore.setState({currentSessionId: null}));
    expect(result.current.messages).toHaveLength(0);
  });
});


describe('concurrent session regression', () => {
  beforeEach(() => {vi.clearAllMocks(); resetStores(); mockedGet.mockResolvedValue(undefined);});
  it('A keeps running while B sends; A completion and errors never overwrite B', async () => {
    const finish = new Map<string, (value: unknown) => void>();
    mockedPost.mockImplementation((path: string, body: any) => path === '/chat/send'
      ? new Promise(resolve => finish.set(body.session, resolve)) as never : Promise.resolve({}) as never);
    useSessionStore.setState({currentSessionId: 'parallel-A'});
    const {result} = renderHook(() => useChat());
    let a!: Promise<void>, b!: Promise<void>;
    act(() => {a = result.current.sendMessage('topic A');});
    act(() => useSessionStore.getState().selectSession('parallel-B'));
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages).toEqual([]);
    act(() => {b = result.current.sendMessage('topic B');});
    expect(finish.size).toBe(2);
    await act(async () => {finish.get('parallel-A')!({message: {id: 'a-final', role: 'assistant', content: 'answer A', timestamp: 1}}); await a;});
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.map(m => m.content)).toEqual(['topic B']);
    await act(async () => {finish.get('parallel-B')!({message: {id: 'b-final', role: 'assistant', content: 'answer B', timestamp: 2}}); await b;});
    act(() => useSessionStore.getState().selectSession('parallel-A'));
    expect(result.current.messages.map(m => m.content)).toEqual(['topic A', 'answer A']);
    expect(result.current.isStreaming).toBe(false);
  });
  it('stop after switching targets B, leaves A active and waits for B to release', async () => {
    const finish = new Map<string, (value: unknown) => void>();
    mockedPost.mockImplementation((path: string, body: any) => path === '/chat/send'
      ? new Promise(resolve => finish.set(body.session, resolve)) as never : Promise.resolve({}) as never);
    useSessionStore.setState({currentSessionId: 'stop-A'});
    const {result} = renderHook(() => useChat());
    let a!: Promise<void>, b!: Promise<void>;
    act(() => {a = result.current.sendMessage('A');});
    act(() => useSessionStore.getState().selectSession('stop-B'));
    act(() => {b = result.current.sendMessage('B');});
    act(() => result.current.stopStreaming());
    expect(mockedPost).toHaveBeenCalledWith('/chat/stop', {sessionId: 'stop-B'});
    expect(result.current.isStopping).toBe(true);
    await act(async () => {finish.get('stop-B')!({}); await b;});
    expect(result.current.isStreaming).toBe(false);
    act(() => useSessionStore.getState().selectSession('stop-A'));
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isStopping).toBe(false);
    await act(async () => {finish.get('stop-A')!({}); await a;});
  });
});
