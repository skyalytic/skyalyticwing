import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nodeModule from 'node:module';
import { SlackProvider } from '../../src/modules/channels/providers/slack.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';
import type { IncomingMessage, RoutedSession } from '../../src/modules/channels/providers/base.provider.js';

/**
 * @slack/bolt 经 createRequire(__filename) 动态加载，jest.mock 无法拦截原生
 * require 链，故在 node:module 层注入 __sdkRegistry（与 dingtalk.service.spec 同模式）：
 * createRequire 返回的 require 先查 registry，未命中再回退原生 require。
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
const dataDir = mkdtempSync(join(tmpdir(), 'slack-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** Bolt App 实例记录器 */
interface BoltAppInstance {
  message: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
  client: {
    auth: { test: jest.Mock };
    chat: { postMessage: jest.Mock };
    files: { uploadV2: jest.Mock };
  };
}

interface InstallOptions {
  authResult?: { ok: boolean; user_id?: string; error?: string } | Error;
  postMessageResult?: { ok: boolean; ts?: string; error?: string };
}

/** 安装 @slack/bolt SDK mock，返回捕获的 App 构造函数与实例列表 */
function installBoltSdk(options: InstallOptions = {}): { App: jest.Mock; instances: BoltAppInstance[] } {
  const instances: BoltAppInstance[] = [];
  const authTest =
    options.authResult instanceof Error
      ? jest.fn().mockRejectedValue(options.authResult)
      : jest.fn().mockResolvedValue(options.authResult ?? { ok: true, user_id: 'U-BOT' });
  const App = jest.fn().mockImplementation(() => {
    const inst: BoltAppInstance = {
      message: jest.fn(),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      client: {
        auth: { test: authTest },
        chat: {
          postMessage: jest.fn().mockResolvedValue(options.postMessageResult ?? { ok: true, ts: '1234.5678' }),
        },
        files: { uploadV2: jest.fn().mockResolvedValue({ ok: true, files: [{ id: 'F1' }] }) },
      },
    };
    instances.push(inst);
    return inst;
  });
  sdkRegistry['@slack/bolt'] = { App };
  return { App, instances };
}

function makeProvider(): SlackProvider {
  return new SlackProvider(loggerMock, routerMock);
}

/** 连接并返回注册的 message listener */
async function connectAndGetListener(
  provider: SlackProvider,
  instances: BoltAppInstance[],
  cfg: Record<string, unknown> = { botToken: 'xoxb-1', signingSecret: 'sig-1' },
): Promise<(args: { message: Record<string, unknown>; say: jest.Mock; client: unknown }) => Promise<void>> {
  const result = await provider.connect(cfg);
  expect(result.success).toBe(true);
  expect(instances[0].message).toHaveBeenCalledTimes(1);
  return instances[0].message.mock.calls[0][0] as never;
}

/** 捕获分发到业务层的消息 */
function captureMessages(provider: SlackProvider): IncomingMessage[] {
  const got: IncomingMessage[] = [];
  provider.onMessage(async (_t, msg) => {
    got.push(msg);
  });
  return got;
}

function makeMessage(overrides: Record<string, unknown>): {
  message: Record<string, unknown>;
  say: jest.Mock;
  client: unknown;
} {
  return {
    message: {
      text: 'hello',
      channel: 'C-CHAN',
      ts: '1700000000.000100',
      user: 'U-USER',
      ...overrides,
    },
    say: jest.fn().mockResolvedValue(undefined),
    client: {},
  };
}

