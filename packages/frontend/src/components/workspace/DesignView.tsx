import { registerFileCloseGuard, registerPendingDraftCheck } from '../project/file-tab-lifecycle';
import { shortcutText } from '@/utils/shortcuts';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 工作区"画布"视图（对标 Trae Design 模式）：AI 生成的 HTML 设计稿渲染在
// 无限画布上 —— Space+拖拽平移、Ctrl+滚轮缩放、Ctrl+点击选中画布内元素；
// 选中元素可"添加到对话"（AI 修改设计稿源码 → 刷新画布看到效果）。
// 设计稿 = 工程目录下的 HTML 文件；注入标记脚本后经后端 design-frame 端点以
// URL 加载（http URL 文档不继承页面 CSP——srcdoc/blob:/data: 会继承，
// script-src 'self' 下内联脚本被拦会使画布功能失效），端点响应头声明
// sandbox 隔离（opaque origin，设计稿脚本不可访问应用数据），选中信息经
// postMessage 回传。
import { useEffect, useRef, useState } from 'react';
import { DESIGN_EDITOR_SCRIPT } from './design-editor-script';
import { newDesignHtml, type DesignTemplate } from './design-templates';
import { BROWSER_ANNOTATION_EVENT, BROWSER_ANNOTATION_MIME } from '@/services/browser-annotation';
import './design-editor.css';
const drafts = new Map<string, { html: string; base: string; revision?: string }>();
registerPendingDraftCheck(() => drafts.size > 0);
window.addEventListener('beforeunload', (e) => {
  if (drafts.size) {
    e.preventDefault();
    e.returnValue = '';
  }
});
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui/Button';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useDesignCanvas, type CanvasElement } from '@/stores/design-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
import { useBrowserPanel } from '@/stores/browser-store';

/** 视口预设尺寸 */
const SIZE_PRESET = {
  mobile: {
    w: 375,
    h: 812,
    get label() {
      return wt('移动');
    },
  },
  desktop: {
    w: 1280,
    h: 800,
    get label() {
      return wt('桌面');
    },
  },
} as const;

