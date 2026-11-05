import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BrowserPanel } from '@/components/browser/BrowserPanel';
import { useBrowserPanel } from '@/stores/browser-store';
import { apiClient } from '@/services/api-client';
import { nativeBrowser } from '@/services/native-browser';
import { BROWSER_ANNOTATION_EVENT, BROWSER_ANNOTATION_MIME } from '@/services/browser-annotation';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/services/native-browser', () => ({
  nativeAvailable: () => true,
  nativeBrowser: vi.fn(),
  nativeInvoke: vi.fn().mockResolvedValue({}),
}));
const initial = useBrowserPanel.getState();
const snapshot = {
  pageId: 'p',
  url: 'https://example.com/',
  title: '测试网页',
  viewport: { width: 1000, height: 600 },
  screenshot: 'base64',
  elements: [],
  consoleTail: [],
  markedAt: 0,
};
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  useBrowserPanel.setState({
    ...initial,
    nativeReady: true,
    snapshot,
    tabs: [{ id: 'p', url: snapshot.url }],
    loading: false,
  });
  vi.mocked(apiClient.post).mockResolvedValue(snapshot);
  vi.mocked(nativeBrowser).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  sessionStorage.clear();
});
describe('native browser panel', () => {
  it('uses a native content area without screenshot controls or an idle takeover button', () => {
    render(<BrowserPanel />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('接管浏览器')).toBeNull();
    expect(screen.queryByText('网页下翻')).toBeNull();
    expect(screen.queryByLabelText('网页输入内容')).toBeNull();
    expect(screen.getByLabelText('搜索或输入网址')).toBeVisible();
  });
  it('submits keywords through the address bar and disables navigation until connected', async () => {
    render(<BrowserPanel />);
    const input = screen.getByLabelText('搜索或输入网址');
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        '/builtin-browser/navigate',
        expect.objectContaining({ url: '你好' }),
      ),
    );
    vi.mocked(apiClient.post).mockClear();
    act(() => useBrowserPanel.setState({ nativeReady: false }));
    fireEvent.submit(input.closest('form')!);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
  it('keeps new tabs empty, with one omnibox and no recommendations or recent sites', () => {
    sessionStorage.setItem(
      'wing-browser-history:default',
      JSON.stringify([{ url: 'https://old.example/', title: '旧网站' }]),
    );
    useBrowserPanel.setState({ snapshot: null, tabs: [], address: '', manual: true });
    render(<BrowserPanel />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByText(/最近访问|推荐|旧网站|搜索网页，开始工作/)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('接管浏览器')).toBeNull();
  });
  it('enables annotation on demand, inserts the exact DOM context and dismisses it', async () => {
    render(<BrowserPanel />);
    fireEvent.click(screen.getByRole('button', { name: '批注' }));
    await waitFor(() => expect(nativeBrowser).toHaveBeenCalledWith('annotate', { enabled: true }));
    act(() =>
      useBrowserPanel.setState({
        mode: 'browse',
        selected: {
          tag: 'button',
          text: '立即购买',
          selector: '#buy',
          outerHTML: '<button id="buy">立即购买</button>',
          rect: { x: 10, y: 20, w: 80, h: 30 },
          url: snapshot.url,
          title: snapshot.title,
        },
      }),
    );
    const insert = vi.fn();
    window.addEventListener(BROWSER_ANNOTATION_EVENT, insert);
    fireEvent.change(await screen.findByLabelText('批注要求'), {
      target: { value: '把这个按钮改成蓝色' },
    });
    fireEvent.click(screen.getByText('添加到对话'));
    expect(insert).toHaveBeenCalledTimes(1);
    const event = insert.mock.calls[0][0] as CustomEvent;
    expect(event.detail.comment).toBe('把这个按钮改成蓝色');
    expect(event.detail.attachment.mimeType).toBe(BROWSER_ANNOTATION_MIME);
    const context = Buffer.from(event.detail.attachment.url.split(',')[1], 'base64').toString(
      'utf8',
    );
    expect(context).toContain('#buy');
    expect(context).toContain(snapshot.url);
    expect(screen.queryByText('添加到对话')).toBeNull();
    expect(useBrowserPanel.getState().selected).toBeNull();
    window.removeEventListener(BROWSER_ANNOTATION_EVENT, insert);
  });
  it('changes the webview zoom through the browser engine', async () => {
    render(<BrowserPanel />);
    fireEvent.click(screen.getByLabelText('浏览器菜单'));
    fireEvent.click(await screen.findByRole('button', { name: '＋', exact: true }));
    await waitFor(() => expect(nativeBrowser).toHaveBeenCalledWith('zoom', { scale: 1.1 }));
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('offers takeover only during AI work and allows resuming after takeover', async () => {
    useBrowserPanel.setState({ agentBusy: true });
    render(<BrowserPanel />);
    expect(screen.getByText('AI 正在操作浏览器')).toBeVisible();
    fireEvent.click(screen.getByText('接管浏览器'));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByText('接管浏览器')).toBeNull();
    expect(apiClient.post).toHaveBeenCalledWith(
      '/builtin-browser/control',
      expect.objectContaining({ manual: true }),
    );
    fireEvent.click(screen.getByLabelText('浏览器菜单'));
    fireEvent.click(await screen.findByText('允许 AI 继续操作'));
    await waitFor(() => expect(useBrowserPanel.getState().manual).toBe(false));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
