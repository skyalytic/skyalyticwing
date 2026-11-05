import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeModule from 'node:module';
import { FeishuProvider } from '../../src/modules/channels/providers/feishu.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { IncomingMessage, RoutedSession } from '../../src/modules/channels/providers/base.provider.js';

/**
 * @larksuiteoapi/node-sdk 经 createRequire 动态加载，jest.mock 无法拦截原生
 * require 链，故在 node:module 层注入 __sdkRegistry（与 dingtalk.service.spec 同模式）。
 */
jest.mock('node:module', () => {
  const actual = jest.requireActual('node:module') as typeof import('node:module') & {
    createRequire: (filename: string) => NodeRequire;
  };
  const registry: Record<string, unknown> = {};
  const createRequire = (filename: string): NodeRequire => {
    const native = actual.createRequire(filename);
    const req = ((id: string) => (id in registry ? registry[id] : native(id))) as NodeRequire;
    return req;
  };
  return { ...actual, createRequire, __sdkRegistry: registry };
});

const sdkRegistry = (nodeModule as unknown as { __sdkRegistry: Record<string, unknown> }).__sdkRegistry;

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

const routedSession: RoutedSession = {
  sessionId: 'sess-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
  createdAt: Date.now(),
};
const routerMock = {
  route: jest.fn().mockReturnValue(routedSession),
} as unknown as ChannelRouterService;

const dataDir = mkdtempSync(join(tmpdir(), 'feishu-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** LarkClient mock（im.message.reply/create/patch） */
function makeClientMock() {
  return {
    request: jest.fn().mockResolvedValue({ code: 0 }),
    im: {
      message: {
        reply: jest.fn().mockResolvedValue({ code: 0, data: { message_id: 'om-reply' } }),
        create: jest.fn().mockResolvedValue({ code: 0, data: { message_id: 'om-new' } }),
        patch: jest.fn().mockResolvedValue({ code: 0 }),
      },
      image: { create: jest.fn().mockResolvedValue({ code: 0, image_key: 'img_key' }) },
      file: { create: jest.fn().mockResolvedValue({ code: 0, file_key: 'file_key' }) },
    },
  };
}

/** 安装飞书 SDK mock */
function installLarkSdk(): {
  client: ReturnType<typeof makeClientMock>;
  WSClient: jest.Mock;
  EventDispatcher: jest.Mock;
} {
  const client = makeClientMock();
  const WSClient = jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  }));
  const EventDispatcher = jest.fn().mockImplementation(() => ({ register: jest.fn() }));
  sdkRegistry['@larksuiteoapi/node-sdk'] = {
    Client: jest.fn().mockImplementation(() => client),
    Domain: { Lark: 'domain-lark', Feishu: 'domain-feishu' },
    AppType: { SelfBuild: 'self_build' },
    LoggerLevel: { WARN: 'warn', INFO: 'info' },
    WSClient,
    EventDispatcher,
  };
  return { client, WSClient, EventDispatcher };
}

function makeProvider(): FeishuProvider {
  return new FeishuProvider(loggerMock, routerMock);
}

