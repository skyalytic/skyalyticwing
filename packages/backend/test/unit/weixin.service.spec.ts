import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeixinProvider } from '../../src/modules/channels/providers/weixin.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import { HttpClientService } from '../../src/modules/core/http/http-client.service.js';
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

const dataDir = mkdtempSync(join(tmpdir(), 'weixin-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

function makeHttpMock(): { http: HttpClientService; postMock: jest.Mock } {
  const postMock = jest.fn().mockResolvedValue({ data: { errcode: 0, ret: 0 } });
  const http = { get: jest.fn(), post: postMock } as unknown as HttpClientService;
  return { http, postMock };
}

function makeProvider(
  httpMock?: { http: HttpClientService; postMock: jest.Mock },
): { provider: WeixinProvider; postMock: jest.Mock } {
  const m = httpMock || makeHttpMock();
  const provider = new WeixinProvider(loggerMock, routerMock, m.http);
  return { provider, postMock: m.postMock };
}

/** 直接触发一条 iLink 消息处理（绕过轮询定时器） */
function processMessage(provider: WeixinProvider, msg: Record<string, unknown>): Promise<void> {
  return (provider as unknown as { processMessage: (m: unknown) => Promise<void> }).processMessage(msg);
}

function captureMessages(provider: WeixinProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

/** 构造 iLink 文本消息 */
function wxMsg(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    from_user_id: 'wx-user-1',
    context_token: 'ctx-token-1',
    msg_id: 'wx-msg-' + Math.random().toString(36).slice(2, 10),
    create_time: Date.now(),
    item_list: [{ type: 1, text_item: { text: '微信消息' } }],
    ...overrides,
  };
}

describe('WeixinProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('processMessage：文本 item 拼接后分发，并缓存 context_token', async () => {
    const { provider } = makeProvider();
    const got = captureMessages(provider);

    await processMessage(provider, wxMsg({ item_list: [{ type: 1, text_item: { text: '你好' } }, { type: 1, text_item: { text: '微信' } }] }));
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('wx-user-1');
    expect(got[0].text).toBe('你好微信');
    expect(
      (provider as unknown as { contextTokens: Map<string, string> }).contextTokens.get('wx-user-1'),
    ).toBe('ctx-token-1');
  });

  it('processMessage：图片/语音 item 映射为占位文本', async () => {
    const { provider } = makeProvider();
    const got = captureMessages(provider);

    await processMessage(provider, wxMsg({ item_list: [{ type: 2, image_item: { file_path: '/p.jpg' } }] }));
    await processMessage(provider, wxMsg({ item_list: [{ type: 4 }] }));
    expect(got.map((m) => m.text)).toEqual(['[图片]', '[语音]']);
  });

  it('processMessage：空文本或无 sender 时跳过', async () => {
    const { provider } = makeProvider();
    const got = captureMessages(provider);

    await processMessage(provider, wxMsg({ item_list: [] }));
    await processMessage(provider, wxMsg({ from_user_id: '' }));
    expect(got).toHaveLength(0);
  });

  it('echo 缓存：60s 内与最近发送文本匹配的消息跳过', async () => {
    const { provider, postMock } = makeProvider();

    // 先发送一条消息（sendMessage 会写入 echoCache）
    await provider.sendMessage('wx-user-1', 'AI 回复内容');
    expect(postMock).toHaveBeenCalledTimes(1);

    // iLink 回传相同文本 → 跳过
    const got = captureMessages(provider);
    await processMessage(provider, wxMsg({ item_list: [{ type: 1, text_item: { text: 'AI 回复内容' } }] }));
    expect(got).toHaveLength(0);
  });

  it('处理锁：同一 sender 处理中时跳过新消息', async () => {
    const { provider } = makeProvider();
    const got = captureMessages(provider);
    (provider as unknown as { processingSenders: Map<string, number> }).processingSenders.set('wx-user-1', Date.now());

    await processMessage(provider, wxMsg({ item_list: [{ type: 1, text_item: { text: '锁中消息' } }] }));
    expect(got).toHaveLength(0);
  });

  it('sendMessage：超长文本按 4000 字符分块发送', async () => {
    const { provider, postMock } = makeProvider();
    const long = '长'.repeat(9000);

    const result = await provider.sendMessage('wx-user-1', long);
    expect(result.success).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(3);
    const chunks = postMock.mock.calls.map((c) => {
      const body = c[1] as { msg: { item_list: Array<{ text_item: { text: string } }> } };
      return body.msg.item_list[0].text_item.text;
    });
    expect(chunks).toEqual([long.slice(0, 4000), long.slice(4000, 8000), long.slice(8000)]);
    // 基础字段
    const firstBody = postMock.mock.calls[0][1] as { msg: Record<string, unknown> };
    expect(firstBody.msg['to_user_id']).toBe('wx-user-1');
    expect(firstBody.msg['message_type']).toBe(2);
  });

  it('sendMessage：附带 context_token（来自最近收消息缓存）', async () => {
    const { provider, postMock } = makeProvider();

    await processMessage(provider, wxMsg({ item_list: [{ type: 1, text_item: { text: '先收一条' } }] }));
    await provider.sendMessage('wx-user-1', '带上下文回复');
    const body = postMock.mock.calls[0][1] as { msg: Record<string, unknown> };
    expect(body.msg['context_token']).toBe('ctx-token-1');
  });

  it('sendMessage：errcode / ret 非零时返回失败', async () => {
    const { provider, postMock } = makeProvider();
    postMock.mockResolvedValueOnce({ data: { errcode: 1001, errmsg: 'blocked' } });
    const r1 = await provider.sendMessage('wx-user-1', '会失败');
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('1001');

    postMock.mockResolvedValueOnce({ data: { ret: -50, errcode: 0 } });
    const r2 = await provider.sendMessage('wx-user-1', 'ret 失败');
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('ret=-50');
  });

  it('sendMessage：目标为 me 且无最近联系人时报错', async () => {
    const { provider } = makeProvider();
    const result = await provider.sendMessage('me', '你好');
    expect(result.success).toBe(false);
    expect(result.error).toContain('没有记录的联系人');
  });

  it('pollMessages：游标随 get_updates_buf 推进', async () => {
    const m = makeHttpMock();
    m.postMock
      .mockResolvedValueOnce({ data: { errcode: 0, get_updates_buf: 'cursor-2', msgs: [] } })
      .mockResolvedValueOnce({ data: { errcode: 0, get_updates_buf: 'cursor-3', msgs: [] } });
    const provider = new WeixinProvider(loggerMock, routerMock, m.http);
    const poll = (provider as unknown as { pollMessages: () => Promise<void> }).pollMessages.bind(provider);

    await poll();
    expect((provider as unknown as { cursor: string }).cursor).toBe('cursor-2');
    expect(m.postMock.mock.calls[0][1].get_updates_buf).toBe('');

    await poll();
    expect((provider as unknown as { cursor: string }).cursor).toBe('cursor-3');
    expect(m.postMock.mock.calls[1][1].get_updates_buf).toBe('cursor-2');
  });

  it('pollMessages：errcode -14（会话过期）时不推进游标、不处理消息', async () => {
    const m = makeHttpMock();
    m.postMock.mockResolvedValue({
      data: { errcode: -14, errmsg: 'session expired', get_updates_buf: 'should-not-apply', msgs: [wxMsg({})] },
    });
    const provider = new WeixinProvider(loggerMock, routerMock, m.http);
    const got = captureMessages(provider);

    await expect((provider as unknown as { pollMessages: () => Promise<void> }).pollMessages()).rejects.toThrow('重新扫码');
    expect((provider as unknown as { cursor: string }).cursor).toBe('');
    expect(got).toHaveLength(0);
    expect(provider.getStatus()).toMatchObject({connected:false,lastError:'微信登录已过期，请重新扫码'});
  });

  it('connect validates the saved token before reporting connected',async()=>{
    const m=makeHttpMock();m.postMock.mockResolvedValue({data:{ret:-14}});
    const {provider}=makeProvider(m);
    expect(await provider.connect({botToken:'expired-token'})).toMatchObject({success:false,error:'微信登录已过期，请重新扫码'});
    expect(provider.getStatus().connected).toBe(false);
    expect((provider as any).pollTimer).toBeNull();
    await provider.disconnect();
  });

  it('never sends a redaction placeholder as a credential',async()=>{
    const {provider,postMock}=makeProvider();
    expect(await provider.connect({botToken:'***'})).toMatchObject({success:false,error:expect.stringContaining('凭据保存异常')});
    expect(postMock).not.toHaveBeenCalled();
    await provider.disconnect();
  });

  it('uses the QR service address, complete protocol headers and long-poll timeout',async()=>{
    const {provider,postMock}=makeProvider();
    await provider.connect({botToken:' issued-token ',baseUrl:'https://lane.weixin.qq.com/'});
    expect(postMock).toHaveBeenCalledWith('https://lane.weixin.qq.com/ilink/bot/getupdates',expect.objectContaining({base_info:{channel_version:'2.0.0'}}),expect.objectContaining({timeout:35000,headers:expect.objectContaining({Authorization:'Bearer issued-token','X-WECHAT-UIN':expect.any(String)})}));
    expect(Buffer.from(postMock.mock.calls[0][2].headers['X-WECHAT-UIN'],'base64').toString()).toMatch(/^\d+$/);
    await provider.disconnect();
  });

  it('a normal idle long-poll timeout does not label a fresh login expired',async()=>{
    const {provider,postMock}=makeProvider();postMock.mockRejectedValueOnce(new Error('Request timeout (35000ms)'));
    expect(await provider.connect({botToken:'issued-token'})).toMatchObject({success:true});
    expect(provider.getStatus()).toMatchObject({connected:true,lastError:null});
    await provider.disconnect();
  });

  it('a late polling response cannot reconnect a disabled channel',async()=>{
    const {provider,postMock}=makeProvider();await provider.connect({botToken:'valid-token'});
    let finish!:(response:unknown)=>void;postMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const poll=(provider as any).pollMessages();await provider.disconnect();
    finish({data:{ret:0,get_updates_buf:'stale'}});await poll;
    expect(provider.getStatus().connected).toBe(false);
    expect((provider as any).cursor).not.toBe('stale');
  });

  it('connect：缺少 botToken 失败；disconnect 清理定时器', async () => {
    const { provider } = makeProvider();
    const bad = await provider.connect({});
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('botToken');

    const ok = await provider.connect({ botToken: 'wt', cursor: 'c0' });
    expect(ok.success).toBe(true);
    expect((provider as unknown as { cursor: string }).cursor).toBe('c0');
    await provider.disconnect();
    expect(provider.getStatus().connected).toBe(false);
  });
});
