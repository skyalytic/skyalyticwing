import { uiFontSize } from '@/utils/typography';
import { wt } from '@/i18n/workbench-text';
// React 入口
import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { LanguageProvider } from './i18n/LanguageProvider';
import './i18n';
import './styles/global.css';
// index.css 与 global.css 同源（新版组件体系：btn/badge 变体、hljs 高亮、toast 等），
// 在 global 之后引入以补齐 Button/Badge/Markdown 组件依赖的全部规则
import './index.css';
import './styles/workbench.css';
import './styles/workspace.css';
import { initNativeEnhance } from './services/tauri-bridge';
import { applyStartupSettings, watchSystemAppearance } from './utils/apply-settings';
import { desktopSurface, DesktopSurfaceCoordinator, DesktopSurfacePage } from './components/layout/DesktopSurfaces';

/** 全局错误边界：防止单页渲染异常导致整站白屏 */
class GlobalErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[GlobalErrorBoundary]', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            background: 'var(--bg-primary)' ,
            color: 'var(--text-primary)',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <h1 style={{ fontSize: uiFontSize(18) }}>{wt('页面渲染出错')}</h1>
          <pre
            style={{
              maxWidth: 640,
              whiteSpace: 'pre-wrap',
              color: 'var(--error)',
              fontSize: uiFontSize(13),
            }}
          >
            {this.state.error.message || String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#0891b2',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            {wt('刷新页面')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 原生体验增强（仅 Tauri 桌面端生效，浏览器开发模式保留默认行为）
if (!desktopSurface) initNativeEnhance();

// 渲染前应用持久化的主题/字号，避免刷新后回到默认主题造成闪烁
applyStartupSettings();
const stopAppearanceWatch = watchSystemAppearance();
if (desktopSurface && desktopSurface !== 'approval') {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  document.body.style.overflow = 'hidden';
}

const container = document.getElementById('root');
if (!container) {
  throw new Error(wt('找不到 #root 挂载节点'));
}

const root = createRoot(container);
if (import.meta.hot) import.meta.hot.dispose(() => { stopAppearanceWatch(); root.unmount(); });
root.render(
  <StrictMode>
    <GlobalErrorBoundary>
      <LanguageProvider>
        <BrowserRouter>
          {desktopSurface ? <DesktopSurfacePage /> : <><DesktopSurfaceCoordinator /><App /></>}
        </BrowserRouter>
      </LanguageProvider>
    </GlobalErrorBoundary>
  </StrictMode>,
);
