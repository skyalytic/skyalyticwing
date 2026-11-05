// 设计画布状态：AI 生成的 HTML 设计稿渲染在无限画布上（Trae Design 模式形态）。
// 设计稿 = 工程目录下的 HTML 文件；选中元素经"添加到对话"交给 AI 修改源码后刷新画布。
import { create } from 'zustand';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from './project-panel-store';

/** 画布上选中的元素信息（iframe 内标记引擎 postMessage 回传） */
export interface CanvasElement {
  tag: string;
  text: string;
  selector: string;
  outerHTML: string;
  styles?: {color:string;backgroundColor:string;fontSize:string;width:string;height:string;fontFamily?:string;fontWeight?:string;textAlign?:string;borderRadius?:string;opacity?:string;rotate?:string};
  textEditable?: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

/** 设计稿条目（工程目录扫描的 HTML 文件） */
export interface DesignDoc {
  path: string;
  name: string;
}

/** 画布视口尺寸预设 */
export type CanvasSize = 'mobile' | 'desktop';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'coverage']);

interface RawNode {
  name: string;
  type: string;
  children?: RawNode[];
}

function collectHtml(node: RawNode, base: string, out: DesignDoc[]): void {
  const separator = base.includes('\\') ? '\\' : '/';
  const join = (child: string) => (base.endsWith('\\') || base.endsWith('/') ? base + child : base + separator + child);
  for (const c of node.children ?? []) {
    if (c.type === 'dir') {
      if (!IGNORED.has(c.name)) collectHtml(c, join(c.name), out);
    } else if (c.name.toLowerCase().endsWith('.html')) {
      out.push({ path: join(c.name), name: c.name });
    }
  }
}

interface DesignCanvasState {
  /** 已扫描的设计稿列表（工程目录 HTML） */
  docs: DesignDoc[];
  /** 当前画布设计稿 */
  current: DesignDoc | null;
  /** 画布视口预设 */
  size: CanvasSize;
  /** 缩放（0.1~4） */
  zoom: number;
  /** 选中的元素（null = 未选中） */
  selected: CanvasElement | null;
  /** 刷新令牌：+1 强制 iframe 重载（AI 改稿后手动刷新/重开） */
  version: number;
  loadDocs: () => Promise<void>;
  openDoc: (doc: DesignDoc) => void;
  setSize: (s: CanvasSize) => void;
  setZoom: (z: number) => void;
  setSelected: (el: CanvasElement | null) => void;
  refresh: () => void;
}

let docsRequest = 0;
export const useDesignCanvas = create<DesignCanvasState>((set) => ({
  docs: [],
  current: null,
  size: 'desktop',
  zoom: 1,
  selected: null,
  version: 0,

  loadDocs: async () => {
    const request = ++docsRequest;
    const dir = useProjectPanel.getState().projectDir;
    if (!dir) {
      set({ docs: [], current: null, selected: null });
      return;
    }
    try {
      const d = await apiClient.get<RawNode>(`/files/tree?path=${encodeURIComponent(dir)}&depth=4`);
      if (request !== docsRequest || dir !== useProjectPanel.getState().projectDir) return;
      const out: DesignDoc[] = [];
      collectHtml(d, dir, out);
      out.sort((a, b) => a.name.localeCompare(b.name));
      set((s) => {
        // 当前文件被删后清空 current
        const stillThere = s.current ? out.some((x) => x.path === s.current?.path) : false;
        return { docs: out, current: stillThere ? s.current : null, selected: stillThere ? s.selected : null };
      });
    } catch {
      if (request === docsRequest) set({ docs: [], current: null, selected: null });
    }
  },

  openDoc: (doc) => set({ current: doc, selected: null }),
  setSize: (s) => set({ size: s }),
  setZoom: (z) => { if (Number.isFinite(z)) set({ zoom: Math.min(4, Math.max(0.1, z)) }); },
  setSelected: (el) => set({ selected: el }),
  refresh: () => set((s) => ({ version: s.version + 1, selected: null })),
}));
