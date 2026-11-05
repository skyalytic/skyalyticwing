import { wt } from '@/i18n/workbench-text';
// Native webviews handle user input. This store holds toolbar state and AI observations.
import { create } from 'zustand';
import { browserApi as apiClient } from '@/services/browser-api';
import { useSessionStore } from './session-store';
import { toast } from '@/components/ui/Toast';

/** 页面内可交互元素（与后端 BrowserElementInfo 对齐） */
export interface BrowserElementInfo {
  index: number;
  tag: string;
  role?: string;
  text?: string;
  hint?: string;
  href?: string;
  rect: { x: number; y: number; w: number; h: number };
  input?: boolean;
}

/** 页面快照（截图 + 元素清单 + console 尾部） */
export interface BrowserSnapshot {
  pageId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** JPEG base64（无 data: 前缀） */
  screenshot: string;
  elements: BrowserElementInfo[];
  consoleTail: string[];
  markedAt: number;
}

/** 坐标点选/按索引命中的元素详情 */
export interface BrowserElementDetail {
  url?: string;
  title?: string;
  index?: number;
  tag: string;
  role?: string;
  text?: string;
  hint?: string;
  href?: string;
  selector: string;
  outerHTML: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface BrowserDownload {
  id: string;
  name: string;
  status: string;
  path?: string;
  url?: string;
  created_at?: number;
  bytes?: number | null;
  total_bytes?: number | null;
  error?: string | null;
}
interface BrowserPanelState {
  nativeReady: boolean;
  manual: boolean;
  agentBusy: boolean;
  tabs: Array<{ id: string; url: string }>;
  downloads: BrowserDownload[];
  /** 当前页面快照（null = 未打开任何页面） */
  snapshot: BrowserSnapshot | null;
  /** 导航/操作进行中（截图上盖加载层） */
  loading: boolean;
  error: string;
  /** 地址栏输入值（导航成功后同步为实际 url） */
  address: string;
  /** browse=点击即转发页面点击；select=点击选中元素 */
  mode: 'browse' | 'select';
  /** 选元素模式命中的元素详情 */
  selected: BrowserElementDetail | null;
  /** console 面板展开 */
  consoleOpen: boolean;
  setAddress: (v: string) => void;
  setMode: (m: 'browse' | 'select') => void;
  clearSelected: () => void;
  toggleConsole: () => void;
  /** 导航到地址栏 url（首次自动拉起浏览器） */
  navigate: (url?: string) => Promise<void>;
  /** 重新获取快照 */
  refresh: () => Promise<void>;
  /** 在面板可见时同步 AI 操作结果，不启动浏览器，不覆盖用户正在进行的操作。 */
  sync: () => Promise<void>;
  input: (action: 'type' | 'key', value: string) => Promise<void>;
  /** 浏览模式：转发页面点击（视口坐标） */
  clickAt: (x: number, y: number) => Promise<void>;
  /** 选元素模式：命中元素详情 */
  pickAt: (x: number, y: number) => Promise<void>;
  /** 悬停（视口坐标，浏览模式 hover 菜单等） */
  hoverAt: (x: number, y: number) => Promise<void>;
  /** 导航历史 */
  history: (dir: 'back' | 'forward') => Promise<void>;
  /** 刷新页面 */
  reload: () => Promise<void>;
  /** 滚轮（视口坐标 + 位移） */
  scrollAt: (x: number, y: number, dy: number) => Promise<void>;
  /** 关闭浏览器（全部页面） */
  closeAll: () => Promise<void>;
}

/** 统一处理动作返回：动作类接口都回传最新快照 */
function applyResult(
  set: (p: Partial<BrowserPanelState>) => void,
  r: BrowserSnapshot & { detail?: string },
) {
  set({ snapshot: r, address: r.url, error: '' });
}

export const useBrowserPanel = create<BrowserPanelState>((set, get) => ({
  nativeReady: false,
  manual: false,
  agentBusy: false,
  tabs: [],
  downloads: [],
  snapshot: null,
  loading: false,
  error: '',
  address: '',
  mode: 'browse',
  selected: null,
  consoleOpen: false,

  setAddress: (v) => set({ address: v }),
  setMode: (m) => set({ mode: m, selected: null }),
  clearSelected: () => set({ selected: null }),
  toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),

  navigate: async (url) => {
    const target = (url ?? get().address).trim();
    if (!target) {
      toast.warn(wt('请输入网址或搜索关键词'));
      return;
    }
    set({ loading: true, error: '', selected: null });
    try {
      const r = await apiClient.post<BrowserSnapshot>('/builtin-browser/navigate', { url: target });
      set({ snapshot: r, address: r.url });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  refresh: async () => {
    set({ loading: true, error: '' });
    try {
      const r = await apiClient.post<BrowserSnapshot>('/builtin-browser/snapshot', {});
      set({ snapshot: r, address: r.url });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  sync: async () => {
    if (get().nativeReady) return;
    if (get().loading) return;
    const before = get().snapshot;
    try {
      const status = await apiClient.get<{
        running: boolean;
        activePageId: string | null;
        manual?: boolean;
        busy?: boolean;
        agentBusy?: boolean;
        tabs?: Array<{ id: string; url: string }>;
        downloads?: Array<{ id: string; name: string; status: string }>;
      }>('/builtin-browser/status');
      if (get().loading || get().snapshot !== before) return;
      set({
        manual: !!status.manual,
        agentBusy: !!status.agentBusy,
        tabs: status.tabs ?? [],
        downloads: status.downloads ?? [],
      });
      if (!status.running || !status.activePageId) {
        if (before) set({ snapshot: null, selected: null });
        return;
      }
      const snapshot = await apiClient.post<BrowserSnapshot>('/builtin-browser/snapshot', {
        pageId: status.activePageId,
      });
      if (!get().loading && get().snapshot === before) {
        set({
          snapshot,
          ...(get().address === before?.url || !before ? { address: snapshot.url } : {}),
        });
      }
    } catch {
      /* 后台同步失败保留当前画面，用户操作仍会展示错误。 */
    }
  },

  input: async (action, value) => {
    const pid = get().snapshot?.pageId;
    if (!pid || get().loading) return;
    set({ loading: true, error: '', selected: null });
    try {
      const r = await apiClient.post<BrowserSnapshot>('/builtin-browser/action', {
        pageId: pid,
        action,
        ...(action === 'type' ? { text: value } : { key: value }),
      });
      applyResult(set, r);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  clickAt: async (x, y) => {
    const pid = get().snapshot?.pageId;
    if (!pid) return;
    set({ loading: true, error: '' });
    try {
      const r = await apiClient.post<BrowserSnapshot & { ok: boolean }>('/builtin-browser/action', {
        pageId: pid,
        action: 'click',
        x,
        y,
      });
      applyResult(set, r);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  pickAt: async (x, y) => {
    const pid = get().snapshot?.pageId;
    if (!pid) return;
    try {
      const r = await apiClient.post<BrowserElementDetail | null>('/builtin-browser/element', {
        pageId: pid,
        x,
        y,
      });
      if (r) set({ selected: r });
      else toast.info(wt('未命中元素'), wt('该位置没有可交互元素，试试切换浏览模式直接点击'));
    } catch (e) {
      toast.error(wt('元素识别失败'), e instanceof Error ? e.message : undefined);
    }
  },

  hoverAt: async (x, y) => {
    const pid = get().snapshot?.pageId;
    if (!pid) return;
    set({ loading: true });
    try {
      const r = await apiClient.post<BrowserSnapshot & { ok: boolean }>('/builtin-browser/action', {
        pageId: pid,
        action: 'hover',
        x,
        y,
      });
      applyResult(set, r);
    } catch {
      // 悬停失败不打断（部分页面 hover 无响应属正常）
    } finally {
      set({ loading: false });
    }
  },

  history: async (dir) => {
    const pid = get().snapshot?.pageId;
    if (!pid) return;
    set({ loading: true, error: '', selected: null });
    try {
      const r = await apiClient.post<BrowserSnapshot>('/builtin-browser/history', {
        pageId: pid,
        dir,
      });
      set({ snapshot: r, address: r.url });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  reload: async () => {
    const pid = get().snapshot?.pageId;
    if (!pid) return;
    set({ loading: true, error: '', selected: null });
    try {
      const r = await apiClient.post<BrowserSnapshot>('/builtin-browser/reload', { pageId: pid });
      set({ snapshot: r, address: r.url });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  scrollAt: async (x, y, dy) => {
    const pid = get().snapshot?.pageId;
    if (!pid || get().loading) return;
    set({ loading: true });
    try {
      const r = await apiClient.post<BrowserSnapshot & { ok: boolean }>('/builtin-browser/action', {
        pageId: pid,
        action: 'scroll',
        x,
        y,
        dy,
      });
      applyResult(set, r);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  closeAll: async () => {
    try {
      await apiClient.post('/builtin-browser/close', { all: true });
      set({ snapshot: null, address: '', selected: null, consoleOpen: false });
    } catch (e) {
      toast.error(wt('关闭失败'), e instanceof Error ? e.message : undefined);
    }
  },
}));

useSessionStore.subscribe((state, previous) => {
  if (state.currentSessionId !== previous.currentSessionId) {
    useBrowserPanel.setState({
      snapshot: null,
      address: '',
      selected: null,
      mode: 'browse',
      error: '',
      loading: false,
      manual: false,
      agentBusy: false,
      tabs: [],
      downloads: [],
    });
  }
});
