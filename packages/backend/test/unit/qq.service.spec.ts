import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQProvider } from '../../src/modules/channels/providers/qq.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { IncomingMessage, RoutedSession } from '../../src/modules/channels/providers/base.provider.js';

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

const dataDir = mkdtempSync(join(tmpdir(), 'qq-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** 真实 fetch 备份（postback 服务器用例需要原生 HTTP） */
const realFetch = global.fetch;

function makeProvider(): QQProvider {
  return new QQProvider(loggerMock, routerMock);
}

function captureMessages(provider: QQProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

/** 安装 fetch mock（qq official / httpPostUrl 路径） */
function installFetchMock(respond: () => unknown): jest.Mock {
  const fetchMock = jest.fn().mockImplementation(() =>
    Promise.resolve({ ok: true, json: async () => respond() }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** 配置 provider（绕过 connect 的网络流程，直接预置配置态） */
function configure(provider: QQProvider, cfg: Record<string, unknown>): void {
  (provider as unknown as { config: Record<string, unknown> | null }).config = cfg;
}

describe('QQProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sendMessage（onebot/httpPostUrl）：私聊走 send_private_msg 且参数正确', async () => {
    const fetchMock = installFetchMock(() => ({ status: 'ok' }));
    const provider = makeProvider();
    configure(provider, { protocol: 'onebot', httpPostUrl: 'http://onebot.example/call' });

    const result = await provider.sendMessage('12345', '私聊消息');
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://onebot.example/call');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      action: 'send_private_msg',
      params: { user_id: 12345, message: '私聊消息' },
    });
  });

  it('sendMessage（onebot/httpPostUrl）：isGroup 走 send_group_msg', async () => {
    const fetchMock = installFetchMock(() => ({ status: 'ok' }));
    const provider = makeProvider();
    configure(provider, { protocol: 'onebot', httpPostUrl: 'http://onebot.example/call' });

    await provider.sendMessage('67890', '群消息', { isGroup: true });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.action).toBe('send_group_msg');
    expect(body.params).toEqual({ group_id: 67890, message: '群消息' });
  });

  it('sendMessage（onebot/WS）：ws.send 携带 echo 前缀与 action', async () => {
    const provider = makeProvider();
    const wsSend = jest.fn();
    configure(provider, { protocol: 'onebot', wsUrl: 'ws://onebot.example/ws' });
    (provider as unknown as { ws: unknown }).ws = { readyState: 1, send: wsSend };

    const result = await provider.sendMessage('111', 'WS 消息');
    expect(result.success).toBe(true);
    expect(wsSend).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(payload.action).toBe('send_private_msg');
    expect(payload.params).toEqual({ user_id: 111, message: 'WS 消息' });
    expect(String(payload.echo)).toMatch(/^reply-\d+$/);
  });

  it('sendMessage（official）：v2/users 私聊 API 请求参数与鉴权头', async () => {
    const fetchMock = installFetchMock(() => ({ id: 'qq-msg-1' }));
    const provider = makeProvider();
    configure(provider, { protocol: 'official' });
    (provider as unknown as { accessToken: string | null }).accessToken = 'qq-token';
    (provider as unknown as { tokenExpireAt: number }).tokenExpireAt = Date.now() + 7_200_000;

    const result = await provider.sendMessage('openid-9', '官方消息');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('qq-msg-1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sgroup.qq.com/v2/users/openid-9/messages');
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('QQBot qq-token');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.content).toBe('官方消息');
    expect(body.msg_type).toBe(0);
    expect(body.msg_seq).toBeGreaterThanOrEqual(1);
  });

  it('sendMessage（official）：token 过期时先 getAppAccessToken 再发送', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes('getAppAccessToken')) {
        return Promise.resolve({ ok: true, json: async () => ({ access_token: 'qq-token-2', expires_in: 7200 }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 'qq-msg-2' }) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = makeProvider();
    configure(provider, { protocol: 'official', appId: 'app-1', appSecret: 'sec-1' });
    // token 已过期
    (provider as unknown as { accessToken: string | null }).accessToken = 'stale';
    (provider as unknown as { tokenExpireAt: number }).tokenExpireAt = Date.now() - 1000;

    const result = await provider.sendMessage('openid-8', '刷新后发送');
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 第一次：getAppAccessToken
    const [tokenUrl, tokenOpts] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://bots.qq.com/app/getAppAccessToken');
    expect(JSON.parse((tokenOpts as RequestInit).body as string)).toEqual({ appId: 'app-1', clientSecret: 'sec-1' });
    // 第二次：消息发送，携带新 token
    const [msgUrl, msgOpts] = fetchMock.mock.calls[1];
    expect(msgUrl).toContain('/v2/users/openid-8/messages');
    expect((msgOpts as RequestInit).headers['Authorization'] as string).toBe('QQBot qq-token-2');
  });

  it('sendMessage：目标为 me 且无最近联系人时报错', async () => {
    const provider = makeProvider();
    configure(provider, { protocol: 'onebot', httpPostUrl: 'http://x/' });
    const result = await provider.sendMessage('me', '你好');
    expect(result.success).toBe(false);
    expect(result.error).toContain('没有记录的联系人');
  });

  it('防重：同一 msgId 的重复消息只分发一次', async () => {
    const provider = makeProvider();
    const got = captureMessages(provider);
    const handle = (provider as unknown as {
      handleIncomingMessage: (from: string, text: string, raw?: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessage.bind(provider);

    await handle('qq-user-1', '第一条消息', { messageId: 'dup-1' });
    await handle('qq-user-1', '第一条消息', { messageId: 'dup-1' });
    expect(got).toHaveLength(1);
  });

  it('HTTP postback：启动本地服务器接收 OneBot 消息并过滤 self 消息', async () => {
    const provider = makeProvider();
    const got = captureMessages(provider);
    const port = 21000 + Math.floor(Math.random() * 8000);

    const connected = await provider.connect({ protocol: 'onebot', httpPort: port });
    expect(connected.success).toBe(true);

    try {
      // self 消息：被过滤
      const selfResp = await realFetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_type: 'message',
          message_type: 'self',
          sub_type: 'self',
          user_id: 999,
          raw_message: '我自己发的',
          message_id: 's1',
        }),
      });
      expect(selfResp.status).toBe(200);
      expect(got).toHaveLength(0);

      // 正常私聊消息：分发
      const okResp = await realFetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          sub_type: 'friend',
          user_id: 888,
          raw_message: 'QQ 私聊消息',
          message_id: 'ok-1',
        }),
      });
      expect(okResp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(got).toHaveLength(1);
      expect(got[0].from).toBe('888');
      expect(got[0].text).toBe('QQ 私聊消息');
    } finally {
      await provider.disconnect();
    }
  });

  it('connect：onebot 缺少 wsUrl/httpPort 时失败', async () => {
    const provider = makeProvider();
    const result = await provider.connect({ protocol: 'onebot' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('wsUrl or httpPort');
  });

  it('connect：official 缺少 appId/appSecret 时失败', async () => {
    const provider = makeProvider();
    const result = await provider.connect({ protocol: 'official' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('appId or appSecret');
  });
});
