import 'reflect-metadata';
import { ChannelAiHandler } from '../../src/modules/channels/channel-ai.handler.js';
import type {
  IncomingMessage,
  RoutedSession,
} from '../../src/modules/channels/providers/base.provider.js';

// ============================================================
// 测试辅助
// ============================================================

/** 构造入站消息 */
function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'msg-1',
    channelId: 'telegram',
    from: '12345',
    text: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** 构造路由会话 */
function makeSession(): RoutedSession {
  return {
    sessionId: 'ch-telegram-1',
    agentId: 'main',
    conversationId: '12345',
    createdAt: Date.now(),
  };
}

/** 将事件数组包装为 AsyncGenerator（模拟 AgentLoopService.run） */
async function* yieldEvents<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) {
    yield e;
  }
}

/** 事件类型（对齐 AgentLoopEvent 最小集合） */
type LoopEvent =
  | { type: 'assistant_message'; content: string }
  | { type: 'error'; error: string }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };

interface Harness {
  handler: ChannelAiHandler;
  channelsService: {
    onMessage: jest.Mock;
    sendMessageToProvider: jest.Mock;
    stageReply: jest.Mock;
  };
  bindingService: { resolve: jest.Mock };
  configService: { get: jest.Mock };
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  agentLoop: { run: jest.Mock };
  /** 获取 onModuleInit 注册到 ChannelsService 的消息处理器 */
  registeredHandler: (
    channelType: string,
    message: IncomingMessage,
    session: RoutedSession,
  ) => Promise<void>;
}

/** 组装被测对象（全部依赖 mock） */
function createHarness(loopEvents: LoopEvent[] = []): Harness {
  const channelsService = {
    onMessage: jest.fn(),
    stageReply: jest.fn(),
    sendMessageToProvider: jest.fn().mockResolvedValue({ success: true }),
  };
  const bindingService = {
    resolve: jest.fn().mockReturnValue({
      agentId: 'main',
      matchedBy: 'default',
      binding: null,
    }),
  };
  const configService = {
    // 默认：channels 段不存在 → autoReply 默认 true
    get: jest.fn().mockImplementation(() => {
      return {replyMode:'automatic'};
    }),
  };
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const agentLoop = {
    run: jest.fn().mockReturnValue(yieldEvents(loopEvents)),
  };
  const moduleRef = {
    get: jest.fn().mockReturnValue(agentLoop),
  };

  const handler = new ChannelAiHandler(
    channelsService as never,
    bindingService as never,
    configService as never,
    logger as never,
    moduleRef as never,
  );
  handler.onModuleInit();

  const registeredHandler = channelsService.onMessage.mock.calls[0][0] as Harness['registeredHandler'];
  return { handler, channelsService, bindingService, configService, logger, agentLoop, registeredHandler };
}

// ============================================================
// 测试
// ============================================================