/** 设计稿 HTML 注入标记脚本（head 前置，规避 </script> 破坏） */
function injectScript(html: string): string {
  const tag = '<script data-sky-editor>' + DESIGN_EDITOR_SCRIPT + '</' + 'script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  if (/<html[^>]*>/i.test(html))
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${tag}</head>`);
  return tag + html;
}

function colorHex(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return rgb
    ? '#' +
        rgb
          .slice(1, 4)
          .map((n) => Number(n).toString(16).padStart(2, '0'))
          .join('')
    : '#ffffff';
}
export function DesignView() {
  useWorkbenchLanguage();
  const projectDir = useProjectPanel((s) => s.projectDir);
  const docs = useDesignCanvas((s) => s.docs);
  const current = useDesignCanvas((s) => s.current);
  const size = useDesignCanvas((s) => s.size);
  const zoom = useDesignCanvas((s) => s.zoom);
  const selected = useDesignCanvas((s) => s.selected);
  const version = useDesignCanvas((s) => s.version);
  const loadDocs = useDesignCanvas((s) => s.loadDocs);
  const openDoc = useDesignCanvas((s) => s.openDoc);
  const setSize = useDesignCanvas((s) => s.setSize);
  const setZoom = useDesignCanvas((s) => s.setZoom);
  const setSelected = useDesignCanvas((s) => s.setSelected);
  const refresh = useDesignCanvas((s) => s.refresh);

  const openTab = useWorkspaceTabs((s) => s.openTab);
  const navigate = useBrowserPanel((s) => s.navigate);
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);

  const [frameId, setFrameId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [creating, setCreating] = useState(false);
  const [showLayers, setShowLayers] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [layers, setLayers] = useState<Array<{ selector: string; label: string }>>([]);
  const [textValue, setTextValue] = useState('');
  const [styleValue, setStyleValue] = useState({
    color: '#222222',
    backgroundColor: '#ffffff',
    fontSize: '',
    width: '',
    height: '',
    fontFamily: 'Arial',
    fontWeight: '400',
    textAlign: 'left',
    borderRadius: '0px',
    opacity: '1',
    rotate: '0deg',
  });
  const htmlRef = useRef('');
  const baseRef = useRef('');
  const revisionRef = useRef<string>();
  const dirtyRef = useRef(false);
  const command = (command: string, value?: unknown) =>
    frameRef.current?.contentWindow?.postMessage({ type: 'sky-canvas-edit', command, value }, '*');
  const [loading, setLoading] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  panRef.current = pan;

  // 新设计稿与尺寸切换时适应可见区域，避免大画布首次打开落在视口外。
  useEffect(() => {
    if (!frameId) return;
    const element = viewportRef.current;
    if (!element) return;
    const dimensions = SIZE_PRESET[size];
    let previousFit: number | null = null;
    const adapt = () => {
      // Keep auto-fit on resize until the user explicitly changes zoom.
      if (previousFit !== null && Math.abs(useDesignCanvas.getState().zoom - previousFit) > 0.001)
        return;
      const viewport = element.getBoundingClientRect();
      if (viewport.width < 1 || viewport.height < 1) return;
      previousFit = Math.max(
        0.1,
        Math.min((viewport.width - 32) / dimensions.w, (viewport.height - 48) / dimensions.h, 1),
      );
      setZoom(previousFit);
    };
    setPan({ x: 0, y: 0 });
    adapt();
    const observer = new ResizeObserver(adapt);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frameId, size, setZoom]);

  // 工程目录变化 → 扫描设计稿列表
  useEffect(() => {
    void loadDocs();
  }, [loadDocs, projectDir, version]);

  // 加载设计稿（current/version 变化重载）→ 注入标记脚本 → 注册为后端帧 → iframe URL 加载
  useEffect(() => {
    if (!current) {
      setFrameId(null);
      return;
    }
    let active = true;
    setLoading(true);
    setFrameId(null);
    setHistory({ undo: false, redo: false });
    setLayers([]);
    setSelected(null);
    apiClient
      .get<{ content: string; revision?: string }>(
        `/files/read?path=${encodeURIComponent(current.path)}`,
      )
      .then((d) => {
        if (!active) throw new Error('stale');
        const draft = drafts.get(current.path);
        baseRef.current = draft?.base ?? d.content ?? '';
        revisionRef.current = draft?.revision ?? d.revision;
        htmlRef.current = draft?.html ?? d.content ?? '';
        dirtyRef.current = !!draft;
        setDirty(!!draft);
        return apiClient.post<{ id: string; renderToken: string }>('/files/design-frame', {
          html: injectScript(htmlRef.current),
        });
      })
      .then((r) => {
        if (active)
          setFrameId(
            `${encodeURIComponent(r.id)}?renderToken=${encodeURIComponent(r.renderToken)}`,
          );
      })
      .catch(() => {
        if (active) setFrameId(null);
        if (active) toast.error(wt('设计稿读取失败'), current.path);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [current, version]);

  // iframe 内消息：选中元素 / Ctrl+滚轮缩放转发
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as {
        type?: string;
        payload?: CanvasElement & Record<string, unknown>;
      } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'sky-canvas-select') {
        const p = data.payload;
        if (
          p &&
          typeof p.tag === 'string' &&
          p.rect &&
          [p.rect.x, p.rect.y, p.rect.w, p.rect.h].every(Number.isFinite)
        ) {
          setSelected({
            tag: p.tag,
            text: typeof p.text === 'string' ? p.text : '',
            selector: typeof p.selector === 'string' ? p.selector : '',
            outerHTML: typeof p.outerHTML === 'string' ? p.outerHTML : '',
            rect: p.rect as CanvasElement['rect'],
            styles: p.styles,
            textEditable: p.textEditable,
          });
        }
      } else if (data.type === 'sky-canvas-document') {
        const p = data.payload as unknown as {
          html: string;
          undo: boolean;
          redo: boolean;
          changed: boolean;
          layers: Array<{ selector: string; label: string }>;
        };
        if (!p || typeof p.html !== 'string') return;
        htmlRef.current = p.html;
        setHistory({ undo: !!p.undo, redo: !!p.redo });
        setLayers(Array.isArray(p.layers) ? p.layers.slice(0, 120) : []);
        if (p.changed && current) {
          dirtyRef.current = true;
          setDirty(true);
          drafts.set(current.path, {
            html: p.html,
            base: baseRef.current,
            revision: revisionRef.current,
          });
        }
      } else if (data.type === 'sky-canvas-save') {
        void saveRef.current();
      } else if (data.type === 'sky-canvas-error') {
        toast.error(wt('编辑失败'), wt(String(data.payload?.['message'] || wt('请重新选择元素'))));
      } else if (data.type === 'sky-canvas-clear') {
        setSelected(null);
      } else if (data.type === 'sky-canvas-zoom') {
        const dy = (data.payload as unknown as { deltaY: number })?.deltaY;
        if (Number.isFinite(dy) && dy !== 0)
          setZoom(useDesignCanvas.getState().zoom * (dy > 0 ? 0.9 : 1.1));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [setSelected, setZoom, current]);

  // Space 平移模式
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!viewportRef.current?.getClientRects().length) return;
      if (
        e.code === 'Space' &&
        !e.repeat &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // 父窗口区域 Ctrl+滚轮缩放（原生 non-passive 监听：React onWheel 为 passive，
  // preventDefault 无效会导致 WebView 整页缩放）。
  // 依赖 projectDir：无工程目录时欢迎页提前 return，viewport 不存在挂不上监听，
  // 选目录后重跑 effect 才能挂载
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const z = useDesignCanvas.getState().zoom;
      useDesignCanvas.getState().setZoom(z * (e.deltaY > 0 ? 0.9 : 1.1));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [projectDir]);

  // Space 拖拽平移
  const onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
  };
  const onPanEnd = () => {
    dragRef.current = null;
  };

  const fit = () => {
    setPan({ x: 0, y: 0 });
    const viewport = viewportRef.current?.getBoundingClientRect();
    const dimensions = SIZE_PRESET[size];
    if (viewport)
      setZoom(
        Math.min((viewport.width - 32) / dimensions.w, (viewport.height - 48) / dimensions.h, 1),
      );
  };

  /** 选中元素 → 组装修改请求 → 对话输入框（AI 改源码 → 用户点刷新） */
  const addToConversation = () => {
    if (!selected || !current) return;
    const context = `[用户选中的画布元素，作为上下文参考]
文件：${current.path}
选择器：${selected.selector}
HTML：${selected.outerHTML}
修改前先读取文件最新版本，保留用户的其他编辑。`;
    const bytes = new TextEncoder().encode(context);
    window.dispatchEvent(
      new CustomEvent(BROWSER_ANNOTATION_EVENT, {
        detail: {
          attachment: {
            type: 'file',
            name: '画布元素 · ' + (selected.text || selected.tag).replace(/\s+/g, ' ').slice(0, 32),
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
    setSelected(null);
    command('clear');
  };

  useEffect(() => {
    setTextValue(selected?.text ?? '');
    setStyleValue({
      color: selected?.styles?.color ?? '#222222',
      backgroundColor: selected?.styles?.backgroundColor ?? '#ffffff',
      fontSize: selected?.styles?.fontSize ?? '',
      width: selected?.styles?.width ?? '',
      height: selected?.styles?.height ?? '',
      fontFamily: selected?.styles?.fontFamily ?? 'Arial',
      fontWeight: selected?.styles?.fontWeight ?? '400',
      textAlign: selected?.styles?.textAlign ?? 'left',
      borderRadius: selected?.styles?.borderRadius ?? '0px',
      opacity: selected?.styles?.opacity ?? '1',
      rotate: selected?.styles?.rotate ?? '0deg',
    });
  }, [selected]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (drafts.size) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        if (dirtyRef.current) {
          if (active) timer = setTimeout(check, 4000);
          return;
        }
        await loadDocs();
        const state = useDesignCanvas.getState();
        if (!state.current && state.docs.length) state.openDoc(state.docs[0]);
        else if (current && !dirtyRef.current && baseRef.current) {
          const d = await apiClient.get<{ content: string }>(
            `/files/read?path=${encodeURIComponent(current.path)}`,
          );
          if (active && !dirtyRef.current && d.content !== baseRef.current) refresh();
        }
      } catch {
        /* polling keeps the last readable frame */
      }
      if (active) timer = setTimeout(check, 4000);
    };
    timer = setTimeout(check, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [current, loadDocs, refresh]);
  const save = async () => {
    if (!current || saving || !dirty) return;
    const path = current.path,
      content = htmlRef.current,
      expectedContent = baseRef.current;
    setSaving(true);
    try {
      const saved = await apiClient.post<{ revision?: string }>('/files/design-save', {
        path,
        content,
        ...(revisionRef.current ? { expectedRevision: revisionRef.current } : { expectedContent }),
      });
      revisionRef.current = saved.revision;
      if (useDesignCanvas.getState().current?.path !== path) {
        drafts.delete(path);
        return;
      }
      baseRef.current = content;
      if (htmlRef.current === content) {
        dirtyRef.current = false;
        setDirty(false);
        drafts.delete(path);
      } else drafts.set(path, { html: htmlRef.current, base: content });
      toast.success(wt('设计稿已保存'));
    } catch (e) {
      toast.error(wt('保存失败，编辑内容已保留'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!current) return;
    return registerFileCloseGuard(current.path, async () => {
      await saveRef.current();
      if (dirtyRef.current) throw Error('设计稿尚未保存，请完成保存后再更新');
    });
  }, [current?.path]);
  const createDesign = async (template: DesignTemplate) => {
    if (!projectDir || creating) return;
    setCreating(true);
    try {
      const created = await apiClient.post<{ path: string; name: string }>('/files/design-create', {
        directory: projectDir,
        name: template === 'blank' ? '未命名设计' : template === 'poster' ? '宣传海报' : '品牌卡片',
        content: newDesignHtml(template),
      });
      await loadDocs();
      setMode('edit');
      setSize('desktop');
      openDoc(created);
    } catch (e) {
      toast.error(wt('新建设计失败'), e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };
  const exportHtml = () => {
    const url = URL.createObjectURL(
      new Blob([htmlRef.current], { type: 'text/html;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = current?.name || 'design.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportPng = async () => {
    setSaving(true);
    try {
      const r = await authenticatedFetch('/api/files/design-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: htmlRef.current,
          width: SIZE_PRESET[size].w,
          height: SIZE_PRESET[size].h,
        }),
      });
      if (!r.ok) throw new Error(wt('导出失败，请检查服务器浏览器安装或稍后重试'));
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = (current?.name || 'design.html').replace(/\.html?$/i, '.png');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(wt('PNG 导出失败'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const generate = () => {
    setFocused(false);
    const file = current?.path || projectDir.replace(/[\\/]$/, '') + '/design.html';
    window.dispatchEvent(
      new CustomEvent('sky-insert-text', {
        detail:
          wt('请根据我的需求生成可编辑的设计稿，并使用文件工具保存到 ') +
          file +
          wt(
            '。使用独立 HTML、内联 CSS 和可编辑的文字及图层；图片仅作素材，不要把整稿做成一张图片。画布会自动加载。我的需求：',
          ),
      }),
    );
  };
  const preset = SIZE_PRESET[size];

  // ── 未选择工程目录 ──
  if (!projectDir) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="frame" size={44} style={{ opacity: 0.35 }} />
        <div className="text-sm font-medium">{wt('设计画布')}</div>
        <div className="text-xs opacity-60 leading-relaxed">
          {wt('选择保存设计的项目文件夹，即可新建或打开画布，')}
          <br />
          {wt('自己添加文字、形状和图片，也可以让 AI 参与设计。')}
        </div>
        <Button variant="primary" size="sm" onClick={() => setPickerOpen(true)}>
          {wt('选择项目文件夹')}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="sky-design-editor flex-1 flex flex-col min-h-0"
      style={
        focused
          ? {
              position: 'fixed',
              inset: '36px 0 0',
              zIndex: 50,
              background: 'var(--bg-primary,#10151c)',
            }
          : undefined
      }
    >
      {/* 工具条：设计稿选择 + 视口 + 缩放 + 刷新 + 浏览器打开 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-black/10 dark:border-white/10 shrink-0">
        <select
          className="h-7 max-w-[140px] text-xs rounded-md border border-black/15 dark:border-white/15 bg-transparent px-1.5 outline-none focus:border-blue-500 min-w-0"
          value={current?.path ?? ''}
          onChange={(e) => {
            const d = docs.find((x) => x.path === e.target.value);
            if (d) openDoc(d);
          }}
          style={{ background: 'var(--bg-primary,#151b25)', color: 'inherit' }}
          title={wt('选择设计稿（工程目录下的 HTML）')}
        >
          <option value="">{docs.length === 0 ? wt('无设计稿') : wt('选择设计稿')}</option>
          {docs.map((d) => (
            <option key={d.path} value={d.path}>
              {d.name}
            </option>
          ))}
        </select>
        <div className="flex items-center rounded-md bg-black/5 dark:bg-white/10 p-0.5 shrink-0">
          {(['mobile', 'desktop'] as const).map((m) => (
            <button
              key={m}
              className={`h-[22px] px-1.5 text-[11px] rounded ${size === m ? 'bg-white dark:bg-gray-700 shadow-sm font-medium' : 'opacity-60 hover:opacity-100'}`}
              onClick={() => setSize(m)}
              title={wt(SIZE_PRESET[m].label) + wt('视口')}
            >
              {wt(SIZE_PRESET[m].label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Icon
            name="x"
            size={12}
            className="cursor-pointer opacity-50 hover:opacity-100"
            style={{ transform: 'rotate(45deg)' }}
            onClick={() => setZoom(zoom - 0.2)}
            title={wt('缩小')}
          />
          <span className="text-[11px] w-10 text-center tabular-nums" title={wt('缩放比例')}>
            {Math.round(zoom * 100)}%
          </span>
          <Icon
            name="plus"
            size={12}
            className="cursor-pointer opacity-60 hover:opacity-100"
            onClick={() => setZoom(zoom + 0.2)}
            title={wt('放大')}
          />
          <span
            className="text-[11px] opacity-50 hover:opacity-100 cursor-pointer px-1"
            onClick={fit}
            title={wt('重置视图')}
          >
            {wt('适应')}
          </span>
        </div>
        <span className="flex-1" />
        <Icon
          name="refresh"
          size={13}
          className="cursor-pointer opacity-60 hover:opacity-100 shrink-0"
          onClick={() => {
            if (!dirty) refresh();
            else toast.info(wt('请先保存或导出当前修改'));
          }}
          title={wt('刷新画布（AI 改稿后查看效果）')}
        />
        <Icon
          name="globe"
          size={13}
          className="cursor-pointer opacity-60 hover:opacity-100 shrink-0"
          onClick={() => {
            if (!current) return;
            openTab('browser');
            void navigate('file:///' + current.path.replace(/\\/g, '/'));
          }}
          title={wt('在浏览器中打开')}
        />
      </div>

      <div className="sky-canvas-actions">
        <button disabled={creating} onClick={() => void createDesign('blank')}>
          {wt('新建设计')}
        </button>
        <button
          disabled={!frameId}
          aria-pressed={mode === 'edit'}
          onClick={() => {
            const next = mode === 'edit' ? 'preview' : 'edit';
            setMode(next);
            command('mode', next);
          }}
        >
          {wt(mode === 'edit' ? '预览效果' : '返回编辑')}
        </button>
        <button onClick={() => setShowLayers(!showLayers)} aria-pressed={showLayers}>
          {wt('图层')}
        </button>
        <button onClick={() => setFocused(!focused)}>
          {focused ? wt('返回工作台') : wt('专注画布')}
        </button>
        <button onClick={generate}>{wt('AI 生成 / 改稿')}</button>
        <button disabled={!history.undo || saving} onClick={() => command('undo')}>
          {wt('撤销')}
        </button>
        <button disabled={!history.redo || saving} onClick={() => command('redo')}>
          {wt('重做')}
        </button>
        <button disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? wt('保存中…') : dirty ? wt('保存修改') : wt('已保存')}
        </button>
        <button disabled={!frameId} onClick={exportHtml}>
          {wt('导出 HTML')}
        </button>
        <button
          disabled={!frameId || saving}
          title={wt('导出当前画板尺寸；仅包含内联样式和嵌入图片，不加载网络资源')}
          onClick={() => void exportPng()}
        >
          {wt('导出 PNG')}
        </button>
        <label className="sky-canvas-upload">
          {wt('导入图片')}
          <input
            aria-label={wt('导入画布图片')}
            type="file"
            disabled={!frameId || mode !== 'edit'}
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 2000000) {
                toast.error(wt('素材需小于 2 MB'));
                return;
              }
              const reader = new FileReader();
              reader.addEventListener('load', () => command('image', reader.result));
              reader.addEventListener('error', () => toast.error(wt('图片读取失败')));
              reader.readAsDataURL(f);
            }}
          />
        </label>
      </div>
      <div className="sky-design-tools" aria-label={wt('画布设计工具')}>
        {(
          [
            ['text', '文字'],
            ['rectangle', '矩形'],
            ['ellipse', '圆形'],
            ['card', '圆角矩形'],
            ['line', '线条'],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            disabled={!frameId || mode !== 'edit'}
            onClick={() => command('insert', kind)}
          >
            {wt(label)}
          </button>
        ))}
        <span className="sky-design-divider" />
        {(
          [
            ['duplicate', '复制'],
            ['delete', '删除'],
            ['front', '置顶'],
            ['back', '置底'],
          ] as const
        ).map(([action, label]) => (
          <button
            key={action}
            disabled={!selected || mode !== 'edit'}
            onClick={() => command(action)}
          >
            {wt(label)}
          </button>
        ))}
        <select
          aria-label={wt('对齐画板')}
          value=""
          disabled={!selected || mode !== 'edit'}
          onChange={(e) => command('align', e.target.value)}
        >
          <option value="">{wt('对齐')}</option>
          <option value="left">{wt('左对齐')}</option>
          <option value="center">{wt('水平居中')}</option>
          <option value="right">{wt('右对齐')}</option>
        </select>
      </div>
      {!current && (
        <div className="sky-design-welcome">
          <h3>{wt('开始你的设计')}</h3>
          <p>{wt('从空白画布开始，或选择一个可以直接修改的版式。')}</p>
          <div>
            {(
              [
                ['blank', '空白画布'],
                ['poster', '宣传海报'],
                ['card', '品牌卡片'],
              ] as const
            ).map(([kind, label]) => (
              <button disabled={creating} key={kind} onClick={() => void createDesign(kind)}>
                {wt(label)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="sky-design-body" style={!current ? { display: 'none' } : undefined}>
        {showLayers && (
          <aside className="sky-design-layers" aria-label={wt('图层列表')}>
            <strong>{wt('图层')}</strong>
            {layers.length === 0 ? (
              <p>{wt('点击上方工具添加元素')}</p>
            ) : (
              layers.map((l) => (
                <button
                  key={l.selector}
                  aria-pressed={selected?.selector === l.selector}
                  onClick={() => command('select', l.selector)}
                  title={l.label}
                >
                  {l.label}
                </button>
              ))
            )}
          </aside>
        )}
        {/* 无限画布（网格点背景）：Space 拖拽平移；Ctrl+滚轮缩放；iframe 内单击选中 */}
        <div
          ref={viewportRef}
          className="flex-1 min-h-0 relative overflow-hidden select-none"
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            backgroundColor: 'var(--bg-secondary)',
            backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)',
            backgroundSize: '16px 16px',
            cursor: spaceDown ? 'grab' : 'default',
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              position: 'absolute',
              inset: 0,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                position: 'absolute',
                width: preset.w,
                height: preset.h,
                left: '50%',
                top: '50%',
                transform: `translate(-50%, -50%) scale(${zoom})`,
              }}
            >
              <div
                className="bg-white shadow-xl border border-black/10 dark:border-white/10"
                style={{ width: preset.w, height: preset.h, background: '#fff' }}
              >
                {loading && !frameId ? (
                  <div className="w-full h-full flex items-center justify-center">
                    <SpinnerWrap label={wt('加载设计稿')} />
                  </div>
                ) : frameId ? (
                  <iframe
                    ref={frameRef}
                    key={frameId}
                    title={wt('设计画布')}
                    className="w-full h-full border-0"
                    style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
                    sandbox="allow-scripts"
                    referrerPolicy="no-referrer"
                    src={`/api/files/design-frame/${frameId}`}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-400">
                    <Icon name="frame" size={36} style={{ opacity: 0.4 }} />
                    <div className="text-xs">{wt('画布已就绪')}</div>
                    <div className="text-[11px] opacity-70">
                      {wt('从上方选择设计稿（工程目录下的 HTML 文件）')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* Space 平移覆盖层（捕获指针拖拽） */}
          {spaceDown ? (
            <div
              className="absolute inset-0 z-10"
              style={{ cursor: 'grabbing' }}
              onPointerDown={onPanStart}
              onPointerMove={onPanMove}
              onPointerUp={onPanEnd}
            />
          ) : null}
          {/* 操作提示 */}
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              maxWidth: 'calc(100% - 16px)',
              whiteSpace: 'normal',
              background: 'var(--bg-primary)',
              color: 'var(--text-secondary)',
            }}
            className="text-[10px] border rounded-full px-3 py-1 pointer-events-none"
          >
            {shortcutText(wt('单击选择 · 拖动移动 · 控制点调大小 · 双击编辑文字 · Ctrl 滚轮缩放'))}
          </div>
        </div>
      </div>
      {/* 选中元素信息条 */}
      {selected ? (
        <div className="border-t border-black/10 dark:border-white/10 p-2 shrink-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium truncate flex-1">
              {selected.text
                ? selected.text.slice(0, 40)
                : wt(selected.tag === 'img' ? '图片' : '形状')}
            </span>
            <Icon
              name="x"
              size={13}
              className="cursor-pointer opacity-60 hover:opacity-100"
              onClick={() => {
                setSelected(null);
                command('clear');
              }}
              title={wt('取消选中')}
            />
          </div>
          <div className="text-[10px] opacity-60 break-all line-clamp-1" title={selected.selector}>
            {Math.round(selected.rect.w)} × {Math.round(selected.rect.h)} px
          </div>
          <div className="sky-canvas-properties">
            <label>
              {wt('文字')}
              <input
                aria-label={wt('元素文字')}
                className="sky-canvas-text-value"
                value={textValue}
                disabled={!selected.textEditable}
                onChange={(e) => setTextValue(e.target.value)}
              />
            </label>
            <button disabled={!selected.textEditable} onClick={() => command('text', textValue)}>
              {wt('应用文字')}
            </button>
            <label>
              {wt('字体')}
              <select
                aria-label={wt('字体')}
                value={styleValue.fontFamily}
                onChange={(e) => command('style', { fontFamily: e.target.value })}
              >
                <option value={styleValue.fontFamily}>{styleValue.fontFamily}</option>
                {['Arial', 'Microsoft YaHei', 'SimSun', 'serif', 'sans-serif', 'monospace']
                  .filter((v) => v !== styleValue.fontFamily)
                  .map((v) => (
                    <option key={v}>{v}</option>
                  ))}
              </select>
            </label>
            <button
              aria-pressed={Number(styleValue.fontWeight) >= 600}
              onClick={() =>
                command('style', {
                  fontWeight: Number(styleValue.fontWeight) >= 600 ? '400' : '700',
                })
              }
            >
              {wt('加粗')}
            </button>
            {(['color', 'backgroundColor'] as const).map((key) => (
              <label key={key}>
                {wt(key === 'color' ? '文字颜色' : '填充颜色')}
                <input
                  type="color"
                  aria-label={wt(key === 'color' ? '文字颜色' : '填充颜色')}
                  value={colorHex(styleValue[key])}
                  onChange={(e) => command('style', { [key]: e.target.value })}
                />
              </label>
            ))}
            {(
              [
                ['fontSize', '字号', 'px'],
                ['width', '宽度', 'px'],
                ['height', '高度', 'px'],
                ['borderRadius', '圆角', 'px'],
                ['rotate', '旋转', 'deg'],
              ] as const
            ).map(([key, label, unit]) => (
              <label key={key}>
                {wt(label)}
                <input
                  aria-label={wt(label)}
                  type="number"
                  value={parseFloat(styleValue[key]) || 0}
                  onChange={(e) => setStyleValue({ ...styleValue, [key]: e.target.value + unit })}
                  onBlur={() => command('style', { [key]: styleValue[key] })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') command('style', { [key]: styleValue[key] });
                  }}
                />
              </label>
            ))}
            <label>
              {wt('不透明度')}
              <input
                aria-label={wt('不透明度')}
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={parseFloat(styleValue.opacity) || 0}
                onChange={(e) => command('style', { opacity: e.target.value })}
              />
            </label>
            <select
              aria-label={wt('文字对齐')}
              value={styleValue.textAlign}
              onChange={(e) => command('style', { textAlign: e.target.value })}
            >
              <option value="left">{wt('左对齐')}</option>
              <option value="center">{wt('居中')}</option>
              <option value="right">{wt('右对齐')}</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" onClick={addToConversation}>
              <Icon name="send" size={12} /> {wt('添加到对话')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
