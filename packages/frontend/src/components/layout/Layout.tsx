import { TaskCenterLink } from '@/modules/tasks/TaskCenterLink';
import { shortcutText } from '@/utils/shortcuts';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Icon, SIDEBAR_ICONS } from '../Icon';
import { BrandLogo } from '../BrandLogo';
import { getAppVersion, isTauri } from '@/services/tauri-bridge';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { useWebSocket } from '@/hooks/use-websocket';
import { useSessions } from '@/hooks/use-sessions';
import { usePaletteStore } from '@/stores/palette-store';
import { useProjectPanel } from '@/stores/project-panel-store';
import { MandatoryUpdateOverlay } from '@/components/MandatoryUpdateOverlay';
import { AskUserModal } from '@/components/modals/AskUserModal';
import { ProjectChatSidebar } from './ProjectChatSidebar';
import { WindowTitlebar } from './WindowTitlebar';

/** 侧边栏上方显示导航，下方常驻会话区，不设置独立的会话管理按钮。
 *  其余视图（bindings/tools/cron/plugins/mcp/monitor/config/remote/worktrees/usage）
 *  与旧版相同，通过命令面板（Ctrl+K）跳转，页面路由全部保留 */
const NAV_ITEMS = [
  { id: 'chat', labelKey: 'sidebar.chat', path: '/' },
  { id: 'agents', labelKey: 'sidebar.agents', path: '/agents' },
  { id: 'inbox', labelKey: 'sidebar.inbox', path: '/inbox' },
  { id: 'channels', labelKey: 'sidebar.channels', path: '/channels' },
  { id: 'memory', labelKey: 'sidebar.memory', path: '/memory' },
  { id: 'skills', labelKey: 'sidebar.skills', path: '/skills' },
  { id: 'plugins', labelKey: 'sidebar.plugins', path: '/plugins' },
  { id: 'settings', labelKey: 'sidebar.settings', path: '/settings' },
];

/** 工程面板切换按钮（顶栏"新会话"旁，仅对话页显示；Ctrl+Alt+B 快捷键在 ProjectPanel 内注册） */
function PanelToggleButton() {
  useWorkbenchLanguage();
  const open = useProjectPanel((s) => s.open);
  const toggle = useProjectPanel((s) => s.toggle);
  return (
    <button
      className={`btn-secondary text-sm py-1 px-2 flex items-center gap-1 ${open ? 'text-blue-300 border-blue-500/50' : ''}`}
      onClick={toggle}
      title={shortcutText(
        open ? wt('收起工程面板（Ctrl+Alt+B）') : wt('展开工程面板（Ctrl+Alt+B）'),
      )}
    >
      <Icon name="panel-right" size={15} />
    </button>
  );
}

