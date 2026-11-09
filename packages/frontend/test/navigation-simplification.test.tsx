import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { Layout } from '@/components/layout/Layout';
import { SettingsPage } from '@/modules/settings/SettingsPage';
import { apiClient } from '@/services/api-client';
import { useSessionStore } from '@/stores/session-store';
import { usePaletteStore } from '@/stores/palette-store';

vi.mock('@/modules/official/OfficialSession', () => ({
  useOfficialSession: () => ({ status: null }),
}));
vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: () => ({ status: 'connected', reconnect: vi.fn() }),
}));
vi.mock('@/components/MandatoryUpdateOverlay', () => ({ MandatoryUpdateOverlay: () => null }));
vi.mock('@/components/layout/AccountMenu', () => ({ AccountMenu: () => null }));
vi.mock('@/components/layout/DesktopControlBar', () => ({ DesktopControlBar: () => null }));
vi.mock('@/services/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
const fetchMock = vi.fn();
const get = vi.mocked(apiClient.get);
const stats = {
  sessions: 3,
  messages: 8,
  toolCalls: 4,
  tokensUsed: 128,
  activeConnections: 2,
  memory: { rss: 67108864 },
};

function Location() {
  const location = useLocation();
  return (
    <output aria-label="route">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mount(path: string, layout = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        {layout ? (
          <Route element={<Layout />}>
            <Route path="/" element={<p>Chat content</p>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<p>Other page content</p>} />
          </Route>
        ) : (
          <Route path="/settings" element={<SettingsPage />} />
        )}
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  useSessionStore.setState({ sessions: [], currentSessionId: null, error: null });
  await i18n.changeLanguage('zh-CN');
  get.mockImplementation(async (path) => {
    if (path === '/monitor/health') return { status: 'ok', uptime: 3600, version: '2.0.0' };
    if (path === '/monitor/stats') return stats;
    if (path === '/monitor/logs')
      return [{ id: 'log', level: 'info', message: 'diagnostic fixture', timestamp: Date.now() }];
    if (path === '/mcp/loopback/status') return { running: false };
    if (path === '/sessions/recovery') return null;
    return [];
  });
  vi.mocked(apiClient.post).mockResolvedValue({
    id: 'new-chat',
    title: 'New chat',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
  });
  fetchMock.mockImplementation(async (path) => {
    const data = String(path).includes('/daemon/status')
      ? { running: true, installed: true, autoStart: true, platform: 'win32', pid: 42 }
      : String(path).includes('/daemon/manager/logs')
        ? { logs: [{ file: 'gateway-stdout.log', line: 'service fixture' }] }
        : String(path).includes('/monitor/stats')
          ? stats
          : { status: 'ok', version: '2.0.0', uptime: 3600 };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('approved navigation simplifications', () => {
  it('never puts a session title back into the titlebar after chat or page changes', async () => {
    useSessionStore.setState({
      currentSessionId: 's1',
      sessions: [
        { id: 's1', title: '帮我做一个小游戏随便的', createdAt: 1, updatedAt: 1, messageCount: 0 },
      ],
    });
    await act(async () => {
      mount('/', true);
    });
    const header = document.querySelector('.sky-window-titlebar') as HTMLElement;
    expect(header).not.toHaveTextContent('帮我做一个小游戏随便的');
    act(() =>
      useSessionStore.setState({
        sessions: [
          { id: 's1', title: '更新后的聊天标题', createdAt: 1, updatedAt: 2, messageCount: 0 },
        ],
      }),
    );
    expect(header).not.toHaveTextContent('更新后的聊天标题');
    fireEvent.click(screen.getByRole('button', { name: '智能体', exact: true }));
    expect(header).not.toHaveTextContent('智能体');
    expect(header.querySelector('.sky-view-title')).toBeNull();
  });
  it('labels workflows correctly and highlights agents instead of the last chat', async () => {
    await act(async () => {
      mount('/workflow', true);
    });
    expect(document.querySelector('.sky-view-title')).toBeNull();
    expect(screen.getByLabelText('route')).toHaveTextContent('/workflow');
    expect(screen.getByRole('button', { name: '智能体', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: '对话', exact: true })).not.toHaveAttribute(
      'aria-current',
    );
  });
  it('keeps one generic new-chat entry, including when the chat sidebar is collapsed', async () => {
    mount('/', true);
    expect(screen.getAllByRole('button', { name: /^新会话/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '系统服务', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起聊天栏' }));
    expect(screen.getAllByRole('button', { name: /^新会话/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '新会话', exact: true }));
    await waitFor(() => expect(useSessionStore.getState().currentSessionId).toBe('new-chat'));
    expect(apiClient.post).toHaveBeenCalledWith('/sessions', {});
  });
  it('keeps chat controls out of settings when navigating away with the chat sidebar collapsed', async () => {
    localStorage.setItem('wing-chats-open', 'false');
    mount('/settings?tab=status', true);
    expect(screen.queryByRole('button', { name: /^新会话/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /展开工程面板/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '对话', exact: true }));
    await screen.findByText('Chat content');
    expect(screen.getByRole('button', { name: '新会话 ＋', exact: true })).toBeInTheDocument();
    expect(
      within(document.querySelector('.sky-window-titlebar') as HTMLElement).queryByRole('button', {
        name: '新会话',
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起聊天栏' }));
    expect(screen.getByRole('button', { name: '新会话', exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '设置', exact: true }));
    expect(screen.queryByRole('button', { name: /^新会话/ })).toBeNull();
  });
  it.each([
    '/agents',
    '/inbox',
    '/channels',
    '/memory',
    '/skills',
    '/plugins',
    '/account',
    '/creator',
    '/check-in',
    '/enterprise',
    '/enterprise-seats',
    '/ecosystem',
    '/bindings',
    '/marketplace',
    '/daemon',
    '/remote',
    '/worktrees',
    '/usage',
    '/cron',
    '/workflow',
    '/config',
    '/tools',
    '/monitor',
    '/mcp',
    '/protocols',
    '/settings/advanced',
  ])('does not show chat creation or project controls in the shared header at %s', async (path) => {
    localStorage.setItem('wing-chats-open', 'false');
    await act(async () => {
      mount(path, true);
    });
    expect(screen.queryByRole('button', { name: /^新会话/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /展开工程面板/ })).toBeNull();
    expect(screen.queryByRole('complementary', { name: '项目与聊天' })).toBeNull();
  });
  it('opens legacy monitor links expanded and removes detail content when collapsed', async () => {
    mount('/settings?tab=monitor');
    await screen.findByText('diagnostic fixture');
    expect(screen.getByLabelText('route')).toHaveTextContent(
      '/settings?tab=status&details=monitor',
    );
    expect(screen.getByRole('heading', { name: '系统概览' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '详细监控与日志' }));
    expect(screen.queryByText('diagnostic fixture')).toBeNull();
    expect(screen.getByLabelText('route')).toHaveTextContent('/settings?tab=status');
    fireEvent.click(screen.getByRole('button', { name: '详细监控与日志' }));
    await screen.findByText('diagnostic fixture');
  });
  it('maps the legacy dashboard to an overview with monitoring collapsed', async () => {
    mount('/settings?tab=dashboard');
    await screen.findByRole('heading', { name: '系统概览' });
    expect(screen.getByRole('button', { name: '详细监控与日志' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(get).not.toHaveBeenCalledWith('/monitor/logs');
  });
  it('keeps service controls and logs inside Advanced', async () => {
    mount('/settings?tab=daemon');
    await screen.findByText(/service fixture/);
    expect(screen.getByLabelText('route')).toHaveTextContent('/settings?tab=advanced');
    expect(screen.getByRole('button', { name: '卸载服务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '禁用自动启动' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '停止服务' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/daemon/stop',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
  it('keeps inbound protocols and outbound plugin connections distinct in Chinese and English', async () => {
    mount('/settings?tab=protocols');
    await screen.findByRole('button', { name: 'MCP Loopback' });
    expect(screen.getByRole('link', { name: '打开插件' })).toHaveAttribute(
      'href',
      '/plugins?tab=connections',
    );
    expect(screen.getByRole('button', { name: 'ACP 协议' })).toBeInTheDocument();
    await act(() => i18n.changeLanguage('en'));
    expect(screen.getByRole('button', { name: 'Connect apps to Wing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Runtime status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeInTheDocument();
    expect(usePaletteStore.getState().commands.find((item) => item.id === 'go-mcp')?.path).toBe(
      '/plugins?tab=connections',
    );
    expect(
      usePaletteStore.getState().commands.find((item) => item.id === 'new-session')?.shortcut,
    ).toBe('Ctrl+N');
  });
});
