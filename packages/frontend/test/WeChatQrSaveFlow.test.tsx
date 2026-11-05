import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelsPage } from '@/modules/channels/ChannelsPage';
import { apiClient } from '@/services/api-client';

vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@/components/ui/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/workbench-text', () => ({ useWorkbenchLanguage: () => {}, wt: (s: string) => s }));
vi.mock('react-i18next', async () => ({ ...await vi.importActual<typeof import('react-i18next')>('react-i18next'), useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('@/modules/bindings/BindingsPage', () => ({ BindingsPage: () => null }));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('replaces an existing credential through the actual QR component and preserves it across page status refreshes until save', async () => {
  vi.useFakeTimers();
  vi.mocked(apiClient.get).mockImplementation(async (url) => {
    if (url === '/channels') return [{ id: 'weixin', type: 'weixin', name: '微信', enabled: true, status: 'error', category: 'im' }] as any;
    if (url === '/channels/status') return { weixin: { status: 'error', lastError: '凭据异常' } } as any;
    if (url === '/channels/weixin/config') return { credentials: { baseUrl: 'https://ilinkai.weixin.qq.com' }, configuredSecrets: ['botToken'] } as any;
    if (url === '/weixin/poll?sessionId=fresh-session') return { status: 'confirmed', botToken: 'fresh-test-credential', baseUrl: 'https://lane.weixin.qq.com' } as any;
    throw new Error(`Unexpected GET ${url}`);
  });
  vi.mocked(apiClient.post).mockResolvedValue({ qrUrl: 'data:image/png;base64,test', sessionId: 'fresh-session' });
  vi.mocked(apiClient.put).mockResolvedValue({ channel: { enabled: true, status: 'connected' } });
  render(<ChannelsPage />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '配置' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'channels.qrLogin' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  expect(screen.getByTestId('qr-status')).toHaveTextContent('channels.loginSuccess');
  expect(screen.queryByLabelText('AI 回复方式')).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存配置' })); });
  expect(apiClient.put).toHaveBeenCalledWith('/channels/weixin?background=true', expect.objectContaining({
    enabled: true,
    credentials: expect.objectContaining({ botToken: 'fresh-test-credential', baseUrl: 'https://lane.weixin.qq.com' }),
  }), expect.anything());
});
