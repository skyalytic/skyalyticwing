import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeComProvider } from '../../src/modules/channels/providers/wecom.service.js';
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

const dataDir = mkdtempSync(join(tmpdir(), 'wecom-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** HttpClientService mock：{ get: jest.fn(), post: jest.fn() } 形态 */
function makeHttpMock(): { http: HttpClientService; getMock: jest.Mock; postMock: jest.Mock } {
  const getMock = jest.fn();
  const postMock = jest.fn();
  const http = { get: getMock, post: postMock } as unknown as HttpClientService;
  return { http, getMock, postMock };
}

/** gettoken 成功响应 */
const TOKEN_OK = { data: { errcode: 0, errmsg: 'ok', access_token: 'wecom-token-1', expires_in: 7200 } };

/** 预置已连接状态（connect 成功后等价态） */
async function makeConnected(): Promise<{
  provider: WeComProvider;
  getMock: jest.Mock;
  postMock: jest.Mock;
}> {
  const { http, getMock, postMock } = makeHttpMock();
  const provider = new WeComProvider(loggerMock, routerMock, http);
  getMock.mockResolvedValue(TOKEN_OK);
  postMock.mockResolvedValue({ data: { errcode: 0, errmsg: 'ok', msgid: 'msg-1' } });
  const result = await provider.connect({ corpId: 'corp-1', corpSecret: 'sec-1', agentId: '1000002' });
  expect(result.success).toBe(true);
  getMock.mockClear();
  postMock.mockClear();
  return { provider, getMock, postMock };
}

function captureMessages(provider: WeComProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

describe('WeComProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('connect：corpid/corpsecret 换取 access_token（gettoken）', async () => {
    const { http, getMock } = makeHttpMock();
    getMock.mockResolvedValue(TOKEN_OK);
    const provider = new WeComProvider(loggerMock, routerMock, http);

    const result = await provider.connect({ corpId: 'ww123', corpSecret: 's#cret', agentId: '88' });
    expect(result.success).toBe(true);
    expect(provider.getStatus().connected).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(1);
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('/cgi-bin/gettoken?');
    expect(url).toContain('corpid=ww123');
    expect(url).toContain(encodeURIComponent('s#cret'));
  });

  it('connect：gettoken 失败（errcode 40013）时报错且不置位 connected', async () => {
    const { http, getMock } = makeHttpMock();
    getMock.mockResolvedValue({ data: { errcode: 40013, errmsg: 'invalid corpid' } });
    const provider = new WeComProvider(loggerMock, routerMock, http);

    const result = await provider.connect({ corpId: 'bad', corpSecret: 'bad' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('gettoken failed');
    expect(result.error).toContain('invalid corpid');
    expect(provider.getStatus().connected).toBe(false);
  });

  it('connect：缺少 corpId/corpSecret 直接失败', async () => {
    const { http } = makeHttpMock();
    const provider = new WeComProvider(loggerMock, routerMock, http);
    const result = await provider.connect({ corpId: '', corpSecret: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing corpId or corpSecret');
  });

  it('token 缓存：token 有效期内多次发送不再请求 gettoken', async () => {
    const { provider, getMock, postMock } = await makeConnected();

    await provider.sendMessage('zhangsan', '第一条');
    await provider.sendMessage('zhangsan', '第二条');
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('sendMessage：message/send 请求参数（touser/msgtype/agentid/text）', async () => {
    const { provider, postMock } = await makeConnected();

    const result = await provider.sendMessage('zhangsan', '企业微信你好');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-1');
    expect(postMock).toHaveBeenCalledTimes(1);
    const [url, body] = postMock.mock.calls[0];
    expect(url).toContain('/cgi-bin/message/send?access_token=');
    expect(url).toContain(encodeURIComponent('wecom-token-1'));
    expect(body).toEqual({
      touser: 'zhangsan',
      msgtype: 'text',
      agentid: 1000002,
      text: { content: '企业微信你好' },
    });
  });

  it('sendMessage：errcode 40014（token 失效）时强制刷新 token 并重试一次', async () => {
    const { provider, getMock, postMock } = await makeConnected();

    postMock
      .mockResolvedValueOnce({ data: { errcode: 40014, errmsg: 'invalid access_token' } })
      .mockResolvedValueOnce({ data: { errcode: 0, errmsg: 'ok', msgid: 'msg-retry' } });
    getMock.mockResolvedValue({ data: { errcode: 0, access_token: 'wecom-token-2', expires_in: 7200 } });

    const result = await provider.sendMessage('lisi', '重试消息');
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-retry');
    // 首次发送 + 刷新 gettoken + 重试发送
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(getMock).toHaveBeenCalledTimes(1);
    // 第二次发送携带新 token
    const retryUrl = postMock.mock.calls[1][0] as string;
    expect(retryUrl).toContain(encodeURIComponent('wecom-token-2'));
  });

  it('resolveTarget 回退：to 为 me/self 时回退最近发送者，options.chatId 优先', async () => {
    const { provider, postMock } = await makeConnected();
    (provider as unknown as { lastSenderId: string | null }).lastSenderId = 'wangwu';

    // me → lastSenderId
    await provider.sendMessage('me', '回发消息');
    expect((postMock.mock.calls[0][1] as { touser: string }).touser).toBe('wangwu');

    // options.chatId 显式指定时覆盖 touser
    await provider.sendMessage('me', '指定会话', { chatId: 'zhaoliu' });
    expect((postMock.mock.calls[1][1] as { touser: string }).touser).toBe('zhaoliu');
  });

  it('sendMessage：无法确定目标时返回错误', async () => {
    const { provider, postMock } = await makeConnected();
    const result = await provider.sendMessage('', '没有目标');
    expect(result.success).toBe(false);
    expect(result.error).toContain('无法确定目标');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('handleCallbackMessage：text/voice/image 消息 XML 解析后分发', async () => {
    const { provider } = await makeConnected();
    const got = captureMessages(provider);
    const handle = (provider as unknown as {
      handleCallbackMessage: (xml: string) => Promise<void>;
    }).handleCallbackMessage.bind(provider);

    await handle(
      '<xml><ToUserName><![CDATA[ww1]]></ToUserName><FromUserName><![CDATA[u-text]]></FromUserName>' +
        '<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好企微]]></Content>' +
        '<MsgId>1001</MsgId><CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime></xml>',
    );
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('u-text');
    expect(got[0].text).toBe('你好企微');

    await handle(
      '<xml><FromUserName><![CDATA[u-voice]]></FromUserName><MsgType><![CDATA[voice]]></MsgType>' +
        '<Recognition><![CDATA[语音识别结果]]></Recognition><MsgId>1002</MsgId>' +
        '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime></xml>',
    );
    expect(got[1].text).toBe('语音识别结果');

    await handle(
      '<xml><FromUserName><![CDATA[u-img]]></FromUserName><MsgType><![CDATA[image]]></MsgType>' +
        '<MsgId>1003</MsgId><CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime></xml>',
    );
    expect(got[2].text).toBe('[图片]');
  });

  it('handleCallbackMessage：event 类型不进入消息流', async () => {
    const { provider } = await makeConnected();
    const got = captureMessages(provider);
    const handle = (provider as unknown as {
      handleCallbackMessage: (xml: string) => Promise<void>;
    }).handleCallbackMessage.bind(provider);

    await handle(
      '<xml><FromUserName><![CDATA[u-event]]></FromUserName><MsgType><![CDATA[event]]></MsgType>' +
        '<Event><![CDATA[subscribe]]></Event></xml>',
    );
    expect(got).toHaveLength(0);
  });

  it('disconnect：复位 token 与连接状态', async () => {
    const { provider } = await makeConnected();
    await provider.disconnect();
    expect(provider.getStatus().connected).toBe(false);
  });
});
