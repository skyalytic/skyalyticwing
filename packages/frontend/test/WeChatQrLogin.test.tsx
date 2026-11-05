// WeChatQrLogin 组件测试：二维码获取 / 轮询状态流 / CLI 安装 / 定时器清理
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeChatQrLogin } from '@/components/channel/WeChatQrLogin';
import { apiClient } from '@/services/api-client';

vi.mock('@/services/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('react-i18next', async () => ({
  ...await vi.importActual<typeof import('react-i18next')>('react-i18next'),
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockedPost = vi.mocked(apiClient.post);
const mockedGet = vi.mocked(apiClient.get);

describe('WeChatQrLogin', () => {
  it('ignores a delayed old QR response after refreshing, without overlapping polls',async()=>{
    mockedPost.mockResolvedValueOnce({qrUrl:'data:old',sessionId:'old'} as never).mockResolvedValueOnce({qrUrl:'data:new',sessionId:'new'} as never);
    let finish!:(value:unknown)=>void;
    mockedGet.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}) as never);
    const onFill=vi.fn();render(<WeChatQrLogin variant="weixin" onFill={onFill}/>);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'channels.qrLogin'}));});
    await act(async()=>{await vi.advanceTimersByTimeAsync(9000);});
    expect(mockedGet).toHaveBeenCalledTimes(1);
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'channels.refreshQr'}));});
    await act(async()=>{finish({status:'confirmed',botToken:'stale-token'});});
    expect(onFill).not.toHaveBeenCalled();
    mockedGet.mockResolvedValueOnce({status:'confirmed',botToken:'fresh-token',baseUrl:'https://new.weixin.qq.com'} as never);
    await act(async()=>{await vi.advanceTimersByTimeAsync(3100);});
    expect(onFill).toHaveBeenCalledExactlyOnceWith({botToken:'fresh-token',baseUrl:'https://new.weixin.qq.com'});
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('点击扫码登录：请求二维码并展示，进入轮询', async () => {
    mockedPost.mockResolvedValueOnce({
      qrUrl: 'data:image/png;base64,xxx',
      sessionId: 'sid-1',
    } as never);
    mockedGet.mockResolvedValue({ status: 'pending' } as never);

    render(<WeChatQrLogin variant="weixin" onFill={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });

    // bot_type 走 URL query（后端 @Query 读取）
    expect(mockedPost).toHaveBeenCalledWith('/weixin/qr?bot_type=3');
    expect(screen.getByAltText('channels.qrAlt')).toHaveAttribute('src', 'data:image/png;base64,xxx');

    // 3s 后触发首次轮询
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(mockedGet).toHaveBeenCalledWith('/weixin/poll?sessionId=sid-1');
  });

  it('轮询到 confirmed：回填 botToken/baseUrl 并停止轮询', async () => {
    mockedPost.mockResolvedValueOnce({
      qrUrl: 'data:image/png;base64,xxx',
      sessionId: 'sid-2',
    } as never);
    const onFill = vi.fn();
    mockedGet.mockResolvedValue({
      status: 'scanned',
    } as never);

    render(<WeChatQrLogin variant="weixin" onFill={onFill} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });

    // 第一次轮询：scanned
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(screen.getByTestId('qr-status').textContent).toContain('channels.pollScanned');

    // 第二次轮询：confirmed
    mockedGet.mockResolvedValue({
      status: 'confirmed',
      botToken: 'tok-abc',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(onFill).toHaveBeenCalledWith({
      botToken: 'tok-abc',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    });
    expect(screen.getByTestId('qr-status').textContent).toContain('channels.loginSuccess');

    // 轮询已停止：再推进时间不再发请求
    const calls = mockedGet.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedGet.mock.calls.length).toBe(calls);
  });

  it('企微 variant 使用 /wecom 端点并在 confirmed 时回填 botId/secret', async () => {
    mockedPost.mockResolvedValueOnce({ qrUrl: 'data:img', sessionId: 'scode-1' } as never);
    const onFill = vi.fn();
    mockedGet.mockResolvedValue({
      status: 'confirmed',
      botId: 'bot-1',
      secret: 'sec-1',
    } as never);

    render(<WeChatQrLogin variant="wecom" onFill={onFill} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });
    expect(mockedPost).toHaveBeenCalledWith('/wecom/qr');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(mockedGet).toHaveBeenCalledWith('/wecom/poll?sessionId=scode-1');
    expect(onFill).toHaveBeenCalledWith({ botId: 'bot-1', secret: 'sec-1' });
  });

  it('二维码获取失败：展示错误信息', async () => {
    mockedPost.mockResolvedValueOnce({ sessionId: '', error: 'iLink API 连接失败' } as never);

    render(<WeChatQrLogin variant="weixin" onFill={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });

    expect(screen.getByTestId('qr-status').textContent).toContain('iLink API 连接失败');
  });

  it('CLI 安装：启动成功后轮询输出并回填 botToken', async () => {
    mockedPost.mockResolvedValueOnce({ success: true, pid: 123, cliId: 'wxcli-1' } as never);
    const onFill = vi.fn();

    render(<WeChatQrLogin variant="weixin" onFill={onFill} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.cliInstall' }));
    });
    expect(mockedPost).toHaveBeenCalledWith('/weixin/cli-install', {}, { raw: true });
    expect(screen.getByTestId('cli-status').textContent).toContain('PID: 123');

    // 第一次 CLI 状态轮询：输出行
    mockedGet.mockResolvedValueOnce({
      status: 'running',
      output: [{ type: 'out', text: 'downloading...', ts: 100 }],
      totalLines: 1,
    } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(mockedGet).toHaveBeenCalledWith('/weixin/cli-status?cliId=wxcli-1&since=0');
    expect(screen.getByText(/downloading/)).toBeInTheDocument();

    // 第二次：拿到 botToken
    mockedGet.mockResolvedValueOnce({
      status: 'confirmed',
      botToken: 'cli-tok',
      output: [],
      totalLines: 1,
    } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(onFill).toHaveBeenCalledWith({ botToken: 'cli-tok' });
    expect(screen.getByTestId('cli-status').textContent).toContain('channels.loginSuccessToken');
  });

  it('卸载时清理轮询定时器', async () => {
    mockedPost.mockResolvedValueOnce({ qrUrl: 'data:img', sessionId: 'sid-x' } as never);
    mockedGet.mockResolvedValue({ status: 'pending' } as never);

    const { unmount } = render(<WeChatQrLogin variant="weixin" onFill={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const calls = mockedGet.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedGet.mock.calls.length).toBe(calls);
  });

  it('weixin 轮询超过 60 次上限：提示超时并停止', async () => {
    mockedPost.mockResolvedValueOnce({ qrUrl: 'data:img', sessionId: 'sid-t' } as never);
    mockedGet.mockResolvedValue({ status: 'pending' } as never);

    render(<WeChatQrLogin variant="weixin" onFill={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 61);
    });
    expect(screen.getByTestId('qr-status').textContent).toContain('channels.qrTimeout');

    const calls = mockedGet.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedGet.mock.calls.length).toBe(calls);
  });

  it('wecom 轮询上限为 100 次（对齐后端 300s 会话 TTL）', async () => {
    mockedPost.mockResolvedValueOnce({ qrUrl: 'data:img', sessionId: 'sid-w' } as never);
    mockedGet.mockResolvedValue({ status: 'pending' } as never);

    render(<WeChatQrLogin variant="wecom" onFill={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' }));
    });

    // 61 次（weixin 上限）尚未超时
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 61);
    });
    expect(screen.getByTestId('qr-status').textContent).not.toContain('channels.qrTimeout');
    const callsAt61 = mockedGet.mock.calls.length;

    // 101 次触发超时并停止
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 40);
    });
    expect(screen.getByTestId('qr-status').textContent).toContain('channels.qrTimeout');
    const calls = mockedGet.mock.calls.length;
    expect(calls).toBeGreaterThan(callsAt61);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedGet.mock.calls.length).toBe(calls);
  });
});
