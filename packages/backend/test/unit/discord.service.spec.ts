import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeModule from 'node:module';
import { DiscordProvider } from '../../src/modules/channels/providers/discord.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { IncomingMessage, RoutedSession } from '../../src/modules/channels/providers/base.provider.js';

/**
 * discord.js 未安装（可选依赖），且经 createRequire 动态加载。jest.mock 的
 * virtual 模式同样无法拦截 createRequire 的原生 require 链，故在 node:module
 * 层注入 __sdkRegistry（与 dingtalk/feishu spec 同模式，天然支持未安装模块）。
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

const dataDir = mkdtempSync(join(tmpdir(), 'discord-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** DiscordClient mock：按事件名收集回调，emit 触发 */
function installDiscordSdk(): {
  client: {
    on: jest.Mock;
    login: jest.Mock;
    destroy: jest.Mock;
    channels: { fetch: jest.Mock };
    users: { fetch: jest.Mock };
    user: { id: string; tag: string } | null;
  };
  Ctor: jest.Mock;
  emit: (event: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const client = {
    on: jest.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
    }),
    login: jest.fn().mockResolvedValue('token-ok'),
    destroy: jest.fn().mockResolvedValue(undefined),
    channels: { fetch: jest.fn() },
    users: { fetch: jest.fn() },
    user: { id: 'bot-self', tag: 'Bot#0001' },
  };
  const Ctor = jest.fn().mockImplementation(() => client);
  sdkRegistry['discord.js'] = {
    Client: Ctor,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
  };
  const emit = (event: string, ...args: unknown[]): void => {
    const cb = handlers.get(event);
    if (cb) cb(...args);
  };
  return { client, Ctor, emit };
}

function makeProvider(): DiscordProvider {
  return new DiscordProvider(loggerMock, routerMock);
}

function captureMessages(provider: DiscordProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

describe('DiscordProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('connect：以四类 intents 构造 Client 并 login', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();

    const result = await provider.connect({ botToken: 'DIS-TOKEN' });
    expect(result.success).toBe(true);
    expect(sdk.Ctor).toHaveBeenCalledWith({
      intents: [1, 2, 4, 8],
    });
    expect(sdk.client.login).toHaveBeenCalledWith('DIS-TOKEN');
  });

  it('connect：缺少 botToken 失败', async () => {
    installDiscordSdk();
    const provider = makeProvider();
    const result = await provider.connect({});
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing botToken');
  });

  it('messageCreate：bot 自身消息被过滤', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });
    const got = captureMessages(provider);

    sdk.emit(
      'messageCreate',
      { author: { bot: true, id: 'other-bot' }, content: 'bot 消息', channel: { id: 'ch-1' }, id: 'm-0', guild: null },
    );
    expect(got).toHaveLength(0);
  });

  it('messageCreate：用户消息分发（from=author.id，携带频道/服务器信息）', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });
    const got = captureMessages(provider);

    sdk.emit(
      'messageCreate',
      {
        author: { id: 'user-42' },
        content: '你好 Discord',
        channel: { id: 'ch-9' },
        id: 'msg-9',
        guild: { id: 'guild-7' },
      },
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('user-42');
    expect(got[0].text).toBe('你好 Discord');
    expect((got[0].raw as Record<string, unknown>)['channelId']).toBe('ch-9');
  });

  it('sendMessage：频道 fetch 成功时直接 channel.send', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });
    const send = jest.fn().mockResolvedValue({ id: 'sm-1' });
    sdk.client.channels.fetch.mockResolvedValue({ send });

    const result = await provider.sendMessage('ch-100', '频道消息');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sm-1');
    expect(sdk.client.channels.fetch).toHaveBeenCalledWith('ch-100');
    expect(send).toHaveBeenCalledWith('频道消息');
    expect(sdk.client.users.fetch).not.toHaveBeenCalled();
  });

  it('sendMessage：频道 fetch 失败回退 DM 用户', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });
    const dmSend = jest.fn().mockResolvedValue({ id: 'dm-1' });
    sdk.client.channels.fetch.mockRejectedValue(new Error('Unknown Channel'));
    sdk.client.users.fetch.mockResolvedValue({ createDM: jest.fn().mockResolvedValue({ send: dmSend }) });

    const result = await provider.sendMessage('user-77', '私信消息');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('dm-1');
    expect(sdk.client.users.fetch).toHaveBeenCalledWith('user-77');
    expect(dmSend).toHaveBeenCalledWith('私信消息');
  });

  it('sendMessage：频道与 DM 均失败时返回错误', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });
    sdk.client.channels.fetch.mockRejectedValue(new Error('Unknown Channel'));
    sdk.client.users.fetch.mockRejectedValue(new Error('Unknown User'));

    const result = await provider.sendMessage('nobody', '找不到');
    expect(result.success).toBe(false);
    expect(result.error).toContain('nobody');
  });

  it('sendMessage：目标为 me 时回退最近发送者', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });
    (provider as unknown as { lastSenderId: string }).lastSenderId = 'user-last';
    const send = jest.fn().mockResolvedValue({ id: 'sm-2' });
    sdk.client.channels.fetch.mockResolvedValue({ send });

    const result = await provider.sendMessage('me', '回发');
    expect(result.success).toBe(true);
    expect(sdk.client.channels.fetch).toHaveBeenCalledWith('user-last');
  });

  it('sendMessage：未连接时返回 Not connected', async () => {
    installDiscordSdk();
    const provider = makeProvider();
    const result = await provider.sendMessage('ch-1', 'x');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });

  it('disconnect：销毁 Client 并复位状态', async () => {
    const sdk = installDiscordSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'T' });

    await provider.disconnect();
    expect(sdk.client.destroy).toHaveBeenCalledTimes(1);
    expect(provider.getStatus().connected).toBe(false);
  });
});