describe('SlackProvider 单元测试', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('connect：配置 appToken 时以 Socket Mode 初始化并经 auth.test 获取 botUserId', async () => {
    const { App, instances } = installBoltSdk();
    const provider = makeProvider();

    const result = await provider.connect({
      botToken: 'xoxb-socket',
      appToken: 'xapp-1',
      signingSecret: 'sig-socket',
    });

    expect(result.success).toBe(true);
    expect(App).toHaveBeenCalledWith({
      token: 'xoxb-socket',
      signingSecret: 'sig-socket',
      socketMode: true,
      appToken: 'xapp-1',
    });
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(instances[0].client.auth.test).toHaveBeenCalledTimes(1);
    expect(provider.getStatus().connected).toBe(true);
    // Socket 模式日志
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('Socket'));
  });

  it('connect：未配置 appToken 时以 HTTP Events API 模式初始化（socketMode=false）', async () => {
    const { App, instances } = installBoltSdk();
    const provider = makeProvider();

    const result = await provider.connect({ botToken: 'xoxb-http', signingSecret: 'sig-http' });

    expect(result.success).toBe(true);
    expect(App).toHaveBeenCalledWith({
      token: 'xoxb-http',
      signingSecret: 'sig-http',
      socketMode: false,
      appToken: '',
    });
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('HTTP'));
  });

  it('connect：缺少 botToken 时失败；auth.test 抛错时告警但连接仍成功', async () => {
    installBoltSdk();
    const provider = makeProvider();
    const missing = await provider.connect({ signingSecret: 'sig' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('botToken');

    const { instances } = installBoltSdk({ authResult: new Error('auth down') });
    const provider2 = makeProvider();
    const result = await provider2.connect({ botToken: 'xoxb-1' });
    expect(result.success).toBe(true);
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[Slack] Could not get bot user ID',
      { error: 'auth down' },
    );
  });

  it('自消息过滤：bot_id / subtype=bot_message / 自身 user 均不分发，正常消息分发', async () => {
    const { instances } = installBoltSdk();
    const provider = makeProvider();
    const got = captureMessages(provider);
    const listener = await connectAndGetListener(provider, instances);

    await listener(makeMessage({ bot_id: 'B01', user: 'U-OTHER-A', text: 'bot echo' }));
    await listener(makeMessage({ subtype: 'bot_message', user: 'U-OTHER-B', text: 'subtype echo' }));
    await listener(makeMessage({ user: 'U-BOT', text: 'self echo' }));
    expect(got).toHaveLength(0);

    await listener(makeMessage({ user: 'U-HUMAN-1', text: '真实用户消息' }));
    expect(got).toHaveLength(1);
    expect(got[0].from).toBe('U-HUMAN-1');
    expect(got[0].text).toBe('真实用户消息');
  });

  it('sendMessage：chat.postMessage 传参 {channel, text}，成功返回 messageId；options.channel 优先', async () => {
    const { instances } = installBoltSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'xoxb-1' });

    const result = await provider.sendMessage('C-TARGET', '你好Slack');
    expect(result).toEqual({ success: true, messageId: '1234.5678' });
    expect(instances[0].client.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C-TARGET',
      text: '你好Slack',
    });

    await provider.sendMessage('ignored', '带渠道覆盖', { channel: 'C-OVERRIDE' });
    expect(instances[0].client.chat.postMessage).toHaveBeenLastCalledWith({
      channel: 'C-OVERRIDE',
      text: '带渠道覆盖',
    });
    expect(provider.getStatus().messagesSent).toBe(2);
  });

  it('sendMessage：目标为 me 且无最近发送者时报错；API 返回 ok=false 时透出错误', async () => {
    installBoltSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'xoxb-1' });

    const noTarget = await provider.sendMessage('me', '你好');
    expect(noTarget.success).toBe(false);
    expect(noTarget.error).toContain('无法确定目标');

    const { instances } = installBoltSdk({ postMessageResult: { ok: false, error: 'channel_not_found' } });
    const provider2 = makeProvider();
    await provider2.connect({ botToken: 'xoxb-2' });
    const apiError = await provider2.sendMessage('C-GONE', 'hi');
    expect(apiError).toEqual({ success: false, error: 'channel_not_found' });
    expect(instances[0].client.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('sendImage：png 文件经 files.uploadV2 上传（file Buffer + filename + channel_id）', async () => {
    const { instances } = installBoltSdk();
    const provider = makeProvider();
    const got = captureMessages(provider);
    const listener = await connectAndGetListener(provider, instances);

    // 触发一条入站消息，设置 lastSenderId 作为上传目标
    await listener(makeMessage({ user: 'U-UPLOADER', text: '传图' }));
    expect(got).toHaveLength(1);

    const imagePath = join(dataDir, 'pic.png');
    writeFileSync(imagePath, Buffer.from('fake-png-bytes'));

    const result = await provider.sendImage(imagePath);
    expect(result.success).toBe(true);
    const params = instances[0].client.files.uploadV2.mock.calls[0][0] as Record<string, unknown>;
    expect(params['channel_id']).toBe('U-UPLOADER');
    expect(params['filename']).toBe('pic.png');
    expect(params['title']).toBe('pic.png');
    expect(params['initial_comment']).toBe('Image from AI assistant');
    expect(params['file']).toBeInstanceOf(Buffer);
    expect((params['file'] as Buffer).toString()).toBe('fake-png-bytes');
  });

  it('sendFile：非图片扩展走文件分支（initial_comment 不同）；图片扩展回 routing sendImage', async () => {
    const { instances } = installBoltSdk();
    const provider = makeProvider();
    const listener = await connectAndGetListener(provider, instances);
    await listener(makeMessage({ user: 'U-FILE-USER', text: '传文件' }));

    const docPath = join(dataDir, 'report.pdf');
    writeFileSync(docPath, Buffer.from('pdf-bytes'));

    const result = await provider.sendFile(docPath);
    expect(result.success).toBe(true);
    const params = instances[0].client.files.uploadV2.mock.calls[0][0] as Record<string, unknown>;
    expect(params['initial_comment']).toBe('File from AI assistant');
    expect(params['filename']).toBe('report.pdf');
    expect(params['channel_id']).toBe('U-FILE-USER');

    // sendFile 传入图片扩展名时回退 sendImage 分支
    const imagePath = join(dataDir, 'logo.gif');
    writeFileSync(imagePath, Buffer.from('gif-bytes'));
    await provider.sendFile(imagePath);
    const imgParams = instances[0].client.files.uploadV2.mock.calls[1][0] as Record<string, unknown>;
    expect(imgParams['initial_comment']).toBe('Image from AI assistant');
    expect(imgParams['filename']).toBe('logo.gif');

    // 文件不存在
    const missing = await provider.sendFile(join(dataDir, 'no-such.bin'));
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('File not found');
  });

  it('disconnect：停止 App 并复位连接状态', async () => {
    const { instances } = installBoltSdk();
    const provider = makeProvider();
    await provider.connect({ botToken: 'xoxb-1' });

    await provider.disconnect();
    expect(instances[0].stop).toHaveBeenCalledTimes(1);
    expect(provider.getStatus().connected).toBe(false);

    // 断开后发送失败
    const result = await provider.sendMessage('C-1', 'hi');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not connected');
  });
});
