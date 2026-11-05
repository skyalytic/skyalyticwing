import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramProvider } from '../../src/modules/channels/providers/telegram.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import { HttpClientService } from '../../src/modules/core/http/http-client.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { IncomingMessage, RoutedSession } from '../../src/modules/channels/providers/base.provider.js';

/**
 * 与 telegram-polling.service.spec.ts 互补：
 * 该文件覆盖轮询重连/epoch 隔离；本文件覆盖 sendMessage（parse_mode+转义）、
 * processUpdate（消息/回调按钮解析）与 getUpdates 游标推进。
 */

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

const dataDir = mkdtempSync(join(tmpdir(), 'telegram-send-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

function makeHttpMock(): { http: HttpClientService; getMock: jest.Mock; postMock: jest.Mock } {
  const getMock = jest.fn();
  const postMock = jest.fn();
  const http = { get: getMock, post: postMock } as unknown as HttpClientService;
  return { http, getMock, postMock };
}

/** 预置已连接（token 已配置 + connected） */
function makeProvider(
  httpMock?: { http: HttpClientService; getMock: jest.Mock; postMock: jest.Mock },
): { provider: TelegramProvider; getMock: jest.Mock; postMock: jest.Mock } {
  const m = httpMock || makeHttpMock();
  const provider = new TelegramProvider(loggerMock, routerMock, m.http);
  (provider as unknown as { config: Record<string, unknown> }).config = { botToken: 'TG-TOKEN' };
  provider['status'].connected = true;
  return { provider, getMock: m.getMock, postMock: m.postMock };
}

function captureMessages(provider: TelegramProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

describe('TelegramProvider 消息收发单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sendMessage：parse_mode=HTML 且 & < > 被转义', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValue({ data: { ok: true, result: { message_id: 7 } } });

    const result = await provider.sendMessage('10086', 'a<b> & c');
    expect(result.success).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTG-TOKEN/sendMessage');
    expect(body.chat_id).toBe('10086');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe('a&lt;b&gt; &amp; c');
  });

  it('sendMessage：成功时返回 messageId', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValue({ data: { ok: true, result: { message_id: 4242 } } });

    const result = await provider.sendMessage('10086', 'hi');
    expect(result).toEqual({ success: true, messageId: '4242' });
  });

  it('sendMessage：API 返回 ok:false 时透传 description', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValue({ data: { ok: false, description: 'Bad Request: chat not found' } });

    const result = await provider.sendMessage('999', 'hi');
    expect(result.success).toBe(false);
    expect(result.error).toContain('chat not found');
  });

  it('sendMessage：目标为 me 时回退最近发送者', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValue({ data: { ok: true, result: { message_id: 1 } } });
    (provider as unknown as { lastSenderId: string | null }).lastSenderId = '70001';

    await provider.sendMessage('me', '回发');
    expect((postMock.mock.calls[0][1] as { chat_id: string }).chat_id).toBe('70001');
  });

  it('sendMessage：options.chatId 优先于 to', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValue({ data: { ok: true, result: { message_id: 1 } } });

    await provider.sendMessage('10086', '指定 chat', { chatId: '60002' });
    expect((postMock.mock.calls[0][1] as { chat_id: string }).chat_id).toBe('60002');
  });

  it('sendMessage：chatIds 映射生效（回调按钮用户 → 原 chat）', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValue({ data: { ok: true, result: { message_id: 1 } } });
    const process = (provider as unknown as {
      processUpdate: (u: unknown) => Promise<void>;
    }).processUpdate.bind(provider);

    // callback_query：from=55，原消息所在 chat=666 → chatIds[55]=666
    await process({
      update_id: 10,
      callback_query: { id: 'cq1', data: 'btn-yes', from: { id: 55 }, message: { message_id: 9, date: 1, chat: { id: 666 } } },
    });
    await provider.sendMessage('55', '按钮回复');
    expect((postMock.mock.calls[0][1] as { chat_id: string }).chat_id).toBe('666');
  });

  it('sendMessage：未配置 token 且未连接时报 Not connected', async () => {
    const { http } = makeHttpMock();
    const provider = new TelegramProvider(loggerMock, routerMock, http);
    const result = await provider.sendMessage('10086', 'hi');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });

  it('processUpdate：普通消息分发 text，无 text 时回退 caption', async () => {
    const { provider } = makeProvider();
    const got = captureMessages(provider);
    const process = (provider as unknown as {
      processUpdate: (u: unknown) => Promise<void>;
    }).processUpdate.bind(provider);

    await process({
      update_id: 1,
      message: { message_id: 11, date: Math.floor(Date.now() / 1000), text: '普通消息', chat: { id: 8001 } },
    });
    await process({
      update_id: 2,
      message: { message_id: 12, date: Math.floor(Date.now() / 1000), caption: '图片说明', chat: { id: 8002 } },
    });

    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ from: '8001', text: '普通消息' });
    expect(got[1]).toMatchObject({ from: '8002', text: '图片说明' });
  });

  it('processUpdate：callback_query 分发为 [button] 前缀文本', async () => {
    const { provider } = makeProvider();
    const got = captureMessages(provider);
    const process = (provider as unknown as {
      processUpdate: (u: unknown) => Promise<void>;
    }).processUpdate.bind(provider);

    await process({
      update_id: 3,
      callback_query: { id: 'cq2', data: 'confirm', from: { id: 9001 }, message: { message_id: 13, date: 1, chat: { id: 9001 } } },
    });

    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('9001');
    expect(got[0].text).toBe('[button] confirm');
  });

  it('getUpdates 游标：处理后 offset 推进为最大 update_id + 1', async () => {
    const m = makeHttpMock();
    // 第一次返回一批更新，第二次挂起（防轮询空转），之后断开
    m.getMock
      .mockResolvedValueOnce({
        data: {
          ok: true,
          result: [
            { update_id: 100, message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: '一', chat: { id: 500 } } },
            { update_id: 105, message: { message_id: 2, date: Math.floor(Date.now() / 1000), text: '二', chat: { id: 501 } } },
          ],
        },
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const { provider } = makeProvider(m);

    (provider as unknown as { startPollingMode: () => void }).startPollingMode();
    await new Promise((r) => setTimeout(r, 50));

    const offset = (provider as unknown as { updateOffset: number }).updateOffset;
    expect(offset).toBe(106);
    // getUpdates 请求携带当前游标
    const url = m.getMock.mock.calls[0][0] as string;
    expect(url).toContain('offset=0');
    expect(url).toContain('timeout=25');

    await provider.disconnect();
    expect((provider as unknown as { polling: boolean }).polling).toBe(false);
  });

  it('connect：getMe 验证失败时返回错误', async () => {
    const m = makeHttpMock();
    m.getMock.mockResolvedValue({ data: { ok: false, description: 'Unauthorized' } });
    const provider = new TelegramProvider(loggerMock, routerMock, m.http);

    const result = await provider.connect({ botToken: 'BAD' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unauthorized');
    expect(provider.getStatus().connected).toBe(false);
  });
});
