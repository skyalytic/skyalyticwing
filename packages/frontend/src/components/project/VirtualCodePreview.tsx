// 虚拟化代码预览（IDE 同款策略）：无论文件多少行，DOM 里只渲染视口内可见的
// 几十行（± 过采样），滚动时回收复用——大文件秒开、滚动如丝、滚轮自然生效。
// 每行做轻量 token 着色（JSON：键/字符串/数字/布尔；通用：字符串/注释/关键字/数字），
// 短行逐行着色成本极低；跨行结构（块注释/多行字符串）不追求完美，以流畅优先。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

const LINE_HEIGHT = 20;
const OVERSCAN = 14;

/** JSON 行着色：捕获组 → 键 / 字符串 / 数字 / 布尔与 null */
const JSON_RE =
  /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
const JSON_COLORS = [
  'var(--syntax-key)',
  'var(--syntax-key)',
  'var(--syntax-string)',
  'var(--syntax-number)',
  'var(--syntax-key)',
];

/** 通用代码行着色：字符串 / 注释 / 关键字 / 数字 */
const GENERIC_RE =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|#[^\n]*)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|from|export|default|class|new|delete|await|async|try|catch|finally|throw|def|lambda|self|this|super|fn|pub|use|mut|struct|enum|impl|trait|package|type|interface|extends|implements|static|void|public|private|protected|null|nil|None|True|False|true|false)\b|(\b\d+(?:\.\d+)?\b)/g;
const GENERIC_COLORS = [
  'var(--syntax-string)',
  'var(--syntax-comment)',
  'var(--syntax-key)',
  'var(--syntax-number)',
];

/** 单行 token 着色（正则捕获组序号映射颜色） */
function renderLine(line: string, re: RegExp, colors: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    let color = '';
    for (let g = 1; g < m.length; g++) {
      if (m[g] !== undefined) {
        color = colors[g - 1] ?? '';
        break;
      }
    }
    out.push(
      <span key={k++} style={color ? { color } : undefined}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function VirtualCodePreview({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const isJson = useMemo(() => {
    const s = content.trimStart();
    return s.startsWith('{') || s.startsWith('[');
  }, [content]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  // 挂载/尺寸变化时校正可视高度
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  };

  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((scrollTop + viewH) / LINE_HEIGHT) + OVERSCAN);

  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? '';
    const nodes = line
      ? renderLine(line, isJson ? JSON_RE : GENERIC_RE, isJson ? JSON_COLORS : GENERIC_COLORS)
      : '\u00a0';
    rows.push(
      <div key={i} style={{ height: LINE_HEIGHT, whiteSpace: 'pre', display: 'flex' }}>
        <span className="sky-virtual-line" aria-hidden="true">
          {i + 1}
        </span>
        <span>{nodes}</span>
      </div>,
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="sky-virtual-code flex-1 min-h-0 overflow-auto font-mono text-xs"
      style={{ lineHeight: `${LINE_HEIGHT}px` }}
    >
      {/* spacer 撑出真实滚动高度；窗口块绝对定位到当前可视行段 */}
      <div style={{ height: lines.length * LINE_HEIGHT, position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            top: start * LINE_HEIGHT,
            left: 0,
            right: 0,
            padding: '0 12px',
          }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}
