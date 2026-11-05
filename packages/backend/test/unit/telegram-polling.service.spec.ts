import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramProvider } from '../../src/modules/channels/providers/telegram.service.js';
import { ChannelRouterService } from '../../src/modules/channels/channel-router.service.js';
import { HttpClientService } from '../../src/modules/core/http/http-client.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as LoggerService;

const routerMock = {} as ChannelRouterService;

/** BaseProvider 构造时会解析数据目录，指向临时目录避免触碰真实用户数据目录 */
const dataDir = mkdtempSync(join(tmpdir(), 'telegram-polling-test-'));
const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

/** 构造 HttpClientService mock：get 返回可控行为，post 不会被轮询用到 */
function makeHttpMock(): { http: HttpClientService; getMock: jest.Mock } {
  const getMock = jest.fn().mockResolvedValue({ data: { ok: false, description: 'test-error' } });
  const http = { get: getMock, post: jest.fn() } as unknown as HttpClientService;
  return { http, getMock };
}

/**
 * 回归测试：Telegram 轮询重连双循环。
 * 旧版 disconnect() 只置 polling=false，不等待旧循环退出；重连后新旧两个循环
 * 并发 getUpdates 会触发 409 Conflict。epoch 计数器使旧循环在代数变化后退出。
 */
describe('TelegramProvider 轮询 epoch 隔离（重连不产生双循环）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('重连后旧轮询循环退出，仅剩单个循环调用 getUpdates', async () => {
    const { http, getMock } = makeHttpMock();
    const provider = new TelegramProvider(loggerMock, routerMock, http);

    // 启动第一个轮询循环（epoch 1）
    provider['startPollingMode']();
    await jest.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(1); // 循环 A 首次调用

    // 循环 A 失败退避 3s 后再次调用
    await jest.advanceTimersByTimeAsync(3000);
    expect(getMock).toHaveBeenCalledTimes(2);

    // 模拟重连：disconnect 后重启轮询（epoch 递增，循环 A 应失效）
    await provider.disconnect();
    provider['startPollingMode'](); // 循环 B（epoch 2）
    await jest.advanceTimersByTimeAsync(0);
    expect(getMock).toHaveBeenCalledTimes(3); // 仅循环 B 首次调用

    // 推进 3s：循环 A 醒来后因 epoch 不匹配退出（不再调用）；循环 B 再次调用
    await jest.advanceTimersByTimeAsync(3000);
    expect(getMock).toHaveBeenCalledTimes(4);

    // 再推进 3s：仍然只有循环 B 在轮询（每个退避周期恰好 +1 次）
    await jest.advanceTimersByTimeAsync(3000);
    expect(getMock).toHaveBeenCalledTimes(5);

    // 断开收尾，避免悬挂计时器
    await provider.disconnect();
  });

  it('disconnect 递增 epoch，使在途循环失效', async () => {
    const { http } = makeHttpMock();
    const provider = new TelegramProvider(loggerMock, routerMock, http);

    provider['startPollingMode']();
    await jest.advanceTimersByTimeAsync(0);
    expect(provider['pollEpoch']).toBe(1);

    await provider.disconnect();
    expect(provider['polling']).toBe(false);
    expect(provider['pollEpoch']).toBe(2); // disconnect 后旧循环（epoch 1）已失效
  });
});
