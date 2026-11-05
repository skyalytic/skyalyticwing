import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/types';
import { useChatStore } from '../src/stores/chat-store';
import type { ChatMessage } from '@/types';

const msg = (i: number): ChatMessage => ({
  id: `m-${i}`,
  role: 'user',
  content: `消息 ${i}`,
  timestamp: 1_700_000_000_000 + i,
});

const resetStore = (): void => {
  localStorage.clear();
  useChatStore.setState({
    messages: [],
    isStreaming: false,
    streamingContent: '',
    streamingSessionId: null,
    toolCalls: {},
  });
};

describe('useChatStore', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps durable transcript on the backend rather than duplicating attachments in localStorage', () => {
    useChatStore.getState().addMessage({ ...msg(0), content: 'private transcript' });
    expect(localStorage.getItem('chat-storage')).not.toContain('private transcript');
  });

  describe('addMessage / setMessages', () => {
    it('添加消息到列表', () => {
      useChatStore.getState().addMessage(msg(1));
      useChatStore.getState().addMessage(msg(2));

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    });

    it('相同 id 的消息去重（保留先加入的）', () => {
      useChatStore.getState().addMessage(msg(1));
      useChatStore.getState().addMessage({ ...msg(1), content: '重复内容' });

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('消息 1');
    });

    it('超过 500 条仍保留最早的消息', () => {
      for (let i = 0; i < 505; i++) {
        useChatStore.getState().addMessage(msg(i));
      }

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(505);
      expect(messages[0]?.id).toBe('m-0');
      expect(messages[504]?.id).toBe('m-504');
    });

    it('setMessages retains the complete server transcript', () => {
      const bulk = Array.from({ length: 520 }, (_, i) => msg(i));
      useChatStore.getState().setMessages(bulk);

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(520);
      expect(messages[0]?.id).toBe('m-0');
    });
  });

  describe('流式状态', () => {
    it('startStream 开启流式并记录会话', () => {
      const s = useChatStore.getState();
      s.activateSession('session-1');
      s.startStream('session-1');
      const st = useChatStore.getState();
      expect(st.isStreaming).toBe(true);
      expect(st.streamingSessionId).toBe('session-1');
      expect(st.streamingContent).toBe('');
    });

    it('appendStream 累加流式内容', () => {
      const s = useChatStore.getState();
      s.activateSession('session-1');
      s.startStream('session-1');
      s.appendStream('Hello');
      s.appendStream(' World');
      expect(useChatStore.getState().streamingContent).toBe('Hello World');
    });

    it('clearStream 重置流式状态', () => {
      const s = useChatStore.getState();
      s.activateSession('session-1');
      s.startStream('session-1');
      s.appendStream('partial');
      useChatStore.getState().clearStream();

      const st = useChatStore.getState();
      expect(st.streamingContent).toBe('');
      expect(st.isStreaming).toBe(false);
      expect(st.streamingSessionId).toBeNull();
    });

    it('setStreaming 独立控制流式标志', () => {
      useChatStore.getState().setStreaming(false);
      expect(useChatStore.getState().isStreaming).toBe(false);
      useChatStore.getState().setStreaming(true);
      expect(useChatStore.getState().isStreaming).toBe(true);
    });
  });

  describe('工具调用状态', () => {
    it('startToolCall 登记运行中的工具调用', () => {
      useChatStore.getState().startToolCall('call-1', 'file_read', { path: '/a' });

      const tc = useChatStore.getState().toolCalls['call-1'];
      expect(tc).toBeDefined();
      expect(tc?.toolName).toBe('file_read');
      expect(tc?.status).toBe('running');
      expect(tc?.args).toEqual({ path: '/a' });
    });

    it('finishToolCall 成功时更新状态并回写关联消息内容', () => {
      const s = useChatStore.getState();
      s.addMessage({ ...msg(1), id: 'tool-call-1', role: 'assistant', toolCallId: 'call-1' });
      s.startToolCall('call-1', 'file_read');
      const result: ToolResult = { success: true, output: '文件内容' };
      useChatStore.getState().finishToolCall('call-1', 'file_read', result);

      const st = useChatStore.getState();
      expect(st.toolCalls['call-1']?.status).toBe('success');
      expect(st.toolCalls['call-1']?.result).toEqual(result);
      const related = st.messages.find((m) => m.toolCallId === 'call-1');
      expect(related?.content).toBe('文件内容');
    });

    it('finishToolCall 失败时状态为 error 且内容为错误信息', () => {
      useChatStore.getState().startToolCall('call-2', 'bash');
      useChatStore.getState().finishToolCall('call-2', 'bash', {
        success: false,
        error: '命令被拒绝',
      });

      const tc = useChatStore.getState().toolCalls['call-2'];
      expect(tc?.status).toBe('error');
      expect(tc?.result?.error).toBe('命令被拒绝');
    });
  });

  describe('clear', () => {
    it('清空消息与实时状态', () => {
      const s = useChatStore.getState();
      s.addMessage(msg(1));
      s.activateSession('session-1');
      s.startStream('session-1');
      s.startToolCall('call-1', 'file_read');
      useChatStore.getState().clear();

      const st = useChatStore.getState();
      expect(st.messages).toEqual([]);
      expect(st.streamingContent).toBe('');
      expect(st.isStreaming).toBe(false);
      expect(st.toolCalls).toEqual({});
    });
  });
});