describe('ChannelAiHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('onModuleInit 向 ChannelsService 注册消息处理器', () => {
    const h = createHarness();
    expect(h.channelsService.onMessage).toHaveBeenCalledTimes(1);
    expect(typeof h.registeredHandler).toBe('function');
  });

  it('全链：收到消息→查绑定→跑 AI→回复发回渠道', async () => {
    const h = createHarness([
      { type: 'assistant_message', content: 'hi, I am the AI reply' },
      { type: 'done' },
    ]);
    h.bindingService.resolve.mockReturnValue({
      agentId: 'agent-x',
      matchedBy: 'binding(priority=80)',
      binding: { id: 'b1' },
    });

    const msg = makeMessage({
      raw: { chatId: 'chat-9', msgId: 'm-9' },
    });
    await h.registeredHandler('telegram', msg, makeSession());

    // 查绑定（对端 = sender，direct）
    expect(h.bindingService.resolve).toHaveBeenCalledWith({
      channel: 'telegram',
      peerId: '12345',
      peerKind: 'direct',
    });
    // AI 调用：会话隔离命名对齐旧版 channel-<type>-<from>；渠道场景不再设置固定迭代上限
    expect(h.agentLoop.run).toHaveBeenCalledWith('ch-telegram-1', 'hello', {
      agentId: 'agent-x',
    });
    // 回复发回渠道，透传 raw.chatId/msgId
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledWith(
      'telegram',
      '12345',
      'hi, I am the AI reply',
      expect.objectContaining({ chatId: 'chat-9', msgId: 'm-9' }),
    );
  });

  it('无绑定时回退默认 agent main', async () => {
    const h = createHarness([
      { type: 'assistant_message', content: 'ok' },
      { type: 'done' },
    ]);
    h.bindingService.resolve.mockReturnValue({
      agentId: 'main',
      matchedBy: 'default',
      binding: null,
    });

    await h.registeredHandler('dingtalk', makeMessage(), makeSession());

    expect(h.agentLoop.run).toHaveBeenCalledWith('ch-telegram-1', 'hello', {
      agentId: 'main',
    });
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledWith(
      'dingtalk',
      '12345',
      'ok',
      expect.objectContaining({ chatId: '', msgId: '' }),
    );
  });

  it('AI 返回 error 事件时回发 [ERROR] 错误消息', async () => {
    const h = createHarness([{ type: 'error', error: 'LLM boom' }]);

    await h.registeredHandler('telegram', makeMessage(), makeSession());

    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledWith(
      'telegram',
      '12345',
      '[ERROR] LLM boom',
      expect.objectContaining({ chatId: '', msgId: '' }),
    );
  });

  it('AgentLoop.run 抛出异常时回发 [ERROR] 错误消息', async () => {
    const h = createHarness();
    h.agentLoop.run.mockImplementation(() => {
      throw new Error('agent loop crashed');
    });

    await h.registeredHandler('telegram', makeMessage(), makeSession());

    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledWith(
      'telegram',
      '12345',
      '[ERROR] agent loop crashed',
      expect.objectContaining({ chatId: '', msgId: '' }),
    );
  });

  it('autoReply=false 时不处理消息（不查绑定/不调 AI/不回复）', async () => {
    const h = createHarness([{ type: 'assistant_message', content: 'x' }, { type: 'done' }]);
    h.configService.get.mockReturnValue({ autoReply: false });

    await h.registeredHandler('telegram', makeMessage(), makeSession());

    expect(h.bindingService.resolve).not.toHaveBeenCalled();
    expect(h.agentLoop.run).not.toHaveBeenCalled();
    expect(h.channelsService.sendMessageToProvider).not.toHaveBeenCalled();
  });

  it('防循环：自身刚发送的回复回显（同 from + 同文本）不触发 AI', async () => {
    const h = createHarness([{ type: 'assistant_message', content: 'echo-me' }, { type: 'done' }]);

    // 第一轮：正常处理并回复 "echo-me"（sendReply 记录 echo key）
    await h.registeredHandler('telegram', makeMessage(), makeSession());
    expect(h.agentLoop.run).toHaveBeenCalledTimes(1);
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledTimes(1);

    // 第二轮：机器人账号收到自己回复的回显（同 from 同文本）
    await h.registeredHandler(
      'telegram',
      makeMessage({ text: 'echo-me', raw: { echo: true } }),
      makeSession(),
    );

    // echo 消息被跳过：AI 不再被调用、不再发送
    expect(h.agentLoop.run).toHaveBeenCalledTimes(1);
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledTimes(1);
  });

  it('空文本消息跳过（不触发 AI）', async () => {
    const h = createHarness();

    await h.registeredHandler('telegram', makeMessage({ text: '   ' }), makeSession());

    expect(h.agentLoop.run).not.toHaveBeenCalled();
    expect(h.channelsService.sendMessageToProvider).not.toHaveBeenCalled();
  });

  it('AgentLoopService 不可用时回发 AI 服务不可用错误', async () => {
    const h = createHarness();
    // moduleRef.get 抛错 → resolveAgentLoop 返回 null
    const moduleRefThrow = { get: jest.fn().mockImplementation(() => { throw new Error('not found'); }) };
    const handler2 = new ChannelAiHandler(
      h.channelsService as never,
      h.bindingService as never,
      h.configService as never,
      h.logger as never,
      moduleRefThrow as never,
    );
    handler2.onModuleInit();
    const handlerFn = h.channelsService.onMessage.mock.calls[1][0] as Harness['registeredHandler'];

    await handlerFn('telegram', makeMessage(), makeSession());

    expect(h.agentLoop.run).not.toHaveBeenCalled();
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledWith(
      'telegram',
      '12345',
      '[ERROR] AI service unavailable',
      expect.objectContaining({ chatId: '', msgId: '' }),
    );
  });

  it('done 事件携带 usage 时轻量记录用量日志', async () => {
    const h = createHarness([
      { type: 'assistant_message', content: 'reply' },
      {
        type: 'done',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    ]);

    await h.registeredHandler('telegram', makeMessage(), makeSession());

    expect(h.logger.info).toHaveBeenCalledWith(
      '[ChannelAI] usage',
      expect.objectContaining({
        sessionId: 'ch-telegram-1',
        totalTokens: 15,
      }),
    );
  });
});


describe('remote channel direct replies',()=>{
  it.each(['weixin','wechat-work','dingtalk','feishu'])('sends %s replies directly even with a legacy draft setting',async(channel)=>{
    const h=createHarness([{type:'assistant_message',content:'task result'}]);
    h.configService.get.mockReturnValue({replyMode:'draft'});
    await h.registeredHandler(channel,makeMessage({channelId:channel}),makeSession());
    expect(h.channelsService.stageReply).not.toHaveBeenCalled();
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledWith(channel,'12345','task result',expect.anything());
    expect(h.logger.info).toHaveBeenCalledWith('[ChannelAI] reply sent',{channelType:channel});
  });
  it('sends by default when no channels configuration exists',async()=>{
    const h=createHarness([{type:'assistant_message',content:'reply'}]);
    h.configService.get.mockImplementation(()=>{throw new Error('missing');});
    await h.registeredHandler('weixin',makeMessage(),makeSession());
    expect(h.channelsService.stageReply).not.toHaveBeenCalled();
    expect(h.channelsService.sendMessageToProvider).toHaveBeenCalledTimes(1);
  });
});