function captureMessages(provider: FeishuProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

describe('FeishuProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('connect：WebSocket 模式启动 WSClient 并获取 bot 信息', async () => {
    const { client, WSClient, EventDispatcher } = installLarkSdk();
    client.request.mockResolvedValue({ code: 0, bot: { open_id: 'ou_bot', bot_name: 'bot' } });
    const provider = makeProvider();

    const result = await provider.connect({ appId: 'app-1', appSecret: 'sec-1' });
    expect(result.success).toBe(true);
    expect(WSClient).toHaveBeenCalledTimes(1);
    expect(EventDispatcher).toHaveBeenCalledTimes(1);
    // bot 信息通过 GET /open-apis/bot/v3/info 获取
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: '/open-apis/bot/v3/info' }),
    );
    expect((provider as unknown as { botOpenId: string }).botOpenId).toBe('ou_bot');
  });

  it('connect：缺少 appId/appSecret 失败', async () => {
    installLarkSdk();
    const provider = makeProvider();
    const result = await provider.connect({ appId: '', appSecret: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('appId');
  });

  it('parseFeishuContent：text 类型取 text 字段', () => {
    installLarkSdk();
    const provider = makeProvider();
    const parse = (provider as unknown as {
      parseFeishuContent: (m: unknown) => string;
    }).parseFeishuContent.bind(provider);
    expect(parse({ content: '{"text":"你好飞书"}', message_type: 'text' })).toBe('你好飞书');
  });

  it('parseFeishuContent：post 富文本多行多 tag 拼接（text/md/a/at/img）', () => {
    installLarkSdk();
    const provider = makeProvider();
    const parse = (provider as unknown as {
      parseFeishuContent: (m: unknown) => string;
    }).parseFeishuContent.bind(provider);
    const content = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: 'text', text: '普通' },
            { tag: 'md', text: '**粗体**' },
          ],
          [
            { tag: 'a', text: '链接', href: 'https://x' },
            { tag: 'at', user_name: '张三' },
            { tag: 'img' },
          ],
        ],
      },
    });
    expect(parse({ content, message_type: 'post' })).toBe(
      '普通**粗体**\n[链接](https://x)@张三[图片]',
    );
  });

  it('parseFeishuContent：interactive 卡片取 header + markdown 元素', () => {
    installLarkSdk();
    const provider = makeProvider();
    const parse = (provider as unknown as {
      parseFeishuContent: (m: unknown) => string;
    }).parseFeishuContent.bind(provider);
    const content = JSON.stringify({
      header: { title: { content: '卡片标题' } },
      body: { elements: [{ tag: 'markdown', content: '卡片正文' }] },
    });
    expect(parse({ content, message_type: 'interactive' })).toBe('卡片标题\n卡片正文');
  });

  it('parseFeishuContent：多媒体类型占位（image/file/sticker）', () => {
    installLarkSdk();
    const provider = makeProvider();
    const parse = (provider as unknown as {
      parseFeishuContent: (m: unknown) => string;
    }).parseFeishuContent.bind(provider);
    expect(parse({ content: '{}', message_type: 'image' })).toBe('[图片]');
    expect(parse({ content: '{"file_name":"报告.pdf"}', message_type: 'file' })).toBe('[文件: 报告.pdf]');
    expect(parse({ content: '{}', message_type: 'sticker' })).toBe('[表情]');
    expect(parse({ content: '{}', message_type: 'audio' })).toBe('[语音]');
    expect(parse({ content: '{}', message_type: 'media' })).toBe('[视频]');
  });

  it('sendMessage：纯文本走 im.message.create（open_id + text）', async () => {
    const { client } = installLarkSdk();
    const provider = makeProvider();
    (provider as unknown as { client: unknown }).client = client;

    const result = await provider.sendMessage('ou_123', '你好');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('om-new');
    expect(client.im.message.reply).not.toHaveBeenCalled();
    expect(client.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: 'ou_123',
        msg_type: 'text',
        content: JSON.stringify({ text: '你好' }),
      },
    });
  });

  it('sendMessage：短 Markdown 走 interactive 卡片，长 Markdown 走 post', async () => {
    const { client } = installLarkSdk();
    const provider = makeProvider();
    (provider as unknown as { client: unknown }).client = client;

    await provider.sendMessage('ou_123', '## 短标题');
    const shortCall = client.im.message.create.mock.calls[0][0] as { data: { msg_type: string; content: string } };
    expect(shortCall.data.msg_type).toBe('interactive');

    const longMd = '## 标题\n\n```code\n' + 'x'.repeat(300) + '\n```';
    await provider.sendMessage('ou_123', longMd);
    const longCall = client.im.message.create.mock.calls[1][0] as { data: { msg_type: string; content: string } };
    expect(longCall.data.msg_type).toBe('post');
    expect(JSON.parse(longCall.data.content).zh_cn.content[0][0]).toEqual({ tag: 'md', text: longMd });
  });

  it('sendMessage：有 lastMessageId 时优先 reply，成功后清除避免重复回复', async () => {
    const { client } = installLarkSdk();
    const provider = makeProvider();
    (provider as unknown as { client: unknown }).client = client;
    (provider as unknown as { lastMessageId: string }).lastMessageId = 'om_999';

    const result = await provider.sendMessage('ou_123', '回复内容');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('om-reply');
    expect(client.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_999' },
      data: { content: JSON.stringify({ text: '回复内容' }), msg_type: 'text' },
    });
    expect(client.im.message.create).not.toHaveBeenCalled();
    // 回复成功后清除 lastMessageId
    expect((provider as unknown as { lastMessageId: string | null }).lastMessageId).toBeNull();
  });

  it('sendMessage：reply 抛错时回退 direct create', async () => {
    const { client } = installLarkSdk();
    client.im.message.reply.mockRejectedValue(new Error('reply failed'));
    const provider = makeProvider();
    (provider as unknown as { client: unknown }).client = client;
    (provider as unknown as { lastMessageId: string }).lastMessageId = 'om_dead';

    const result = await provider.sendMessage('ou_123', '回退内容');
    expect(result.success).toBe(true);
    expect(client.im.message.reply).toHaveBeenCalledTimes(1);
    expect(client.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receive_id: 'ou_123' }) }),
    );
  });

  it('sendMessage：oc_ 前缀目标按 chat_id 发送', async () => {
    const { client } = installLarkSdk();
    const provider = makeProvider();
    (provider as unknown as { client: unknown }).client = client;

    await provider.sendMessage('oc_group1', '群消息');
    expect(client.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: expect.objectContaining({ receive_id: 'oc_group1' }),
    });
  });

  it('sendMessage：未连接时报错', async () => {
    installLarkSdk();
    const provider = makeProvider();
    const result = await provider.sendMessage('ou_1', 'hi');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });

  it('handleFeishuEvent：群聊未 @ 机器人跳过，@ 后去除 @ 文本再分发', async () => {
    installLarkSdk();
    const provider = makeProvider();
    (provider as unknown as { botOpenId: string }).botOpenId = 'ou_bot';
    const got = captureMessages(provider);
    const handle = (provider as unknown as {
      handleFeishuEvent: (from: string, text: string, event: unknown) => Promise<void>;
    }).handleFeishuEvent.bind(provider);

    // 未 @：不分发
    await handle('ou_user', '@_user_1 帮我查下', {
      message: { chat_id: 'oc_1', chat_type: 'group', message_id: 'om_1', message_type: 'text', mentions: [] },
    });
    expect(got).toHaveLength(0);

    // @ 机器人：去除 @ 占位文本后分发，路由 ID 为 chat_id
    await handle('ou_user', '@_user_1 帮我查下', {
      message: {
        chat_id: 'oc_1',
        chat_type: 'group',
        message_id: 'om_2',
        message_type: 'text',
        mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1', user_name: 'bot' }],
      },
    });
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('oc_1');
    expect(got[0].text).toBe('帮我查下');
  });

  it('handleFeishuEvent：私聊按 open_id 路由并记录 lastMessageId/lastChatId', async () => {
    installLarkSdk();
    const provider = makeProvider();
    const got = captureMessages(provider);
    const handle = (provider as unknown as {
      handleFeishuEvent: (from: string, text: string, event: unknown) => Promise<void>;
    }).handleFeishuEvent.bind(provider);

    await handle('ou_p2p', '私聊内容', {
      message: { chat_id: 'oc_p2p', chat_type: 'p2p', message_id: 'om_p2p', message_type: 'text' },
    });
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('ou_p2p');
    expect((provider as unknown as { lastMessageId: string | null }).lastMessageId).toBe('om_p2p');
    expect((provider as unknown as { lastChatId: string | null }).lastChatId).toBe('oc_p2p');
  });

  it('editMessage：调 im.message.patch，Markdown 转 post 内容', async () => {
    const { client } = installLarkSdk();
    const provider = makeProvider();
    (provider as unknown as { client: unknown }).client = client;

    const result = await provider.editMessage('om_edit', '## 更新后');
    expect(result.success).toBe(true);
    expect(client.im.message.patch).toHaveBeenCalledWith({
      path: { message_id: 'om_edit' },
      data: { content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: '## 更新后' }]] } }) },
    });
  });
});
