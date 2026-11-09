import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { nativeInvoke } from '@/services/native-browser';
import { isTauri } from '@/services/tauri-bridge';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import './OfficePreview.css';
import { registerFileCloseGuard, registerPendingDraftCheck } from './file-tab-lifecycle';
import { WORKSPACE_RESIZE_EVENT } from './use-workspace-resize';
import { BROWSER_ANNOTATION_EVENT, BROWSER_ANNOTATION_MIME } from '@/services/browser-annotation';
const leases = new Map<string, number>();
const remoteDirty = new Map<string, boolean>();
registerPendingDraftCheck(() => [...remoteDirty.values()].some(Boolean));
window.addEventListener('beforeunload', (e) => {
  if ([...remoteDirty.values()].some(Boolean)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
const CollaboraEditor = lazy(() =>
  import('./CollaboraEditor').then((m) => ({ default: m.CollaboraEditor })),
);
interface Session {
  id: string;
  url: string;
  name: string;
}
interface State {
  ready: boolean;
  dirty?: boolean;
  savedAt: number;
  error: string;
  navigation?: string;
}
/** The same Office engine accepts pointer/keyboard and AI commands for either storage location. */
export function OfficeEditor({
  filePath,
  onOpenFile,
  remoteWorkspaceId,
}: {
  filePath: string;
  onOpenFile?: (path: string) => void;
  remoteWorkspaceId?: string;
}) {
  useWorkbenchLanguage();
  const [activePath, setActivePath] = useState(filePath);
  const onOpenRef = useRef(onOpenFile);
  onOpenRef.current = onOpenFile;
  useEffect(() => setActivePath(filePath), [filePath]);
  const [session, setSession] = useState<Session>(),
    [state, setState] = useState<State>(),
    [error, setError] = useState(''),
    [advanced, setAdvanced] = useState(false),
    [retry, setRetry] = useState(0);
  const [available, setAvailable] = useState<boolean>();
  const surface = useRef<HTMLDivElement>(null);
  const pendingSave = useRef(0);
  const lastNavigation = useRef('');
  useEffect(() => {
    lastNavigation.current = '';
  }, [session]);
  const guardKey = remoteWorkspaceId
    ? JSON.stringify(['remote', remoteWorkspaceId, activePath])
    : filePath;
  useEffect(
    () =>
      registerFileCloseGuard(guardKey, async () => {
        if (!session) return;
        const before = await apiClient.get<State>('/office-native/sessions/' + session.id);
        if (!before.ready && !before.dirty) return;
        if (before.error && !remoteWorkspaceId) throw Error(before.error);
        await apiClient.post('/office-native/sessions/' + session.id + '/command', {
          action: 'save',
        });
        for (let n = 0; n < 40; n++) {
          await new Promise((r) => setTimeout(r, 250));
          const next = await apiClient.get<State>('/office-native/sessions/' + session.id);
          if (next.error) throw Error(next.error);
          if (next.savedAt > before.savedAt && !next.dirty) return;
        }
        throw Error(wt('修改尚未保存，请处理保存提示后再关闭。'));
      }),
    [guardKey, session, remoteWorkspaceId],
  );
  useEffect(() => {
    if (advanced) return;
    let alive = true;
    setSession(undefined);
    setError('');
    setState(undefined);
    void apiClient
      .get<{ available: boolean }>('/office-native/status')
      .then(async (status) => {
        if (!alive) return;
        setAvailable(status.available);
        if (!status.available) return;
        const opened = await apiClient.post<Session>('/office-native/open', {
          path: activePath,
          ...(remoteWorkspaceId ? { remoteWorkspaceId } : {}),
        });
        if (!alive) {
          await apiClient.post('/office-native/sessions/' + opened.id + '/release', {});
          return;
        }
        if (isTauri())
          await nativeInvoke('native_office_view', {
            id: opened.id,
            action: 'open',
            url: opened.url,
          });
        if (alive) setSession(opened);
        else {
          if (isTauri())
            await nativeInvoke('native_office_view', { id: opened.id, action: 'close' });
          await apiClient.post('/office-native/sessions/' + opened.id + '/release', {});
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [activePath, retry, advanced, remoteWorkspaceId]);
  useEffect(() => {
    if (!session || advanced) return;
    let alive = true,
      lastBounds = '';
    leases.set(session.id, (leases.get(session.id) || 0) + 1);
    const bounds = () => {
      if (!isTauri()) return;
      const element = surface.current,
        rect = element?.getBoundingClientRect();
      const modal = [
        ...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="menu"]'),
      ].some((node) => (node as HTMLElement).offsetWidth > 0 && !node.contains(element));
      const visible =
        !document.body.dataset['wingWorkspaceResizing'] &&
        !modal &&
        !!element?.getClientRects().length &&
        document.visibilityState === 'visible' &&
        !!rect &&
        rect.width > 1 &&
        rect.height > 1;
      const next = {
        x: rect?.x || 0,
        y: rect?.y || 0,
        width: rect?.width || 1,
        height: rect?.height || 1,
        visible,
      };
      const key = JSON.stringify(next);
      if (key === lastBounds) return;
      lastBounds = key;
      void nativeInvoke('native_office_view', {
        id: session.id,
        action: 'bounds',
        bounds: next,
      }).catch((e) => {
        if (alive) setError(e.message);
      });
    };
    bounds();
    window.addEventListener(WORKSPACE_RESIZE_EVENT, bounds);
    const position = setInterval(bounds, 200);
    const poll = setInterval(() => {
      void apiClient
        .get<State>('/office-native/sessions/' + session.id)
        .then((next) => {
          if (alive) {
            setState(next);
            if (remoteWorkspaceId) remoteDirty.set(session.id, !!next.dirty || !!next.error);
            if (next.navigation && next.navigation !== lastNavigation.current) {
              lastNavigation.current = next.navigation;
              if (onOpenRef.current) onOpenRef.current(next.navigation);
              else setActivePath(next.navigation);
            }
            if (next.savedAt > pendingSave.current) pendingSave.current = 0;
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }, 1200);
    return () => {
      alive = false;
      leases.set(session.id, Math.max(0, (leases.get(session.id) || 1) - 1));
      clearInterval(position);
      clearInterval(poll);
      window.removeEventListener(WORKSPACE_RESIZE_EVENT, bounds);
      if (isTauri())
        void nativeInvoke('native_office_view', {
          id: session.id,
          action: 'bounds',
          bounds: { x: 0, y: 0, width: 1, height: 1, visible: false },
        }).catch(() => {});
      // Keep the hidden editor alive until its save is confirmed, never discard on a tab switch.
      void apiClient
        .get<State>('/office-native/sessions/' + session.id)
        .then(async (before) => {
          if (leases.get(session.id)) return;
          await apiClient.post('/office-native/sessions/' + session.id + '/command', {
            action: 'save',
          });
          for (let n = 0; n < 20; n++) {
            await new Promise((r) => setTimeout(r, 500));
            const current = await apiClient.get<State>('/office-native/sessions/' + session.id);
            if (current.error || leases.get(session.id)) return;
            if (current.savedAt > before.savedAt && !current.dirty) {
              if (leases.get(session.id)) return;
              remoteDirty.delete(session.id);
              if (isTauri()) {
                await nativeInvoke('native_office_view', { id: session.id, action: 'close' });
                await apiClient.post('/office-native/sessions/' + session.id + '/release', {});
              }
              return;
            }
          }
        })
        .catch(() => {});
    };
  }, [session, advanced, remoteWorkspaceId]);
  const save = () => {
    if (!session) return;
    pendingSave.current = Date.now();
    setState((s) => (s ? { ...s, savedAt: 0 } : s));
    void apiClient
      .post('/office-native/sessions/' + session.id + '/command', { action: 'save' })
      .catch((e) => setError(e.message));
  };
  const reconnect = async () => {
    if (!remoteWorkspaceId) {
      setRetry((n) => n + 1);
      return;
    }
    try {
      await apiClient.post(
        '/remote-workspaces/' + encodeURIComponent(remoteWorkspaceId) + '/connect',
        {},
      );
      setError('');
      if (session)
        await apiClient.post('/office-native/sessions/' + session.id + '/command', {
          action: 'save',
        });
      else setRetry((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const annotate = async () => {
    if (!session) return;
    try {
      const data = await apiClient.post<{ result?: { text?: string }; error?: string }>(
        '/office-native/sessions/' + session.id + '/selection',
        {},
      );
      if (data.error) throw Error(data.error);
      const text = data.result?.text || '';
      if (!text.trim()) {
        setError(wt('请先在文档中选中要讨论的文字或单元格'));
        return;
      }
      const bytes = new TextEncoder().encode(
        '[用户选中的 Office 内容]\n文件：' + filePath + '\n内容：' + text,
      );
      window.dispatchEvent(
        new CustomEvent(BROWSER_ANNOTATION_EVENT, {
          detail: {
            attachment: {
              type: 'file',
              name: 'Office 选区 · ' + text.replace(/\s+/g, ' ').slice(0, 24),
              mimeType: BROWSER_ANNOTATION_MIME,
              size: bytes.length,
              url:
                'data:' +
                BROWSER_ANNOTATION_MIME +
                ';base64,' +
                btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')),
            },
            comment: '',
          },
        }),
      );
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (advanced)
    return (
      <Suspense fallback={<p>{wt('正在加载…')}</p>}>
        <CollaboraEditor filePath={filePath} />
      </Suspense>
    );
  return (
    <section className="wing-office-engine" data-testid="office-editor">
      <header>
        <strong title={activePath}>{activePath.split(/[\\/]/).pop()}</strong>
        <span role="status">
          {state?.ready
            ? state.error
              ? wt('修改已保留，保存需要处理')
              : state.dirty
                ? wt('正在保存修改…')
                : state.savedAt
                  ? wt('已保存到原文件')
                  : wt('文档已打开')
            : session
              ? wt('正在加载内置编辑器…')
              : wt('正在准备文档…')}
        </span>
        {session && (
          <>
            <button disabled={!state?.ready} onClick={save}>
              {wt('保存')}
            </button>
            <button disabled={!state?.ready} onClick={() => void annotate()}>
              {wt('选区添加到对话')}
            </button>
            <button
              disabled={!state?.ready}
              onClick={() =>
                void apiClient.post('/office-native/sessions/' + session.id + '/command', {
                  action: 'download',
                })
              }
            >
              {wt('下载副本')}
            </button>
          </>
        )}
      </header>
      {(error || state?.error) && (
        <div className="wing-office-error" role="alert">
          {error || state?.error}
          <button onClick={() => void reconnect()}>{wt('重新连接')}</button>
        </div>
      )}
      {available === false ? (
        <div className="wing-office-setup">
          <h3>{wt('内置 Office 组件尚未就绪')}</h3>
          <p>
            {wt(
              '此版本缺少完整编辑组件，请使用完整预览版。已配置企业 Office 的用户也可以使用企业编辑服务。',
            )}
          </p>
          {!remoteWorkspaceId && (
            <button onClick={() => setAdvanced(true)}>{wt('企业 Office / 高级连接')}</button>
          )}
        </div>
      ) : session ? (
        <div ref={surface} style={{ flex: 1, minHeight: 180, position: 'relative' }}>
          {!isTauri() && (
            <div className="wing-office-setup">
              <p>{wt('在独立编辑窗口中打开完整 Office，文件仍保存到当前项目。')}</p>
              <a href={session.url} target="_blank" rel="noreferrer">
                {wt('打开 Office 编辑窗口')}
              </a>
            </div>
          )}
        </div>
      ) : (
        <div className="wing-office-setup">{wt('正在准备内置 Office…')}</div>
      )}
    </section>
  );
}