export function Layout() {
  useWorkbenchLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('wing-nav-expanded') !== 'true',
  );
  const [chatsOpen, setChatsOpen] = useState(
    () => localStorage.getItem('wing-chats-open') !== 'false',
  );
  const [chatWidth, setChatWidth] = useState(() =>
    Math.max(220, Math.min(440, Number(localStorage.getItem('wing-chat-width')) || 280)),
  );
  useEffect(() => {
    localStorage.setItem('wing-nav-expanded', String(!sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('wing-chats-open', String(chatsOpen));
  }, [chatsOpen]);
  useEffect(() => {
    localStorage.setItem('wing-chat-width', String(chatWidth));
  }, [chatWidth]);
  const [appVersion, setAppVersion] = useState('2.1.1');
  // Q 模块状态：启动后随时可见的后端模块健康（/api/status/full 宽松渲染）
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusRows, setStatusRows] = useState<Array<[string, unknown]>>([]);

  // 建立 WebSocket 连接并路由事件到各 store（全局唯一调用点）
  const { status: wsStatus, reconnect: reconnectWs } = useWebSocket();
  const connected = wsStatus === 'connected';

  // 顶栏会话选择 / 搜索 / 新会话
  const { createSession } = useSessions();
  const openPalette = usePaletteStore((s) => s.open);

  // 健康检查（仅用于兜底监控，连接徽标状态由 WS connection-store 驱动）
  useEffect(() => {
    const checkHealth = async () => {
      try {
        await authenticatedFetch('/api/health');
      } catch {
        /* 忽略：连接状态以 WS 为准 */
      }
    };
    checkHealth();
    const timer = setInterval(checkHealth, 30000);
    return () => clearInterval(timer);
  }, []);

  // 桌面端：通过 Tauri 桥接拉取真实应用版本（IPC 未就绪时保留默认值）
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const loadVersion = async () => {
      const v = await getAppVersion();
      if (!cancelled && v) setAppVersion(v);
    };
    void loadVersion();
  }, []);

  // 当前激活的导航项
  const getActiveView = useCallback(() => {
    const path = location.pathname;
    // 精确匹配优先
    const exact = NAV_ITEMS.find((n) => n.path === path);
    if (exact) return exact.id;
    // 前缀匹配子路由
    const prefix = NAV_ITEMS.find((n) => n.path !== '/' && path.startsWith(n.path));
    if (prefix) return prefix.id;
    if (path.startsWith('/config')) return 'config';
    if (path.startsWith('/ecosystem')) return 'ecosystem';
    if (path === '/workflow') return 'agents';
    return 'chat';
  }, [location.pathname]);

  const activeView = getActiveView();

  // 对话页收起聊天栏后，顶栏保留唯一的新建入口。
  const handleNewSession = useCallback(async () => {
    const id = await createSession();
    if (id) navigate('/');
  }, [createSession, navigate]);

  // 模块状态浮层：拉取 /api/status/full（宽松渲染顶层键值）
  const toggleStatus = () => {
    if (statusOpen) {
      setStatusOpen(false);
      return;
    }
    setStatusOpen(true);
    authenticatedFetch('/api/status/full')
      .then((r) => r.json())
      .then((d: Record<string, unknown>) => {
        const inner = (d?.['data'] ?? d) as Record<string, unknown> | null;
        setStatusRows(Object.entries(inner ?? {}).slice(0, 24));
      })
      .catch(() => setStatusRows([]));
  };

  // 命令面板快捷键 (Ctrl+K / Ctrl+P) 由 useCommandPalette 全局接管，此处不再处理

  return (
    <div className="sky-shell">
      <WindowTitlebar
        version={appVersion}
        actions={
          <div className="flex items-center gap-2">
            <button
              className="sky-command-button"
              onClick={openPalette}
              aria-label={shortcutText(t('common.search'))}
            >
              <Icon name="search" size={14} />
              <span>{t('workbench.search')}</span>
              <kbd>{shortcutText('Ctrl+K')}</kbd>
            </button>
            <TaskCenterLink />
            <LanguageSwitcher />
            {location.pathname === '/' && !chatsOpen && (
              <button className="btn-primary text-sm py-1 px-3" onClick={handleNewSession}>
                {wt('新会话')}
              </button>
            )}
            {location.pathname === '/' ? <PanelToggleButton /> : null}
          </div>
        }
      >
        <div className="sky-window-context-items">
          {location.pathname === '/' && !chatsOpen && (
            <button
              className="sky-icon-button"
              aria-label={wt('展开聊天栏')}
              title={wt('展开聊天栏')}
              onClick={() => setChatsOpen(true)}
            >
              <Icon name="session" size={18} />
            </button>
          )}
          <button
            type="button"
            className={`badge ${connected ? 'badge-green' : wsStatus === 'reconnecting' ? 'badge-yellow' : 'badge-red'}`}
            style={{ cursor: 'pointer' }}
            onClick={reconnectWs}
            title={t('topbar.clickToReconnect')}
          >
            {connected
              ? t('topbar.connected')
              : wsStatus === 'reconnecting'
                ? t('topbar.reconnecting')
                : t('topbar.disconnected')}
          </button>
          {/* Q 模块状态：点击展开后端各模块健康状态 */}
          <div className="relative">
            <button
              type="button"
              aria-expanded={statusOpen}
              className="badge badge-info"
              style={{ cursor: 'pointer' }}
              onClick={toggleStatus}
              title={wt('查看后端模块状态')}
            >
              {wt('模块')}
            </button>
            {statusOpen ? (
              <div
                data-no-window-drag
                className="absolute left-0 top-full mt-1 max-h-96 overflow-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 p-2 text-xs"
                style={{ width: 'min(520px, calc(100vw - 260px))' }}
              >
                {statusRows.length === 0 ? (
                  <div className="opacity-50 px-1 py-1">{wt('无法获取模块状态')}</div>
                ) : (
                  statusRows.map(([k, v]) => {
                    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
                    return (
                      <div key={k} className="flex items-baseline gap-2 py-0.5">
                        <span
                          className="opacity-70 shrink-0 text-right font-medium"
                          style={{ width: 88 }}
                        >
                          {k}
                        </span>
                        <span className="opacity-30 shrink-0">|</span>
                        <span
                          className="font-mono text-gray-300 flex-1"
                          title={text}
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {text}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        </div>
      </WindowTitlebar>

      {/* 主应用区域 */}
      <div className="sky-shell-body flex w-full min-w-0">
        {/* 侧边栏 */}
        <nav
          className={`sky-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''} bg-gray-800 border-r border-gray-700 flex flex-col transition-all duration-200 min-h-0`}
          aria-label={t('workbench.navigation')}
        >
          {/* 标题区 */}
          <div className="sky-sidebar-brand p-3 border-b border-gray-700">
            {!sidebarCollapsed ? (
              <>
                <div className="flex items-center gap-2">
                  <BrandLogo className="w-7 h-7 shrink-0" />
                  <h1 className="text-base font-bold text-blue-400">SkyalyticWing</h1>
                </div>
                <p className="text-xs mt-1 text-gray-400">{`v${appVersion}`}</p>
              </>
            ) : (
              <div className="flex justify-center">
                <BrandLogo className="w-7 h-7" />
              </div>
            )}
          </div>

          {/* 导航项 */}
          <div className="sky-navigation py-1 border-b border-gray-700 overflow-y-auto scrollbar-thin shrink-0">
            {!sidebarCollapsed && (
              <div className="sky-nav-heading">{t('workbench.navigation')}</div>
            )}
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`sidebar-item flex items-center px-3 py-1.5 cursor-pointer text-xs ${activeView === item.id ? 'active' : ''}`}
                onClick={() => {
                  navigate(item.path);
                  if (item.id === 'chat') setChatsOpen(true);
                }}
                title={t(item.labelKey)}
                aria-label={t(item.labelKey)}
                aria-current={activeView === item.id ? 'page' : undefined}
              >
                <Icon name={SIDEBAR_ICONS[item.id] || 'dashboard'} size={18} />
                {!sidebarCollapsed && <span className="text-xs ml-2">{t(item.labelKey)}</span>}
              </button>
            ))}
          </div>

          {/* 会话记录位于导航下方，占据剩余空间并独立滚动；折叠态隐藏。 */}

          {/* 底部仅保留侧栏折叠按钮。 */}
          <div className="sky-nav-footer mt-auto shrink-0 border-t border-gray-700">
            <button
              className="btn-secondary shrink-0 text-xs py-1.5 px-2"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={t(sidebarCollapsed ? 'workbench.expand' : 'workbench.collapse')}
            >
              {sidebarCollapsed ? '>' : '<'}
            </button>
          </div>
        </nav>

        {location.pathname === '/' && chatsOpen && (
          <div className="sky-chat-column" style={{ width: chatWidth }}>
            <ProjectChatSidebar onClose={() => setChatsOpen(false)} />
            <div
              className="sky-chat-resizer"
              role="separator"
              tabIndex={0}
              aria-label={wt('调整聊天栏宽度')}
              aria-orientation="vertical"
              aria-valuemin={220}
              aria-valuemax={440}
              aria-valuenow={chatWidth}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  setChatWidth((v) =>
                    Math.max(220, Math.min(440, v + (e.key === 'ArrowLeft' ? -20 : 20))),
                  );
                }
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.dataset['startX'] = String(e.clientX);
                e.currentTarget.dataset['startWidth'] = String(chatWidth);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  setChatWidth(
                    Math.max(
                      220,
                      Math.min(
                        440,
                        Number(e.currentTarget.dataset['startWidth']) +
                          e.clientX -
                          Number(e.currentTarget.dataset['startX']),
                      ),
                    ),
                  );
                }
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
            />
          </div>
        )}
        {/* 主内容区 */}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0 w-full">
          {/* 页面内容（min-h-0：防止页面被内容撑高导致整页滚动；各页面自行内部滚动） */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <Outlet />
          </div>
        </main>
      </div>

      {/* 强制更新遮罩：服务端判定版本过低时全屏阻断（z 最高、不可关闭） */}
      <MandatoryUpdateOverlay />
      <AskUserModal />
    </div>
  );
}
