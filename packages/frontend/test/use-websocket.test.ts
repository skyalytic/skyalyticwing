// useWebSocket hook 测试：连接生命周期 / 事件路由到各 store
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from '@/hooks/use-websocket';
import { wsClient } from '@/services/ws-client';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useApprovalStore } from '@/stores/approval-store';
import { useConnectionStore } from '@/stores/connection-store';
import { toast } from '@/components/ui/Toast';
import type { WsEvent, ToolApprovalRequest, ChatMessage } from '@/types';

type Handler = (event: WsEvent) => void;
type StatusHandler = (status: 'connected' | 'disconnected' | 'reconnecting', attempts: number) => void;

const state = vi.hoisted(() => ({
  handlers: new Map<string, Set<unknown>>(),
  statusHandlers: new Set<unknown>(),
}));

vi.mock('@/services/ws-client', () => ({
  wsClient: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    send: vi.fn(),
    getStatus: vi.fn(() => 'connected'),
    on: vi.fn((type: string, cb: unknown) => {
      if (!state.handlers.has(type)) state.handlers.set(type, new Set());
      state.handlers.get(type)?.add(cb);
      return () => {
        state.handlers.get(type)?.delete(cb);
      };
    }),
    onStatus: vi.fn((cb: unknown) => {
      state.statusHandlers.add(cb);
      return () => {
        state.statusHandlers.delete(cb);
      };
    }),
  },
}));

vi.mock('@/components/ui/Toast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** 触发指定类型的事件（模拟服务端推送） */
const emit = (type: string, event: WsEvent): void => {
  if (['chat_message', 'chat_stream', 'tool_call', 'tool_result'].includes(type))
    event = {...event, data: {sessionId: 's1', ...event.data}} as WsEvent;
  for (const h of state.handlers.get(type) ?? []) {
    (h as Handler)(event);
  }
};

const emitStatus = (
  status: 'connected' | 'disconnected' | 'reconnecting',
  attempts: number,
): void => {
  for (const h of state.statusHandlers) {
    (h as StatusHandler)(status, attempts);
  }
};

const message = (id: string, content: string): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: Date.now(),
});

const approval = (id: string): ToolApprovalRequest => ({
  id,
  toolName: 'bash',
  args: { command: 'ls' },
  sessionId: 's1',
  reason: 'dangerous',
  timestamp: Date.now(),
});

const resetStores = (): void => {
  useChatStore.getState().clear();
  useChatStore.setState({
    messages: [],
    isStreaming: false,
    streamingContent: '',
    streamingSessionId: null,
    toolCalls: {},
  });
  useSessionStore.setState({ currentSessionId: 's1' });
  useChatStore.getState().activateSession('s1');
  useApprovalStore.setState({ pendingApprovals: [], approvalsHistory: [] });
  useConnectionStore.setState({
    status: 'disconnected',
    reconnectAttempts: 0,
    lastConnectedAt: null,
  });
};

