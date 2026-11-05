import 'reflect-metadata';
import type {
  AgentLoopEvent,
  ISessionService,
} from '../../src/modules/ai/types.js';
import { ChatService } from '../../src/modules/ai/chat/chat.service.js';
import type { LLMClientService } from '../../src/modules/ai/llm/llm-client.service.js';
import type { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service.js';
import type { WebSocketService } from '../../src/modules/core/websocket/websocket.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

/** 将事件数组包装为 AgentLoop.run 风格的异步生成器 */
const gen = async function* (events: AgentLoopEvent[]): AsyncGenerator<AgentLoopEvent> {
  for (const e of events) yield e;
};

const genThrow = async function* (): AsyncGenerator<AgentLoopEvent> {
  throw new Error('loop crashed');
};

describe('ChatService', () => {
  let llm: { getDefaultModel: jest.Mock; chatSync: jest.Mock };
  let agentLoop: { run: jest.Mock };
  let ws: { broadcastToSession: jest.Mock };
  let service: ChatService;

  beforeEach(() => {
    llm = { getDefaultModel: jest.fn().mockReturnValue('gpt-4o'), chatSync: jest.fn() };
    agentLoop = { run: jest.fn() };
    ws = { broadcastToSession: jest.fn() };
    service = new ChatService(
      llm as unknown as LLMClientService,
      agentLoop as unknown as AgentLoopService,
      ws as unknown as WebSocketService,
      loggerMock,
    );
  });

  describe('sendMessage（非流式）', () => {
    it('聚合 assistant_message 事件并返回完整 ChatResponse', async () => {
      agentLoop.run.mockReturnValue(
        gen([
          { type: 'assistant_message', content: '你好，世界' },
          { type: 'done' },
        ]),
      );

      const res = await service.sendMessage({ session: 's1', message: 'hi' });

      expect(res.sessionId).toBe('s1');
      expect(res.message.role).toBe('assistant');
      expect(res.message.content).toBe('你好，世界');
      expect(res.message.model).toBe('gpt-4o');
      expect(res.usage).toBeUndefined();
    });

    it('未指定 model 时使用 LLM 默认模型且不向 loop 透传 model', async () => {
      agentLoop.run.mockReturnValue(gen([{ type: 'done' }]));

      await service.sendMessage({ session: 's1', message: 'hi' });

      expect(llm.getDefaultModel).toHaveBeenCalled();
      expect(agentLoop.run).toHaveBeenCalledWith('s1', 'hi', {});
    });

    it('指定 model 时透传给 AgentLoop 并体现在响应消息上', async () => {
      agentLoop.run.mockReturnValue(gen([{ type: 'done' }]));

      const res = await service.sendMessage({
        session: 's1',
        message: 'hi',
        model: 'claude-3-5-sonnet',
      });

      expect(agentLoop.run).toHaveBeenCalledWith('s1', 'hi', { model: 'claude-3-5-sonnet' });
      expect(res.message.model).toBe('claude-3-5-sonnet');
    });

    it('tool_call / tool_result / approval_request 事件广播到 WebSocket', async () => {
      agentLoop.run.mockReturnValue(
        gen([
          {
            type: 'tool_call',
            toolName: 'file-read',
            args: { path: 'a.txt' },
            callId: 'c1',
          },
          {
            type: 'tool_result',
            toolName: 'file-read',
            result: { success: true, output: 'ok' },
            callId: 'c1',
          },
          {
            type: 'approval_request',
            request: {
              id: 'ap1',
              toolName: 'bash',
              args: { command: 'ls' },
              sessionId: 's1',
              reason: 'dangerous',
              timestamp: 1,
            },
          },
          { type: 'assistant_message', content: 'done' },
          { type: 'done' },
        ]),
      );

      await service.sendMessage({ session: 's1', message: 'go' });

      const calls = ws.broadcastToSession.mock.calls as unknown as Array<[string, { type: string }]>;
      const types = calls.map(([, e]) => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types).toContain('approval_request');
      // 全部广播都发往当前会话
      for (const [sid] of calls) expect(sid).toBe('s1');
      // 最终广播完整助手消息
      const last = calls[calls.length - 1];
      expect(last[1]?.type).toBe('chat_message');
    });

    it('done 事件携带 usage 时透传到响应', async () => {
      const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
      agentLoop.run.mockReturnValue(
        gen([
          { type: 'assistant_message', content: 'x' },
          { type: 'done', usage },
        ]),
      );

      const res = await service.sendMessage({ session: 's1', message: 'hi' });
      expect(res.usage).toEqual(usage);
    });

    it('error 事件导致 sendMessage 抛错', async () => {
      agentLoop.run.mockReturnValue(
        gen([{ type: 'error', error: 'LLM 不可用' }]),
      );

      await expect(
        service.sendMessage({ session: 's1', message: 'hi' }),
      ).rejects.toThrow('LLM 不可用');
    });
  });

  describe('streamMessage（流式）', () => {
    it('assistant_message 产生 delta 块并广播 chat_stream', async () => {
      agentLoop.run.mockReturnValue(
        gen([
          { type: 'assistant_message', content: '流式片段' },
          { type: 'done' },
        ]),
      );

      const chunks: Array<{ type: string; content?: string }> = [];
      for await (const c of service.streamMessage({ session: 's1', message: 'hi' })) {
        chunks.push(c as { type: string; content?: string });
      }

      expect(chunks[0]).toEqual({ type: 'delta', content: '流式片段' });
      expect(chunks[chunks.length - 1]?.type).toBe('done');
      expect(ws.broadcastToSession).toHaveBeenCalledWith('s1', {
        type: 'chat_stream',
        data: { sessionId: 's1', content: '流式片段', done: false },
      });
      expect(ws.broadcastToSession).toHaveBeenCalledWith('s1', {
        type: 'chat_stream',
        data: expect.objectContaining({ sessionId: 's1', content: '', done: true, message: expect.objectContaining({role: 'assistant', content: '流式片段'}) }),
      });
    });

    it('tool_call 产生 tool_call 块（对象参数 JSON 序列化）', async () => {
      agentLoop.run.mockReturnValue(
        gen([
          {
            type: 'tool_call',
            toolName: 'bash',
            args: { command: 'ls' },
            callId: 'c9',
          },
          { type: 'done' },
        ]),
      );

      const chunks: Array<Record<string, unknown>> = [];
      for await (const c of service.streamMessage({ session: 's1', message: 'go' })) {
        chunks.push(c as unknown as Record<string, unknown>);
      }

      const toolChunk = chunks.find((c) => c['type'] === 'tool_call');
      expect(toolChunk?.['toolCall']).toEqual({
        id: 'c9',
        name: 'bash',
        arguments: JSON.stringify({ command: 'ls' }),
      });
    });

    it('done 携带 usage 时 done 块包含 usage', async () => {
      const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
      agentLoop.run.mockReturnValue(gen([{ type: 'done', usage }]));

      const chunks: Array<Record<string, unknown>> = [];
      for await (const c of service.streamMessage({ session: 's1', message: 'hi' })) {
        chunks.push(c as unknown as Record<string, unknown>);
      }

      expect(chunks[chunks.length - 1]).toMatchObject({ type: 'done', usage });
    });

    it('error 事件产生 error 块并终止流（无 done 块）', async () => {
      agentLoop.run.mockReturnValue(gen([{ type: 'error', error: 'boom' }]));

      const chunks: Array<Record<string, unknown>> = [];
      for await (const c of service.streamMessage({ session: 's1', message: 'hi' })) {
        chunks.push(c as unknown as Record<string, unknown>);
      }

      expect(chunks).toEqual([{ type: 'error', error: 'boom' }]);
    });

    it('AgentLoop 抛错时流以 error 块收尾', async () => {
      agentLoop.run.mockReturnValue(genThrow());

      const chunks: Array<Record<string, unknown>> = [];
      for await (const c of service.streamMessage({ session: 's1', message: 'hi' })) {
        chunks.push(c as unknown as Record<string, unknown>);
      }

      expect(chunks).toEqual([{ type: 'error', error: 'loop crashed' }]);
    });
  });

  describe('getHistory', () => {
    it('注入 session 时返回其消息列表', () => {
      const session = {
        getMessages: jest.fn().mockReturnValue([{ id: 'm1' }]),
        addMessage: jest.fn(),
        replaceMessages: jest.fn(),
        getSession: jest.fn(),
      } as unknown as ISessionService;

      const svc = new ChatService(
        llm as unknown as LLMClientService,
        agentLoop as unknown as AgentLoopService,
        ws as unknown as WebSocketService,
        loggerMock,
        session,
      );

      expect(svc.getHistory('s1')).toEqual([{ id: 'm1' }]);
      expect(session.getMessages).toHaveBeenCalledWith('s1');
    });

    it('session.getMessages 抛错时记录 warn 并返回空数组', () => {
      const session = {
        getMessages: jest.fn().mockImplementation(() => {
          throw new Error('read fail');
        }),
        addMessage: jest.fn(),
        replaceMessages: jest.fn(),
        getSession: jest.fn(),
      } as unknown as ISessionService;

      const svc = new ChatService(
        llm as unknown as LLMClientService,
        agentLoop as unknown as AgentLoopService,
        ws as unknown as WebSocketService,
        loggerMock,
        session,
      );

      expect(svc.getHistory('s1')).toEqual([]);
      expect(loggerMock.warn).toHaveBeenCalled();
    });

    it('未注入 session 时返回空数组', () => {
      expect(service.getHistory('s1')).toEqual([]);
    });
  });
});
