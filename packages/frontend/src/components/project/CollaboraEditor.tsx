import { registerFileCloseGuard } from './file-tab-lifecycle';
import { workbenchLocale } from '@/i18n/workbench-text';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { OfficePreview } from './OfficePreview';
import './OfficePreview.css';

interface Opened {
  id: string;
  editorUrl: string;
  credential: string;
  expires: number;
}
interface EngineSettings {
  url: string;
  internal: string;
  callback: string;
  frameOrigin: string;
  managed?: boolean;
}
/** Full Office UI, in a separate origin; local files stay in the configured private deployment. */
export function CollaboraEditor({ filePath }: { filePath: string }) {
  useWorkbenchLanguage();
  const [session, setSession] = useState<Opened>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState(wt('正在连接 Office 引擎'));
  const [fallback, setFallback] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [settings, setSettings] = useState<EngineSettings>({
    url: '',
    internal: '',
    callback: window.location.origin,
    frameOrigin: window.location.origin,
  });
  const [configuring, setConfiguring] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null),
    form = useRef<HTMLFormElement>(null);
  const reloadRequested = useRef(false),
    reloadTimer = useRef<ReturnType<typeof setTimeout>>();
  const reloadBaseline = useRef(0);
  const frameName = useRef('wing-office-' + Math.random().toString(36).slice(2));
  useEffect(() => {
    let active = true;
    setSession(undefined);
    setError('');
    void apiClient
      .get<{ ready: boolean; reason?: string }>('/office-engine/status')
      .then(async (engine) => {
        if (!engine.ready) throw new Error(engine.reason || wt('Office 编辑引擎未就绪'));
        const opened = await apiClient.post<Opened>('/office-engine/open', { path: filePath });
        if (active) {
          setSession(opened);
          setStatus(wt('正在载入文档'));
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setStatus(wt('完整编辑器未连接'));
        }
      });
    void apiClient
      .get<EngineSettings>('/office-engine/configuration')
      .then((cfg) => {
        if (active)
          setSettings({
            ...cfg,
            callback: cfg.callback || window.location.origin,
            frameOrigin: cfg.frameOrigin || window.location.origin,
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [filePath, attempt]);
  useEffect(() => {
    if (session) form.current?.submit();
  }, [session]);
  useEffect(() => {
    if (!session) return;
    let active = true,
      latestSaved = 0;
    const finishReload = () => {
      if (reloadRequested.current) {
        reloadRequested.current = false;
        clearTimeout(reloadTimer.current);
        setAttempt((n) => n + 1);
      }
    };
    const origin = new URL(session.editorUrl).origin;
    const send = (MessageId: string, Values: object = {}) =>
      iframe.current?.contentWindow?.postMessage(
        JSON.stringify({ MessageId, SendTime: Date.now(), Values }),
        origin,
      );
    const message = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
      let data;
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.MessageId === 'App_LoadingStatus') {
        send('Host_PostmessageReady');
        if (data.Values?.Status === 'Document_Loaded') setStatus(wt('文档已打开 · 编辑后自动保存'));
      }
      if (data?.MessageId === 'Action_Save_Resp' && data.Values?.success === false) {
        if (data.Values?.result === 'unmodified') {
          setStatus(
            latestSaved
              ? wt('已保存到原文件 ') + new Date(latestSaved).toLocaleTimeString(workbenchLocale())
              : wt('文档未修改 · 无需重复保存'),
          );
          finishReload();
        } else setError(wt('Office 保存失败，请保留文档并重试'));
      }
    };
    window.addEventListener('message', message);
    const poll = setInterval(() => {
      void apiClient
        .get<{ savedAt: number | null; error: string | null }>(
          '/office-engine/sessions/' + session.id,
        )
        .then((state) => {
          if (!active) return;
          if (state.error) setError(state.error);
          else if (state.savedAt && state.savedAt > latestSaved) {
            latestSaved = state.savedAt;
            setStatus(
              wt('已保存到原文件 ') + new Date(state.savedAt).toLocaleTimeString(workbenchLocale()),
            );
            setError('');
            if (state.savedAt > reloadBaseline.current) finishReload();
          }
        })
        .catch(() => {
          if (active) setError(wt('保存状态连接中断，请保持编辑器打开并恢复连接'));
        });
    }, 3000);
    // Save while the editor is mounted, including files that remain open all day.
    const autosave = setInterval(
      () =>
        send('Action_Save', { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: true }),
      15000,
    );
    return () => {
      active = false;
      reloadRequested.current = false;
      clearTimeout(reloadTimer.current);
      clearInterval(poll);
      clearInterval(autosave);
      window.removeEventListener('message', message);
      send('Action_Save', { DontTerminateEdit: true, DontSaveIfUnmodified: true });
    };
  }, [session]);
  useEffect(() => {
    if (!session || fallback) return;
    return registerFileCloseGuard(filePath, async () => {
      const before = await apiClient.get<{ savedAt: number | null; error: string | null }>('/office-engine/sessions/' + session.id);
      if (before.error) throw Error(before.error);
      const origin = new URL(session.editorUrl).origin;
      let unmodified = false, failure = '';
      const response = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data?.MessageId === 'Action_Save_Resp') {
            unmodified = data.Values?.result === 'unmodified';
            if (data.Values?.success === false && !unmodified) failure = 'Office 保存失败';
          }
        } catch { /* Ignore non-protocol editor events. */ }
      };
      window.addEventListener('message', response);
      try {
        iframe.current?.contentWindow?.postMessage(JSON.stringify({ MessageId: 'Action_Save', SendTime: Date.now(), Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: true } }), origin);
        for (let n = 0; n < 60; n++) {
          await new Promise(r => setTimeout(r, 250));
          if (failure) throw Error(failure);
          const next = await apiClient.get<{ savedAt: number | null; error: string | null }>('/office-engine/sessions/' + session.id);
          if (next.error) throw Error(next.error);
          if (unmodified || (next.savedAt || 0) > (before.savedAt || 0)) return;
        }
        throw Error('未收到 Office 保存确认，已停止更新');
      } finally { window.removeEventListener('message', response); }
    });
  }, [filePath, session, fallback]);
  if (fallback) return <OfficePreview filePath={filePath} />;
  const save = () => {
    if (session) {
      setStatus(wt('正在保存'));
      iframe.current?.contentWindow?.postMessage(
        JSON.stringify({
          MessageId: 'Action_Save',
          SendTime: Date.now(),
          Values: { DontTerminateEdit: true, Notify: true },
        }),
        new URL(session.editorUrl).origin,
      );
    }
  };
  const reload = async () => {
    if (!session) return;
    try {
      const before = await apiClient.get<{ savedAt: number | null; error: string | null }>(
        '/office-engine/sessions/' + session.id,
      );
      if (before.error) {
        setError(before.error);
        return;
      }
      reloadBaseline.current = before.savedAt || 0;
      reloadRequested.current = true;
      save();
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => {
        reloadRequested.current = false;
        setError(wt('尚未确认保存，已保留当前编辑器。请恢复连接后重试。'));
      }, 30000);
    } catch {
      setError(wt('无法确认原文件状态，已保留当前编辑器。'));
    }
  };
  const configure = async () => {
    setConfiguring(true);
    setError('');
    try {
      await apiClient.post('/office-engine/configuration', settings);
      setAttempt((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('连接设置保存失败'));
    } finally {
      setConfiguring(false);
    }
  };
  return (
    <section
      className="wing-office-engine"
      data-testid="office-editor"
    >
      <header>
        <strong>{wt('Office 办公')}</strong>
        <span role="status">{status}</span>
        {session && (
          <>
            <button onClick={save}>{wt('保存原文件')}</button>
            <button title={wt('确认保存后再重新载入')} onClick={reload}>
              {wt('保存后重新载入')}
            </button>
          </>
        )}
      </header>
      {error && (
        <div role="alert" className="wing-office-error">
          {error}
          <button onClick={() => (session ? save() : setAttempt((n) => n + 1))}>
            {session ? wt('重试保存') : wt('重新连接')}
          </button>
        </div>
      )}
      {session ? (
        <>
          <form
            ref={form}
            action={session.editorUrl}
            method="post"
            target={frameName.current}
            style={{ display: 'none' }}
          >
            <input name="access_token" value={session.credential} readOnly />
            <input name="access_token_ttl" value={session.expires} readOnly />
          </form>
          <iframe
            ref={iframe}
            name={frameName.current}
            title={wt('Office 完整文档编辑器')}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </>
      ) : (
        <div className="wing-office-setup">
          <h3>{wt('完整 Word · 表格 · 幻灯片编辑')}</h3>
          <p>
            {wt(
              '连接本机或企业私有 Office 编辑引擎。编辑中的文件会发送到这个引擎，保存后回传原文件。',
            )}
          </p>
          {settings.managed ? (
            <p>{wt('此连接由实例管理员管理。请确认 Office 服务已启动，再点击重新连接。')}</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void configure();
              }}
            >
              <label>
                {wt('编辑引擎地址')}
                <input
                  type="url"
                  required
                  value={settings.url}
                  placeholder="http://127.0.0.1:9980"
                  onChange={(event) => setSettings({ ...settings, url: event.target.value })}
                />
              </label>
              <label>
                {wt('文件回传地址')}
                <input
                  type="url"
                  required
                  value={settings.callback}
                  onChange={(event) => setSettings({ ...settings, callback: event.target.value })}
                />
              </label>
              <p>
                {wt(
                  '填写编辑引擎能够访问的 Wing 服务地址；本机使用本机地址，企业部署填写内网地址。',
                )}
              </p>
              <label>
                {wt('工作台地址')}
                <input
                  type="url"
                  required
                  value={settings.frameOrigin}
                  onChange={(event) =>
                    setSettings({ ...settings, frameOrigin: event.target.value })
                  }
                />
              </label>
              <details>
                <summary>{wt('高级连接')}</summary>
                <label>
                  {wt('后端访问引擎的地址')}
                  <input
                    type="url"
                    value={settings.internal}
                    placeholder={wt('与编辑引擎地址相同')}
                    onChange={(event) => setSettings({ ...settings, internal: event.target.value })}
                  />
                </label>
              </details>
              <button disabled={configuring} type="submit">
                {configuring ? wt('正在连接…') : wt('保存并连接')}
              </button>
            </form>
          )}
          <button onClick={() => setFallback(true)}>{wt('临时使用基础内容编辑')}</button>
        </div>
      )}
    </section>
  );
}