describe('useWebSocket', () => {
  it('shows progress immediately without unlocking the turn, then deduplicates the final message', () => {
    renderHook(() => useWebSocket());
    const draft: ChatMessage = {...message('draft', '先检查文件'), turnId:'turn-live', turnSequence:1, phase:'progress', streaming:true};
    act(() => {
      useChatStore.getState().addMessage({...message('turn-live:user','检查'),role:'user',turnId:'turn-live',turnSequence:0});
      useChatStore.getState().startStream('s1');
      emit('chat_stream',{type:'chat_stream',data:{sessionId:'s1',content:'',done:false,message:draft}});
    });
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('先检查文件');
    act(() => emit('chat_message',{type:'chat_message',data:{...draft,streaming:false}}));
    expect(useChatStore.getState().isStreaming).toBe(true);
    const final:ChatMessage={...message('final','检查完成'),turnId:'turn-live',turnSequence:3,phase:'final',streaming:false};
    act(() => {emit('chat_message',{type:'chat_message',data:final});emit('chat_message',{type:'chat_message',data:final});});
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages.filter(m=>m.id==='final')).toHaveLength(1);
    act(() => {
      useChatStore.getState().addMessage({...message('new:user','继续'),role:'user',turnId:'new',turnSequence:0});
      useChatStore.getState().startStream('s1');
      emit('chat_message',{type:'chat_message',data:final});
    });
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it('keeps A subscribed and preserves its tool result while viewing B', () => {
    useSessionStore.setState({currentSessionId: 's1'});
    renderHook(() => useWebSocket());
    act(() => {
      useChatStore.getState().startStream('s1');
      emit('tool_call', {type: 'tool_call', data: {sessionId: 's1', callId: 'switch-call', toolName: 'powershell', args: {command: 'test'}}});
      useSessionStore.getState().selectSession('s2');
    });
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(wsClient.send).not.toHaveBeenCalledWith('unsubscribe', {sessionId: 's1'});
    act(() => emit('tool_result', {type: 'tool_result', data: {sessionId: 's1', callId: 'switch-call', toolName: 'powershell', result: {success: true, output: 'finished A'}}}));
    expect(useChatStore.getState().messages).toEqual([]);
    act(() => useSessionStore.getState().selectSession('s1'));
    expect(useChatStore.getState().messages[0].content).toBe('finished A');
    expect(useChatStore.getState().toolCalls['switch-call']).toMatchObject({status: 'success', args: {command: 'test'}});
    expect(useChatStore.getState().isStreaming).toBe(true);
  });
  it('identical provider call IDs in different sessions still produce separate tool cards', () => {
    useSessionStore.setState({currentSessionId: 's1'});
    renderHook(() => useWebSocket());
    act(() => {
      emit('tool_call', {type: 'tool_call', data: {sessionId: 's1', callId: 'call-0', toolName: 'powershell', args: {command: 'A'}}});
      useSessionStore.getState().selectSession('s2');
      useSessionStore.getState().selectSession('s1');
      emit('tool_call', {type: 'tool_call', data: {sessionId: 's2', callId: 'call-0', toolName: 'powershell', args: {command: 'B'}}});
      useSessionStore.getState().selectSession('s1');
      emit('tool_call', {type: 'tool_call', data: {sessionId: 's2', callId: 'call-1', toolName: 'node', args: {code: 'B'}}});
    });
    expect(useChatStore.getState().toolCalls['call-0'].args).toEqual({command: 'A'});
    act(() => useSessionStore.getState().selectSession('s2'));
    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(useChatStore.getState().toolCalls['call-0'].args).toEqual({command: 'B'});
  });
  it('reconstructs tool arguments and status from the persisted transcript', () => {
    useChatStore.getState().activateSession('history');
    useChatStore.getState().mergeHistory('history', [
      {id: 'a', role: 'assistant', content: '', timestamp: 1, toolCalls: [{id: 'c', type: 'function', function: {name: 'powershell', arguments: '{"command":"ls"}'}}]},
      {id: 't', role: 'tool', toolCallId: 'c', toolName: 'powershell', content: '{"success":false,"error":"cancelled"}', timestamp: 2},
    ]);
    expect(useChatStore.getState().toolCalls.c).toMatchObject({args: {command: 'ls'}, status: 'error', result: {error: 'cancelled'}});
    expect(useChatStore.getState().messages.filter(m => m.toolCallId === 'c')).toHaveLength(1);
  });
  it('refreshes the current project for tool results and ignores results from other sessions', () => {
    useSessionStore.setState({ currentSessionId: 's1' });
    useProjectPanel.setState({ treeVersion: 0 });
    renderHook(() => useWebSocket());
    act(() => emit('tool_result', { type: 'tool_result', data: { sessionId: 's2', toolName: 'file-write', callId: 'other', result: { success: true } } }));
    expect(useProjectPanel.getState().treeVersion).toBe(0);
    act(() => emit('tool_result', { type: 'tool_result', data: { sessionId: 's1', toolName: 'powershell', callId: 'current', result: { success: false, error: 'partial write' } } }));
    expect(useProjectPanel.getState().treeVersion).toBe(1);
    act(() => emit('chat_stream', { type: 'chat_stream', data: { sessionId: 's1', content: '', done: true } }));
    expect(useProjectPanel.getState().treeVersion).toBe(2);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    state.handlers.clear();
    state.statusHandlers.clear();
    resetStores();
  });

  it('挂载时建立连接并注册事件订阅', () => {
    renderHook(() => useWebSocket());

    expect(wsClient.connect).toHaveBeenCalledTimes(1);
    const registeredTypes = vi.mocked(wsClient.on).mock.calls.map((c) => c[0]);
    expect(registeredTypes).toEqual(
      expect.arrayContaining([
        'chat_message',
        'chat_stream',
        'tool_call',
        'tool_result',
        'agent_message',
        'subagent_completed',
        'approval_request',
      ]),
    );
    expect(wsClient.onStatus).toHaveBeenCalled();
  });

  it('卸载时断开连接并退订全部事件', () => {
    const { unmount } = renderHook(() => useWebSocket());

    unmount();

    expect(wsClient.disconnect).toHaveBeenCalledTimes(1);
    // 退订后再推送事件不应影响 store
    emit('chat_message', { type: 'chat_message', data: message('m-x', 'x') });
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('reconnect() 委托 wsClient.reconnect', () => {
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      result.current.reconnect();
    });

    expect(wsClient.reconnect).toHaveBeenCalledTimes(1);
  });

  describe('连接状态路由', () => {
    it('connected → 更新状态并记录连接时间', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emitStatus('connected', 0);
      });

      const conn = useConnectionStore.getState();
      expect(conn.status).toBe('connected');
      expect(conn.reconnectAttempts).toBe(0);
      expect(conn.lastConnectedAt).not.toBeNull();
    });

    it('reconnecting → 更新状态与重试次数', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emitStatus('reconnecting', 3);
      });

      const conn = useConnectionStore.getState();
      expect(conn.status).toBe('reconnecting');
      expect(conn.reconnectAttempts).toBe(3);
    });
  });

  describe('chat_message：完整消息落库', () => {
    it('追加助手消息到聊天 store', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('chat_message', { type: 'chat_message', data: message('m-1', '完整回复') });
      });

      expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['完整回复']);
    });

    it('按 id 去重', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('chat_message', { type: 'chat_message', data: message('m-1', 'a') });
        emit('chat_message', { type: 'chat_message', data: message('m-1', 'a') });
      });

      expect(useChatStore.getState().messages).toHaveLength(1);
    });
  });

  describe('chat_stream：流式增量', () => {
    it('增量内容累积且自动进入流式状态', () => {
      // 事件带 sessionId 时按当前会话过滤（多会话并行防串扰），先选中该会话
      useSessionStore.setState({ currentSessionId: 's1' });
      renderHook(() => useWebSocket());

      act(() => {
        emit('chat_stream', {
          type: 'chat_stream',
          data: { sessionId: 's1', content: '你', done: false },
        });
        emit('chat_stream', {
          type: 'chat_stream',
          data: { sessionId: 's1', content: '好', done: false },
        });
      });

      const store = useChatStore.getState();
      expect(store.isStreaming).toBe(true);
      expect(store.streamingContent).toBe('你好');
    });

    it('done=true：累积内容落为助手消息并清空流式状态', () => {
      useSessionStore.setState({ currentSessionId: 's1' });
      renderHook(() => useWebSocket());

      act(() => {
        emit('chat_stream', {
          type: 'chat_stream',
          data: { sessionId: 's1', content: '流式内容', done: false },
        });
        emit('chat_stream', {
          type: 'chat_stream',
          data: { sessionId: 's1', content: '', done: true, message: message('final', '流式内容') },
        });
      });

      const store = useChatStore.getState();
      expect(store.isStreaming).toBe(false);
      expect(store.streamingContent).toBe('');
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]).toMatchObject({ role: 'assistant', content: '流式内容' });
    });

    it('空流结束时不清空已有消息、不落空消息', () => {
      useSessionStore.setState({ currentSessionId: 's1' });
      renderHook(() => useWebSocket());

      act(() => {
        emit('chat_stream', {
          type: 'chat_stream',
          data: { sessionId: 's1', content: '', done: true },
        });
      });

      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });

  describe('tool_call / tool_result：工具调用状态', () => {
    it('tool_call 登记运行中状态并落一条 tool 消息', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('tool_call', {
          type: 'tool_call',
          data: { toolName: 'file-read', args: { path: 'a.txt' }, callId: 'c1' },
        });
      });

      const store = useChatStore.getState();
      expect(store.toolCalls['c1']).toMatchObject({
        toolName: 'file-read',
        status: 'running',
      });
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]).toMatchObject({
        id: 'tool-c1',
        role: 'tool',
        toolName: 'file-read',
        toolCallId: 'c1',
      });
    });

    it('同一 callId 重复推送不重复落消息', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('tool_call', {
          type: 'tool_call',
          data: { toolName: 'bash', args: {}, callId: 'c1' },
        });
        emit('tool_call', {
          type: 'tool_call',
          data: { toolName: 'bash', args: {}, callId: 'c1' },
        });
      });

      expect(useChatStore.getState().messages).toHaveLength(1);
    });

    it('tool_result 更新状态为 success 并回填消息内容', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('tool_call', {
          type: 'tool_call',
          data: { toolName: 'grep', args: { pattern: 'x' }, callId: 'c1' },
        });
        emit('tool_result', {
          type: 'tool_result',
          data: {
            toolName: 'grep',
            callId: 'c1',
            result: { success: true, output: '匹配 3 行' },
          },
        });
      });

      const store = useChatStore.getState();
      expect(store.toolCalls['c1']?.status).toBe('success');
      expect(store.toolCalls['c1']?.result?.output).toBe('匹配 3 行');
      expect(store.messages[0]?.content).toBe('匹配 3 行');
    });

    it('失败的 tool_result 状态为 error', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('tool_call', {
          type: 'tool_call',
          data: { toolName: 'bash', args: {}, callId: 'c1' },
        });
        emit('tool_result', {
          type: 'tool_result',
          data: {
            toolName: 'bash',
            callId: 'c1',
            result: { success: false, error: '命令被拒绝' },
          },
        });
      });

      expect(useChatStore.getState().toolCalls['c1']?.status).toBe('error');
      expect(useChatStore.getState().messages[0]?.content).toBe('命令被拒绝');
    });
  });

  describe('approval_request：审批流', () => {
    it('推送审批请求进入待审批队列', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('approval_request', { type: 'approval_request', data: approval('ap-1') });
      });

      expect(useApprovalStore.getState().pendingApprovals).toHaveLength(1);
      expect(useApprovalStore.getState().pendingApprovals[0]?.toolName).toBe('bash');
    });

    it('同一审批 id 去重', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('approval_request', { type: 'approval_request', data: approval('ap-1') });
        emit('approval_request', { type: 'approval_request', data: approval('ap-1') });
      });

      expect(useApprovalStore.getState().pendingApprovals).toHaveLength(1);
    });
  });

  describe('通知类事件', () => {
    it('agent_message 触发 toast.info', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('agent_message', {
          type: 'agent_message',
          data: {
            from: 'agent-7',
            fromName: '巡检代理',
            to: 'main',
            content: '任务已完成',
            timestamp: Date.now(),
          },
        });
      });

      expect(toast.info).toHaveBeenCalledWith(
        '代理消息 · 巡检代理',
        '任务已完成',
      );
    });

    it('subagent_completed 触发 toast.success', () => {
      renderHook(() => useWebSocket());

      act(() => {
        emit('subagent_completed', {
          type: 'subagent_completed',
          data: { agentId: 'sub-1', result: '分析完成' },
        });
      });

      expect(toast.success).toHaveBeenCalledWith('子代理已完成', 'sub-1：分析完成');
    });

    it('error 事件仅记录控制台不崩溃', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      renderHook(() => useWebSocket());

      expect(() => {
        act(() => {
          emit('error', {
            type: 'error',
            data: { code: 'E_TEST', message: '测试错误' },
          });
        });
      }).not.toThrow();
      spy.mockRestore();
    });
  });
});
