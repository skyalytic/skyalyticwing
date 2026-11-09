import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/layout/Layout';
import { ServerConnectionForm } from './components/layout/ServerConnectionForm';
import { CommandPalette } from './components/palette/CommandPalette';
import { ToastContainer } from './components/ui/Toast';
import { UpdateManager } from './components/layout/UpdateManager';
import { Icon } from './components/Icon';
import { ChatPage } from './modules/chat/ChatPage';

import { useDataLoader } from './hooks/use-data-loader';
import { useApprovalStore } from './stores/approval-store';
import { ApprovalInlineCard } from './components/chat/ApprovalInlineCard';
import { EcosystemPage } from './modules/account/EcosystemPage';
import './components/layout/account.css';

const TaskCenterPage = lazy(() =>
  import('./modules/tasks/TaskCenterPage').then((m) => ({ default: m.TaskCenterPage })),
);
const InboxPage = lazy(() =>
  import('./modules/channels/InboxPage').then((m) => ({ default: m.InboxPage })),
);
const ChannelsPage = lazy(() =>
  import('./modules/channels/ChannelsPage').then((module) => ({ default: module.ChannelsPage })),
);
const ConfigPage = lazy(() =>
  import('./modules/config/ConfigPage').then((module) => ({ default: module.ConfigPage })),
);
const ToolsPage = lazy(() =>
  import('./modules/tools/ToolsPage').then((module) => ({ default: module.ToolsPage })),
);
const CronPage = lazy(() =>
  import('./modules/cron/CronPage').then((module) => ({ default: module.CronPage })),
);
const WorkflowPage = lazy(() =>
  import('./modules/workflow/WorkflowPage').then((module) => ({ default: module.WorkflowPage })),
);
const PluginsPage = lazy(() =>
  import('./modules/plugins/PluginsPage').then((module) => ({ default: module.PluginsPage })),
);
const AgentCenterPage = lazy(() =>
  import('./modules/agents/AgentCenterPage').then((module) => ({
    default: module.AgentCenterPage,
  })),
);
const MemoryPage = lazy(() =>
  import('./modules/memory/MemoryPage').then((module) => ({ default: module.MemoryPage })),
);
const SkillsPage = lazy(() =>
  import('./modules/skills/SkillsPage').then((module) => ({ default: module.SkillsPage })),
);
const RemoteNodesPage = lazy(() =>
  import('./modules/remote/RemoteNodesPage').then((module) => ({
    default: module.RemoteNodesPage,
  })),
);
const WorktreesPage = lazy(() =>
  import('./modules/worktrees/WorktreesPage').then((module) => ({ default: module.WorktreesPage })),
);
const UsagePage = lazy(() =>
  import('./modules/usage/UsagePage').then((module) => ({ default: module.UsagePage })),
);
const SettingsPage = lazy(() =>
  import('./modules/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const BindingsPage = lazy(() =>
  import('./modules/bindings/BindingsPage').then((module) => ({ default: module.BindingsPage })),
);

import { startNativeBrowserHost } from '@/services/native-browser';

export default function App() {
  useWorkbenchLanguage();
  return (
    <>
      <UpdateManager />
      <Workbench />
    </>
  );
}

function Workbench() {
  useEffect(startNativeBrowserHost, []);
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const { loadData, loadError } = useDataLoader();
  const { pathname } = useLocation();
  const pendingApproval = useApprovalStore((state) => state.pendingApprovals[0]);

  // 首次挂载预加载所有端点
  useEffect(() => {
    void loadData();
  }, [loadData]);

  return (
    <div className="sky-workbench" style={{ height: '100%' }}>
      <CommandPalette />
      {/* 全局 toast 容器：不挂载则全应用 toast 调用均不可见（曾长期缺失） */}
      <ToastContainer />
      {pathname !== '/' && pendingApproval ? (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/60 p-4"
          style={{ zIndex: 10000 }}
        >
          <div
            className="w-full max-w-xl max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-primary)' }}
          >
            <ApprovalInlineCard request={pendingApproval} />
          </div>
        </div>
      ) : null}
      {/* 全局错误兜底：无法连接到服务器 */}
      {loadError ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(4px)',
            zIndex: 9999,
            pointerEvents: 'none',
          }}
        >
          <div className="text-center">
            <div
              className="text-xl mb-2 flex items-center justify-center gap-2"
              style={{ color: 'var(--error)' }}
            >
              <Icon name="alert" size={24} /> {t('common.cannotConnectServer')}
            </div>
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('common.checkServerStarted')}
            </div>
            <ServerConnectionForm />
          </div>
        </div>
      ) : null}
      <Suspense
        fallback={
          <div role="status" className="p-4">
            {wt('加载中…')}
          </div>
        }
      >
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<ChatPage />} />
            <Route path="/ecosystem" element={<EcosystemPage />} />
            <Route path="/agents" element={<AgentCenterPage />} />
            <Route path="/tasks" element={<TaskCenterPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/bindings" element={<BindingsPage />} />
            <Route path="/protocols" element={<Navigate to="/settings?tab=protocols" replace />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/marketplace" element={<SkillsPage />} />
            <Route path="/daemon" element={<Navigate to="/settings?tab=advanced" replace />} />
            <Route path="/remote" element={<RemoteNodesPage />} />
            <Route path="/worktrees" element={<WorktreesPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/cron" element={<CronPage />} />
            <Route path="/workflow" element={<WorkflowPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route
              path="/monitor"
              element={<Navigate to="/settings?tab=status&details=monitor" replace />}
            />
            {/* 旧 MCP 链接统一进入插件连接管理 */}
            <Route path="/mcp" element={<Navigate to="/plugins?tab=connections" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            {/* 404 兜底：未知路由重定向到对话页 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </div>
  );
}
