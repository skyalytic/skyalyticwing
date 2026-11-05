import { primaryModifier, composingKey } from '@/utils/shortcuts';
import { useEffect, useRef, useState } from 'react';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { Icon } from '@/components/Icon';
import { useBrowserPanel } from '@/stores/browser-store';
import { useSessionStore } from '@/stores/session-store';
import { browserApi } from '@/services/browser-api';
import {
  browserAnnotationAttachment,
  BROWSER_ANNOTATION_EVENT,
} from '@/services/browser-annotation';
import {
  nativeAvailable,
  nativeBrowser,
  nativeInvoke,
  type NativeTab,
} from '@/services/native-browser';
import { BrowserControls } from './BrowserControls';
import { BrowserDownloads } from './BrowserDownloads';
import { WORKSPACE_RESIZE_EVENT } from '../project/use-workspace-resize';
import './browser.css';
export function BrowserPanel() {
  useWorkbenchLanguage();
  const s = useBrowserPanel();
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const surface = useRef<HTMLDivElement>(null),
    addressInput = useRef<HTMLInputElement>(null);
  const currentView = useRef({ snapshot: s.snapshot, nativeReady: s.nativeReady });
  currentView.current = { snapshot: s.snapshot, nativeReady: s.nativeReady };
  const [menu, setMenu] = useState<'more' | 'downloads' | null>(null);
  const [menuPreview, setMenuPreview] = useState('');
  const overlay = useRef({ open: false, preview: '' });
  overlay.current = { open: !!menu, preview: menuPreview };
  const menuRequest = useRef(0);
  const closeMenu = () => { menuRequest.current++; setMenu(null); setMenuPreview(''); };
  const [downloadNotice, setDownloadNotice] = useState('');
  const seenDownloads = useRef(new Map(s.downloads.map((d) => [d.id, d.status])));
  const downloadSession = useRef(sessionId);
  const downloading = s.downloads.filter((d) => d.status === 'pending').length;
  const activeDownloads = s.downloads.filter((d) => d.status === 'pending');
  const downloadProgress = activeDownloads.length && activeDownloads.every((d) => d.total_bytes && d.bytes != null)
    ? Math.min(.99, activeDownloads.reduce((n, d) => n + (d.bytes || 0), 0) / activeDownloads.reduce((n, d) => n + (d.total_bytes || 0), 0)) : undefined;
  const openMenu = (next: 'more' | 'downloads') => {
    const request = ++menuRequest.current;
    if (menu === next) { setMenu(null); return; }
    if (menu || !s.snapshot || s.snapshot.url === 'about:blank') { setMenu(next); return; }
    // Capture before resizing/hiding the native surface, so the page behind the
    // popover retains its exact viewport rather than stretching a narrower image.
    void Promise.race([
      nativeBrowser<{ screenshot?: string }>('snapshot').catch((): { screenshot?: string } => ({})),
      new Promise<{ screenshot?: string }>((resolve) => setTimeout(() => resolve({}), 1500)),
    ]).then((result) => {
      if (request === menuRequest.current) { setMenuPreview(result?.screenshot || ''); setMenu(next); }
    });
  };
  useEffect(() => {
    if (downloadSession.current !== sessionId) {
      downloadSession.current = sessionId;
      seenDownloads.current = new Map(s.downloads.map((d) => [d.id, d.status]));
      setDownloadNotice('');
      return;
    }
    const changed = [...s.downloads].reverse().find((d) => seenDownloads.current.get(d.id) !== d.status);
    seenDownloads.current = new Map(s.downloads.map((d) => [d.id, d.status]));
    if (changed) setDownloadNotice(wt(changed.status === 'pending' ? '已开始下载：{{name}}' : changed.status === 'ready' ? '下载完成：{{name}}' : '下载失败：{{name}}', { name: changed.name }));
  }, [s.downloads, sessionId]);
  useEffect(() => { if (!downloadNotice) return; const timer = setTimeout(() => setDownloadNotice(''), 5000); return () => clearTimeout(timer); }, [downloadNotice]);
  useEffect(() => { if (!menu) { menuRequest.current++; setMenuPreview(''); } }, [menu]);
  const [comment, setComment] = useState('');
  const active = s.tabs.find((t) => t.id === s.snapshot?.pageId) as NativeTab | undefined;
  const zoom = active?.zoom || 1;
  useEffect(() => {
    menuRequest.current++;
    setMenu(null);
    setMenuPreview('');
    setComment('');
  }, [sessionId]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      useBrowserPanel.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const navigate = (url?: string) => {
    if (!s.nativeReady) return;
    setMenu(null);
    void s.navigate(url);
  };
  const newTab = () =>
    void run(() => browserApi.post('/builtin-browser/tabs', { url: 'about:blank' }));
  useEffect(() => {
    if (!nativeAvailable()) return;
    let stopped = false,
      last = '',
      pending = false,
      again = false;
    const update = async () => {
      if (pending) {
        again = true;
        return;
      }
      pending = true;
      try {
        const rect = surface.current?.getBoundingClientRect();
        const { snapshot, nativeReady } = currentView.current;
        const modal = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].some(
          (e) => (e as HTMLElement).offsetWidth > 0,
        );
        const visible =
          !!rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          !modal &&
          !document.body.dataset['wingWorkspaceResizing'] &&
          !!snapshot &&
          snapshot.url !== 'about:blank' &&
          nativeReady;
        // Native child webviews sit above DOM overlays. Preserve the visible page
        // with a real snapshot while a menu is open; engines without capture reserve
        // a narrow side area instead of covering the menu with the native surface.
        const menuState = overlay.current;
        const reserved = menuState.open && !menuState.preview ? Math.min(380, (rect?.width || 1)) : 0;
        const bounds = {
          x: rect?.x || 0,
          y: rect?.y || 0,
          width: Math.max(1, (rect?.width || 1) - reserved),
          height: rect?.height || 1,
          visible: visible && !(menuState.open && (menuState.preview || reserved >= (rect?.width || 0))),
          page_id: snapshot?.pageId || null,
        };
        const serialized = JSON.stringify(bounds);
        if (serialized !== last) {
          last = serialized;
          await nativeInvoke('native_browser_bounds', { bounds });
        }
      } catch (e) {
        if (!stopped) useBrowserPanel.setState({ error: String(e) });
      } finally {
        pending = false;
        if (again && !stopped) {
          again = false;
          void update();
        }
      }
    };
    void update();
    const observer = new ResizeObserver(() => void update());
    if (surface.current) observer.observe(surface.current);
    const timer = setInterval(() => void update(), 120);
    const resized = () => void update();
    window.addEventListener(WORKSPACE_RESIZE_EVENT, resized);
    return () => {
      stopped = true;
      observer.disconnect();
      clearInterval(timer);
      window.removeEventListener(WORKSPACE_RESIZE_EVENT, resized);
      void nativeInvoke('native_browser_bounds', {
        bounds: { x: 0, y: 0, width: 1, height: 1, visible: false, page_id: null },
      }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const focusAddress = () => {
      addressInput.current?.focus();
      addressInput.current?.select();
    };
    const key = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && !composingKey(e) && primaryModifier(e) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        addressInput.current?.focus();
        addressInput.current?.select();
      }
      if (e.key === 'Escape') {
        menuRequest.current++;
        setMenu(null);
        void nativeBrowser('annotate', { enabled: false }).catch(() => {});
        s.setMode('browse');
      }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('wing-browser-focus-address', focusAddress);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('wing-browser-focus-address', focusAddress);
    };
  }, [s.setMode]);
  const annotate = () =>
    void run(async () => {
      const enabled = s.mode !== 'select';
      await nativeBrowser('annotate', { enabled });
      s.setMode(enabled ? 'select' : 'browse');
    });
  const addToChat = () => {
    const selected = s.selected;
    if (!selected || !s.snapshot) return;
    window.dispatchEvent(
      new CustomEvent(BROWSER_ANNOTATION_EVENT, {
        detail: {
          attachment: browserAnnotationAttachment(selected, s.snapshot),
          comment: comment.trim(),
        },
      }),
    );
    s.clearSelected();
    s.setMode('browse');
    setComment('');
    void nativeBrowser('annotate', { enabled: false }).catch(() => {});
  };
  const blank = !s.snapshot || s.snapshot.url === 'about:blank';
  return (
    <section className="wing-browser" aria-label={wt('内置浏览器')}>
      <div className="wing-browser-tabs" role="tablist" aria-label={wt('浏览器标签页')}>
        {s.tabs.map((tab) => (
          <div key={tab.id} className={tab.id === s.snapshot?.pageId ? 'is-active' : ''}>
            <button
              role="tab"
              aria-selected={tab.id === s.snapshot?.pageId}
              onClick={() =>
                void run(() => browserApi.post('/builtin-browser/activate', { pageId: tab.id }))
              }
            >
              <Icon name="globe" size={13} />
              <span>
                {(tab as NativeTab).title || (tab.url === 'about:blank' ? wt('新标签页') : tab.url)}
              </span>
            </button>
            <button
              aria-label={wt('关闭标签页')}
              onClick={() =>
                void run(() => browserApi.post('/builtin-browser/close', { pageId: tab.id }))
              }
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="wing-browser-new"
          onClick={newTab}
          disabled={!s.nativeReady}
          title={wt('新建标签页')}
          aria-label={wt('新建标签页')}
        >
          ＋
        </button>
      </div>
      <div className="wing-browser-toolbar">
        <button
          aria-label={wt('后退')}
          title={wt('后退')}
          disabled={!s.snapshot}
          onClick={() => void s.history('back')}
        >
          <Icon name="arrow-left" size={15} />
        </button>
        <button
          aria-label={wt('前进')}
          title={wt('前进')}
          disabled={!s.snapshot}
          onClick={() => void s.history('forward')}
        >
          <Icon name="arrow-right" size={15} />
        </button>
        <button
          aria-label={wt('刷新')}
          title={wt('刷新')}
          disabled={!s.snapshot}
          onClick={() => void s.reload()}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button
          className={s.mode === 'select' ? 'is-selected' : ''}
          aria-pressed={s.mode === 'select'}
          disabled={blank}
          onClick={annotate}
          title={wt('批注：选择网页元素并添加到对话')}
        >
          <Icon name="crosshair" size={14} />
          <span>{wt('批注')}</span>
        </button>
        <form
          className="wing-browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            navigate();
            addressInput.current?.blur();
          }}
        >
          <input
            ref={addressInput}
            aria-label={wt('搜索或输入网址')}
            placeholder={wt('搜索或输入网址')}
            value={s.address === 'about:blank' ? '' : s.address}
            onChange={(e) => s.setAddress(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </form>
        <button
          aria-label={wt('下载记录')}
          title={downloading ? wt('正在下载 {{count}} 个文件', { count: String(downloading) }) : wt('下载记录')}
          aria-expanded={menu === 'downloads'}
          className={'wing-download-trigger' + (downloading ? ' is-downloading' : '') + (downloadNotice ? ' has-update' : '')}
          onClick={() => openMenu('downloads')}
        >
          <Icon name="download" size={15} />
          {downloadProgress !== undefined && <svg className="wing-download-ring" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - downloadProgress * 100} /></svg>}
          {downloading > 0 && <span className="wing-download-count">{downloading}</span>}
        </button>
        <button
          aria-label={wt('浏览器菜单')}
          title={wt('浏览器菜单')}
          onClick={() => openMenu('more')}
        >
          •••
        </button>
      </div>
      {downloadNotice && <button className="wing-download-notice" onClick={() => openMenu('downloads')}><span role="status">{downloadNotice}</span><span>{wt('查看')}</span></button>}
      <BrowserControls />
      {(s.loading || active?.loading) && (
        <div className="wing-browser-progress" aria-label={wt('网页加载中')} />
      )}
      {s.error && (
        <div className="wing-browser-error" role="alert">
          <span>{s.error}</span>
          <button onClick={() => useBrowserPanel.setState({ error: '' })}>×</button>
        </div>
      )}
      <div className="wing-browser-content">
        {menu && <button className="wing-browser-menu-backdrop" aria-label={wt('关闭浏览器浮层')} onClick={closeMenu} />}
        {menu === 'more' && (
          <div className="wing-browser-menu">
            <div className="wing-browser-zoom">
              <span>{wt('网页缩放')}</span>
              <button
                disabled={blank}
                onClick={() =>
                  void run(() =>
                    nativeBrowser('zoom', { scale: Math.max(0.25, +(zoom - 0.1).toFixed(2)) }),
                  )
                }
              >
                −
              </button>
              <button
                disabled={blank}
                onClick={() => void run(() => nativeBrowser('zoom', { scale: 1 }))}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                disabled={blank}
                onClick={() =>
                  void run(() =>
                    nativeBrowser('zoom', { scale: Math.min(5, +(zoom + 0.1).toFixed(2)) }),
                  )
                }
              >
                ＋
              </button>
            </div>
            <button onClick={newTab}>{wt('新建标签页')}</button>
            {s.manual && (
              <button
                onClick={() =>
                  void run(async () => {
                    await browserApi.post('/builtin-browser/control', { manual: false });
                    useBrowserPanel.setState({ manual: false });
                    setMenu(null);
                  })
                }
              >
                {wt('允许 AI 继续操作')}
              </button>
            )}
            <button
              onClick={() => {
                setMenu(null);
                void s.closeAll();
              }}
            >
              {wt('关闭全部标签页')}
            </button>
          </div>
        )}
        {menu === 'downloads' && <BrowserDownloads onClose={closeMenu} />}
        <div className="wing-browser-surface" ref={surface}>
          {menu && menuPreview && <img className="wing-browser-menu-preview" src={'data:image/jpeg;base64,' + menuPreview} alt="" aria-hidden="true" />}
          {!nativeAvailable() && (
            <div className="wing-browser-notice">{wt('请在 Wing 桌面应用中使用内置浏览器')}</div>
          )}
        </div>
      </div>
      {s.mode === 'select' && (
        <div className="wing-browser-annotation-hint">
          {wt('点击网页元素添加批注，按 Esc 退出')}
          <button onClick={annotate}>{wt('取消')}</button>
        </div>
      )}
      {s.selected && (
        <div className="wing-browser-annotation">
          <div>
            <strong>{wt('已选择网页元素')}</strong>
            <button
              aria-label={wt('取消批注')}
              onClick={() => {
                s.clearSelected();
                setComment('');
                void nativeBrowser('annotate', { enabled: false }).catch(() => {});
              }}
            >
              ×
            </button>
          </div>
          <p>{s.selected.text || s.selected.hint || s.selected.tag}</p>
          <textarea
            aria-label={wt('批注要求')}
            placeholder={wt('希望 AI 对这个元素做什么？')}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
          />
          <button onClick={addToChat}>{wt('添加到对话')}</button>
        </div>
      )}
    </section>
  );
}
