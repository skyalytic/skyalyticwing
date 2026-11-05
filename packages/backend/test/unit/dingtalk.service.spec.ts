import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeModule from 'node:module';
import { DingTalkProvider } from '../../src/modules/channels/providers/dingtalk.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { IncomingMessage, RoutedSession } from '../../src/modules/channels/providers/base.provider.js';

/**
 * dingtalk-stream SDK 经 createRequire(__filename) 动态加载，jest.mock 无法拦截
 * 原生 require 链，故在 node:module 层注入 __sdkRegistry：createRequire 返回的
 * require 先查 registry，未命中再回退原生 require。
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

/** BaseProvider 构造时会解析数据目录，指向临时目录避免触碰真实用户数据目录 */
const dataDir = mkdtempSync(join(tmpdir(), 'dingtalk-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** DWClient 实例记录器 */
interface StreamClientInstance {
  registerCallbackListener: jest.Mock;
  connect: jest.Mock;
  disconnect: jest.Mock;
  socketCallBackResponse: jest.Mock;
}

/** 安装 dingtalk-stream SDK mock，返回捕获的客户端实例列表 */
function installStreamSdk(): { instances: StreamClientInstance[] } {
  const instances: StreamClientInstance[] = [];
  const DWClient = jest.fn().mockImplementation(() => {
    const inst: StreamClientInstance = {
      registerCallbackListener: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      socketCallBackResponse: jest.fn(),
    };
    instances.push(inst);
    return inst;
  });
  sdkRegistry['dingtalk-stream'] = { DWClient, TOPIC_ROBOT: '/v1.0/im/bot/messages/get' };
  return { instances };
}

/** fetch mock：按 URL 分发响应（gettoken / sessionWebhook / oToMessages） */
function installFetchMock(
  routes: Array<{ match: (url: string) => boolean; respond: () => unknown }>,
): jest.Mock {
  const fetchMock = jest.fn().mockImplementation((url: string) => {
    for (const r of routes) {
      if (r.match(url)) {
        return Promise.resolve({ ok: true, json: async () => r.respond() });
      }
    }
    return Promise.resolve({ ok: true, json: async () => ({ errcode: 0 }) });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** 构造 stream 回调 ctx（data 为 JSON 字符串） */
function streamCtx(raw: Record<string, unknown>): unknown {
  return { data: JSON.stringify(raw), headers: { messageId: raw['msgId'] || '' } };
}

function makeProvider(): DingTalkProvider {
  return new DingTalkProvider(loggerMock, routerMock);
}

/** 连接并返回注册的消息回调 */
async function connectAndGetListener(
  provider: DingTalkProvider,
  instances: StreamClientInstance[],
): Promise<(ctx: unknown) => Promise<void>> {
  const result = await provider.connect({ appKey: 'key-1', appSecret: 'secret-1' });
  expect(result.success).toBe(true);
  const inst = instances[0];
  expect(inst.registerCallbackListener).toHaveBeenCalledTimes(1);
  const listener = inst.registerCallbackListener.mock.calls[0][1] as (ctx: unknown) => Promise<void>;
  return listener;
}

/** 捕获分发到业务层的消息 */
function captureMessages(provider: DingTalkProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

describe('DingTalkProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('connect：gettoken 换取 token 并经 Stream SDK 建立长连接', async () => {
    const { instances } = installStreamSdk();
    const fetchMock = installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    const result = await provider.connect({ appKey: 'key-1', appSecret: 'secret-1' });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tokenUrl = fetchMock.mock.calls[0][0] as string;
    expect(tokenUrl).toContain('appkey=key-1');
    expect(tokenUrl).toContain('appsecret=secret-1');
    // DWClient 构造参数
    expect(instances[0]).toBeDefined();
    const Ctor = (sdkRegistry['dingtalk-stream'] as { DWClient: jest.Mock }).DWClient;
    expect(Ctor).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'key-1', clientSecret: 'secret-1', debug: false }),
    );
    // 回调注册在 TOPIC_ROBOT，且 connect() 已调用
    expect(instances[0].registerCallbackListener).toHaveBeenCalledWith('/v1.0/im/bot/messages/get', expect.any(Function));
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
  });

  it('缺少 appKey/appSecret 时连接失败', async () => {
    installStreamSdk();
    const provider = makeProvider();
    const result = await provider.connect({ appKey: '', appSecret: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('appKey');
  });

  it('文本消息解析：content 去除首尾空白后分发', async () => {
    const { instances } = installStreamSdk();
    installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    const got = captureMessages(provider);
    const listener = await connectAndGetListener(provider, instances);

    await listener(
      streamCtx({
        msgtype: 'text',
        text: { content: '  你好钉钉  ' },
        senderStaffId: 'staff-1',
        msgId: 'msg-t1',
        conversationId: 'cid-1',
        conversationType: '1',
      }),
    );

    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('staff-1');
    expect(got[0].text).toBe('你好钉钉');
  });

  it('richText 消息：多段 text 拼接', async () => {
    const { instances } = installStreamSdk();
    installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    const got = captureMessages(provider);
    const listener = await connectAndGetListener(provider, instances);

    await listener(
      streamCtx({
        msgtype: 'richText',
        content: { richText: [{ text: '第一段' }, { text: '第二段' }] },
        senderStaffId: 'staff-2',
        msgId: 'msg-t2',
        conversationType: '1',
      }),
    );

    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('第一段第二段');
  });

  it('多媒体消息：picture/file/audio/location 分别映射为占位文本', async () => {
    const { instances } = installStreamSdk();
    installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    const got = captureMessages(provider);
    const listener = await connectAndGetListener(provider, instances);

    await listener(
      streamCtx({
        msgtype: 'picture', content: { downloadCode: 'dc' }, senderStaffId: 's-a', msgId: 'm-a', conversationType: '1',
      }),
    );
    await listener(
      streamCtx({
        msgtype: 'file', content: { downloadCode: 'dc', fileName: 'doc.pdf' }, senderStaffId: 's-b', msgId: 'm-b', conversationType: '1',
      }),
    );
    await listener(
      streamCtx({ msgtype: 'audio', senderStaffId: 's-c', msgId: 'm-c', conversationType: '1' }),
    );
    await listener(
      streamCtx({ msgtype: 'location', senderStaffId: 's-d', msgId: 'm-d', conversationType: '1' }),
    );

    expect(got.map((m) => m.text)).toEqual(['[图片]', '[文件: doc.pdf]', '[语音消息]', '[位置消息]']);
  });

  it('群聊未 @ 机器人时跳过，被 @ 时正常分发', async () => {
    const { instances } = installStreamSdk();
    installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    const got = captureMessages(provider);
    const listener = await connectAndGetListener(provider, instances);

    await listener(
      streamCtx({
        msgtype: 'text', text: { content: '无艾特消息' }, senderStaffId: 'g-1', msgId: 'g-1',
        conversationType: '2', isInAtList: false,
      }),
    );
    expect(got).toHaveLength(0);

    await listener(
      streamCtx({
        msgtype: 'text', text: { content: '艾特消息' }, senderStaffId: 'g-2', msgId: 'g-2',
        conversationType: '2', isInAtList: true,
      }),
    );
    expect(got).toHaveLength(1);
  });

  it('sendMessage：命中 SessionWebhook 时短文本走 text 消息', async () => {
    const { instances } = installStreamSdk();
    const fetchMock = installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
      { match: (u) => u.startsWith('https://sw.example/'), respond: () => ({ errcode: 0 }) },
    ]);
    const provider = makeProvider();
    const listener = await connectAndGetListener(provider, instances);

    // 收到消息时缓存 sessionWebhook
    await listener(
      streamCtx({
        msgtype: 'text', text: { content: '触发缓存' }, senderStaffId: 'staff-sw', msgId: 'm-sw',
        conversationType: '1', sessionWebhook: 'https://sw.example/hook',
        sessionWebhookExpiredTime: Date.now() + 3_600_000,
      }),
    );

    const result = await provider.sendMessage('staff-sw', '普通回复');
    expect(result.success).toBe(true);
    const swCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('https://sw.example/'));
    expect(swCall).toBeDefined();
    const body = JSON.parse((swCall![1] as RequestInit).body as string);
    expect(body).toEqual({ msgtype: 'text', text: { content: '普通回复' } });
  });

  it('sendMessage：含 Markdown 时经 SessionWebhook 走 markdown 消息（title 去符号）', async () => {
    const { instances } = installStreamSdk();
    const fetchMock = installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
      { match: (u) => u.startsWith('https://sw2.example/'), respond: () => ({ errcode: 0 }) },
    ]);
    const provider = makeProvider();
    const listener = await connectAndGetListener(provider, instances);

    await listener(
      streamCtx({
        msgtype: 'text', text: { content: '触发缓存2' }, senderStaffId: 'staff-sw2', msgId: 'm-sw2',
        conversationType: '1', sessionWebhook: 'https://sw2.example/hook',
        sessionWebhookExpiredTime: Date.now() + 3_600_000,
      }),
    );

    const result = await provider.sendMessage('staff-sw2', '# 标题**加粗**');
    expect(result.success).toBe(true);
    const swCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('https://sw2.example/'));
    const body = JSON.parse((swCall![1] as RequestInit).body as string);
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.text).toBe('# 标题**加粗**');
    expect(body.markdown.title).not.toMatch(/[*#]/);
  });

  it('sendMessage：无 SessionWebhook 时走 oToMessages API（sampleText）且 token 缓存复用', async () => {
    installStreamSdk();
    const fetchMock = installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-api', expires_in: 7200 }) },
      { match: (u) => u.includes('oToMessages/batchSend'), respond: () => ({ message: '' }) },
    ]);
    const provider = makeProvider();
    await provider.connect({ appKey: 'key-1', appSecret: 'secret-1' });

    const r1 = await provider.sendMessage('user-9', 'API 回复');
    const r2 = await provider.sendMessage('user-9', 'API 回复二');
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // gettoken 只调用一次（token 缓存）
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('gettoken'));
    expect(tokenCalls).toHaveLength(1);
    const apiCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('oToMessages/batchSend'));
    expect(apiCalls).toHaveLength(2);
    const opts = apiCalls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('tok-api');
    const body = JSON.parse(opts.body as string);
    expect(body.msgKey).toBe('sampleText');
    expect(body.userIds).toEqual(['user-9']);
    expect(JSON.parse(body.msgParam)).toEqual({ content: 'API 回复' });
  });

  it('sendMessage：目标为 me 且无最近发送者时报错', async () => {
    installStreamSdk();
    installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    await provider.connect({ appKey: 'key-1', appSecret: 'secret-1' });

    const result = await provider.sendMessage('me', '你好');
    expect(result.success).toBe(false);
    expect(result.error).toContain('无法确定目标');
  });

  it('sendCard：经 SessionWebhook 发送 actionCard 并映射按钮', async () => {
    const { instances } = installStreamSdk();
    const fetchMock = installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
      { match: (u) => u.startsWith('https://sw-card/'), respond: () => ({ errcode: 0 }) },
    ]);
    const provider = makeProvider();
    const listener = await connectAndGetListener(provider, instances);

    await listener(
      streamCtx({
        msgtype: 'text', text: { content: '触发卡片缓存' }, senderStaffId: 'staff-card', msgId: 'm-card',
        conversationType: '1', sessionWebhook: 'https://sw-card/hook',
        sessionWebhookExpiredTime: Date.now() + 3_600_000,
      }),
    );

    const result = await provider.sendCard('staff-card', '卡片标题', '卡片内容', {
      buttons: [{ title: '查看', url: 'https://x.example' }],
    });
    expect(result.success).toBe(true);
    const swCall = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('https://sw-card/'));
    const body = JSON.parse((swCall![1] as RequestInit).body as string);
    expect(body.msgtype).toBe('actionCard');
    expect(body.actionCard.title).toBe('卡片标题');
    expect(body.actionCard.text).toBe('卡片内容');
    expect(body.actionCard.btns).toEqual([{ title: '查看', actionURL: 'https://x.example' }]);
  });

  it('disconnect：断开 stream 客户端并清空会话状态', async () => {
    const { instances } = installStreamSdk();
    installFetchMock([
      { match: (u) => u.includes('gettoken'), respond: () => ({ access_token: 'tok-1', expires_in: 7200 }) },
    ]);
    const provider = makeProvider();
    await provider.connect({ appKey: 'key-1', appSecret: 'secret-1' });

    await provider.disconnect();
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(provider.getStatus().connected).toBe(false);
  });
});
