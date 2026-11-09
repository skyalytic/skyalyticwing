import { isTauri } from './tauri-bridge';
import { BrowserRecovery } from './browser-recovery';
import { apiClient } from './api-client';
import { browserSession } from './browser-api';
import {
  useBrowserPanel,
  type BrowserElementDetail,
  type BrowserDownload,
} from '@/stores/browser-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
export interface NativeTab {
  id: string;
  url: string;
  title: string;
  zoom: number;
  loading: boolean;
}
interface NativeState {
  activePageId: string | null;
  tabs: NativeTab[];
  downloads: BrowserDownload[];
  error?: string | null;
  metadata?: {
    url: string;
    title: string;
    selected: BrowserElementDetail | null;
    selecting: boolean;
    shortcut?: string;
  };
}
interface Command {
  id: string;
  sessionId: string;
  op: string;
  args: Record<string, unknown>;
}
const sessions = new Set<string>();
const touchedSessions = new Set<string>();
const recovery = new BrowserRecovery({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
});
export async function nativeInvoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const runtime = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (name: string, args: Record<string, unknown>) => Promise<T> };
    }
  ).__TAURI_INTERNALS__;
  if (!runtime) throw new Error('请在 Wing 桌面应用中使用内置浏览器');
  return runtime.invoke(name, args);
}
export async function nativeBrowser<T = unknown>(
  op: string,
  args: Record<string, unknown> = {},
  sessionId = browserSession() || 'default',
): Promise<T> {
  sessions.add(sessionId);
  if (!['state', 'close', 'close-all', 'bounds', 'focus-shell'].includes(op)) {
    await recovery.restore(sessionId, (restoreOp, restoreArgs) =>
      nativeInvoke('native_browser_command', {
        command: { op: restoreOp, args: restoreArgs, session_id: sessionId },
      }),
    );
    touchedSessions.add(sessionId);
  }
  if (['close', 'close-all'].includes(op)) touchedSessions.add(sessionId);
  return nativeInvoke<T>('native_browser_command', {
    command: { op, args, session_id: sessionId },
  });
}
export function nativeAvailable() {
  return isTauri();
}
/** The desktop command channel survives hiding the browser panel. */
export function startNativeBrowserHost(): () => void {
  if (!isTauri()) return () => {};
  let stopped = false,
    timer: ReturnType<typeof setTimeout>,
    bridgeTimer: ReturnType<typeof setTimeout>,
    connected = false,
    errors = 0;
  let bridgeErrors = 0;
  let states: Record<string, NativeState> = {};
  const owner = crypto.randomUUID();
  let execution = Promise.resolve();
  async function execute(command: Command) {
    let result: unknown, error: string | undefined;
    try {
      const claim = await apiClient.post<{ allowed: boolean }>('/builtin-browser/native/claim', {
        owner,
        id: command.id,
      });
      if (!claim.allowed) return;
      sessions.add(command.sessionId);
      if (
        command.sessionId === (browserSession() || 'default') &&
        ['navigate', 'activate', 'click', 'fill'].includes(command.op)
      )
        useWorkspaceTabs.getState().openTab('browser');
      result = await nativeBrowser(command.op, command.args, command.sessionId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!stopped)
      await apiClient
        .post('/builtin-browser/native/result', { owner, id: command.id, result, error })
        .catch(() => {});
  }
  async function poll() {
    try {
      const sessionId = browserSession() || 'default';
      sessions.add(sessionId);
      const nextStates: Record<string, NativeState> = {};
      for (const id of [sessionId, ...[...sessions].filter((id) => id !== sessionId)]) {
        nextStates[id] = await nativeBrowser<NativeState>(
          'state',
          { inspect: id === sessionId },
          id,
        );
        if (touchedSessions.has(id) || nextStates[id].tabs.length)
          recovery.save(id, nextStates[id].tabs, nextStates[id].activePageId);
        if (id !== sessionId && !nextStates[id].tabs.length) sessions.delete(id);
      }
      if (stopped) return;
      states = nextStates;
      const state = states[sessionId]!;
      const tab = state.tabs.find((t) => t.id === state.activePageId);
      const current = useBrowserPanel.getState(),
        meta = state.metadata;
      const url = meta?.url || tab?.url || '';
      const changed =
        current.snapshot?.pageId !== state.activePageId || current.snapshot?.url !== url;
      if (sessionId === (browserSession() || 'default'))
        useBrowserPanel.setState({
          nativeReady: true,
          tabs: state.tabs,
          downloads: state.downloads,
          ...(state.error ? { error: state.error } : {}),
          ...(tab
            ? {
                snapshot: {
                  ...current.snapshot,
                  pageId: tab.id,
                  url,
                  title: meta?.title || tab.title,
                  viewport: current.snapshot?.viewport || { width: 1280, height: 800 },
                  screenshot: '',
                  elements: current.snapshot?.elements || [],
                  consoleTail: [],
                  markedAt: Date.now(),
                },
              }
            : { snapshot: null }),
          ...(changed && (!current.address || current.address === current.snapshot?.url)
            ? { address: url }
            : {}),
          ...(changed ? { selected: null, mode: 'browse' } : {}),
          // A cleared native selection must clear the card too; an earlier poll can
          // finish after "Add to chat" and briefly return the previous selection.
          ...(meta
            ? {
                selected: meta.selected || null,
                ...(meta.selected ? { mode: 'browse' as const } : {}),
              }
            : {}),
          ...(meta?.shortcut === 'cancelAnnotation' ? { mode: 'browse' } : {}),
        });
      if (sessionId === (browserSession() || 'default') && meta?.shortcut === 'focusAddress')
        void nativeBrowser('focus-shell')
          .then(() => window.dispatchEvent(new Event('wing-browser-focus-address')))
          .catch(() => {});
      errors = 0;
    } catch (e) {
      errors++;
      if (!stopped && errors >= 3) {
        useBrowserPanel.setState({
          nativeReady: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!stopped) timer = setTimeout(() => void poll(), errors ? 1500 : 250);
  }
  // A slow backend/model request must not stop local tab/download feedback.
  // Keep the command transport separate from the native view's state loop.
  async function pollBridge() {
    try {
      if (!connected) {
        await apiClient.post('/builtin-browser/native/connect', { owner });
        connected = true;
      }
      if (stopped) return;
      const response = await apiClient.post<{ commands: Command[] }>(
        '/builtin-browser/native/poll',
        { owner, states },
      );
      if (stopped) return;
      for (const command of response.commands)
        execution = execution.then(() => (stopped ? undefined : execute(command))).catch(() => {});
      const sessionId = browserSession() || 'default';
      const status = await apiClient.get<{ manual: boolean; agentBusy: boolean }>(
        `/builtin-browser/status?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (!stopped && sessionId === (browserSession() || 'default'))
        useBrowserPanel.setState({ manual: status.manual, agentBusy: status.agentBusy });
      bridgeErrors = 0;
    } catch (e) {
      bridgeErrors++;
      if (!stopped && bridgeErrors >= 3) {
        connected = false;
        useBrowserPanel.setState({
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (!stopped) bridgeTimer = setTimeout(() => void pollBridge(), bridgeErrors ? 1500 : 250);
  }
  void poll();
  void pollBridge();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(bridgeTimer);
    void nativeInvoke('native_browser_bounds', {
      bounds: { x: 0, y: 0, width: 1, height: 1, visible: false, page_id: null },
    }).catch(() => {});
  };
}
