import { terminalCopyKey } from '@/utils/shortcuts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useChatStore } from '@/stores/chat-store';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';

interface Session { id: string; cwd: string; shell: string }
function Shell({ session, active }: { session: Session; active: boolean }) {
  const host = useRef<HTMLDivElement>(null), terminal = useRef<Terminal>();
  const [error, setError] = useState(''), [exited, setExited] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false, cursor = 0, failures = 0, timer: ReturnType<typeof setTimeout>;
    let queue: Promise<unknown> = Promise.resolve();
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Consolas, "Cascadia Mono", monospace', scrollback: 5000,
      theme: { background: '#181b20', foreground: '#e5e9f0', cursor: '#a6d7ff', selectionBackground: '#435a76' } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); terminal.current = term;
    term.textarea?.setAttribute('aria-label', wt('终端输入'));
    const input = term.onData(text => {
      queue = queue.then(() => apiClient.post(`/terminal/${session.id}/input`, { text, raw: true }))
        .catch(e => { if (!disposed) setError(String(e.message || e)); });
    });
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && terminalCopyKey(e)) {
        void navigator.clipboard.writeText(term.getSelection()).catch(e => setError(String(e))); return false;
      }
      return true;
    });
    const resize = () => {
      if (!host.current?.clientWidth || !host.current?.clientHeight) return;
      fit.fit();
      void apiClient.post(`/terminal/${session.id}/resize`, { cols: term.cols, rows: term.rows }).catch(e => { if (!disposed) setError(String(e.message || e)); });
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    const poll = async () => {
      try {
        const data = await apiClient.get<{ seq: number; data: string; exited: boolean; dropped: number; historyWarning?: string }>(`/terminal/${session.id}/output?since=${cursor}`);
        if (disposed) return;
        if (failures) { failures = 0; setError(''); }
        cursor = data.seq;
        if (data.historyWarning) setError(data.historyWarning);
        if (data.dropped) term.writeln('\r\n[较早输出已超出缓冲范围]');
        if (data.data) await new Promise<void>(r => term.write(data.data, r));
        if (data.exited) { setExited(true); return; }
        if (!disposed) timer = setTimeout(poll, 100);
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          // Retry output reads only. Replaying input could run a command twice.
          timer = setTimeout(poll, Math.min(5000, 500 * 2 ** Math.min(failures++, 4)));
        }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); observer.disconnect(); input.dispose(); term.dispose(); terminal.current = undefined; };
  }, [session.id]);
  useEffect(() => { if (active) terminal.current?.focus(); }, [active]);
  return <div className="sky-shell-pane" style={{ display: active ? 'flex' : 'none' }}>
    <div className="sky-shell-path"><span title={session.cwd}>{session.cwd}</span><button onClick={() => terminal.current?.clear()}>{wt('清屏')}</button></div>
    {error && <div className="sky-terminal-error" role="alert">{error}</div>}
    <div className="sky-xterm" ref={host} />
    {exited && <div className="sky-shell-path">{wt('进程已退出；点击 + 打开新终端')}</div>}
  </div>;
}

export function TerminalView() {
  useWorkbenchLanguage();
  const projectDir = useProjectPanel(s => s.projectDir), setPickerOpen = useProjectPanel(s => s.setPickerOpen);
  const calls = useChatStore(s => s.toolCalls);
  const [sessions, setSessions] = useState<Session[]>([]), [active, setActive] = useState('');
  const [error, setError] = useState(''), [opening, setOpening] = useState(false);
  const live = useRef<Session[]>([]), mounted = useRef(false), busy = useRef(false), initialized = useRef(false);
  const closeRemote = (id: string) => apiClient.post(`/terminal/${id}/close`, {});
  const open = useCallback(async () => {
    if (!projectDir || busy.current) return;
    busy.current = true; setOpening(true); setError('');
    try {
      const session = await apiClient.post<Session>('/terminal/open', { cwd: projectDir });
      if (!mounted.current) { await closeRemote(session.id); return; }
      live.current = [...live.current, session]; setSessions(live.current); setActive(session.id);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; if (mounted.current) setOpening(false); }
  }, [projectDir]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const s of live.current) void closeRemote(s.id).catch(() => undefined); live.current = []; };
  }, []);
  useEffect(() => { if (projectDir && !initialized.current) { initialized.current = true; void open(); } }, [projectDir, open]);
  const close = async (id: string) => {
    try {
      await closeRemote(id); live.current = live.current.filter(s => s.id !== id); setSessions(live.current);
      if (active === id) setActive(live.current.at(-1)?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const aiCalls = Object.entries(calls).filter(([, c]) => ['powershell', 'bash', 'shell', 'exec', 'exec_command', 'python', 'node'].includes(c.toolName));
  return <section className="sky-terminal" aria-label={wt('项目终端')}>
    <div className="sky-terminal-tabs" role="tablist" aria-label={wt('终端会话')}>
      {sessions.map(s => <div className="sky-shell-tab" key={s.id}>
        <button role="tab" aria-selected={active === s.id} aria-pressed={active === s.id} onClick={() => setActive(s.id)}>{s.shell.split(/[\\/]/).pop()?.replace(/\.exe$/, '')}</button>
        <button aria-label={wt('关闭终端')} title={wt('关闭并结束此终端进程')} onClick={() => void close(s.id)}>×</button>
      </div>)}
      <button title={wt('新建终端')} aria-label={wt('新建终端')} disabled={opening || sessions.length >= 8 || !projectDir} onClick={() => void open()}>+</button>
      <button role="tab" aria-selected={active === 'agent'} onClick={() => setActive('agent')}>{wt('AI 执行记录')} · {aiCalls.length}</button>
    </div>
    {error && <div className="sky-terminal-error" role="alert">{error}</div>}
    {sessions.map(s => <Shell key={s.id} session={s} active={active === s.id} />)}
    {active === 'agent' ? <div className="sky-terminal-agent">{!aiCalls.length && <p>{wt('暂无 AI 命令执行记录')}</p>}{aiCalls.map(([id,c]) => <article key={id}><header>{c.toolName} · {c.status}</header><pre>{JSON.stringify(c.args, null, 2)}</pre><pre>{typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2)}</pre></article>)}</div> : !sessions.length && <div className="sky-terminal-empty">{opening ? wt('正在启动终端…') : <><p>{wt('在项目文件夹中打开终端')}</p><button onClick={() => projectDir ? void open() : setPickerOpen(true)}>{projectDir ? wt('打开终端') : wt('选择项目文件夹')}</button></>}</div>}
  </section>;
}
