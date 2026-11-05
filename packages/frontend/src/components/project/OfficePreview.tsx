import { registerFileCloseGuard, registerPendingDraftCheck } from './file-tab-lifecycle';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api-client';
import './OfficePreview.css';
import { ZoomControls } from './PreviewControls';

interface Field {
  id: string;
  value: string;
  row?: number;
  column?: number;
  formula?: boolean;
  readOnly?: boolean;
}
interface Snapshot {
  format: string;
  revision: string;
  sections: Array<{ name: string; fields: Field[] }>;
}
const drafts = new Map<string, { revision: string; changes: Record<string, string> }>();
registerPendingDraftCheck(() => drafts.size > 0);

/** Edits OOXML text/cells in place; does not rebuild an imported Office document. */
export function OfficePreview({ filePath }: { filePath: string }) {
  useWorkbenchLanguage();
  const [doc, setDoc] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [state, setState] = useState(wt('加载中'));
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [values, setValues] = useState<Record<string, string>>({});
  const revision = useRef(''),
    pending = useRef<Record<string, string>>({});
  const busy = useRef(false),
    failed = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  const flush = async () => {
    clearTimeout(timer.current);
    if (busy.current || failed.current || !revision.current || !Object.keys(pending.current).length)
      return;
    busy.current = true;
    if (mounted.current) setState(wt('保存中'));
    const batch = { ...pending.current };
    try {
      const result = await apiClient.post<{ revision: string }>('/files/office', {
        path: filePath,
        revision: revision.current,
        changes: Object.entries(batch).map(([id, value]) => ({ id, value })),
      });
      revision.current = result.revision;
      for (const [id, value] of Object.entries(batch))
        if (pending.current[id] === value) delete pending.current[id];
      if (Object.keys(pending.current).length)
        drafts.set(filePath, { revision: revision.current, changes: { ...pending.current } });
      else drafts.delete(filePath);
      if (mounted.current) {
        setState(wt('已保存'));
        setError('');
      }
    } catch (e) {
      failed.current = true;
      drafts.set(filePath, { revision: revision.current, changes: { ...pending.current } });
      if (mounted.current) {
        setState(wt('保存失败，修改已保留'));
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      busy.current = false;
      if (!failed.current && Object.keys(pending.current).length) void flush();
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => registerFileCloseGuard(filePath, async () => {
    for (let n = 0; busy.current && n < 100; n++) await new Promise(r => setTimeout(r, 50));
    await flushRef.current();
    if (busy.current || Object.keys(pending.current).length) throw Error('Office 修改尚未保存');
  }), [filePath]);
  useEffect(() => {
    mounted.current = true;
    void apiClient
      .get<Snapshot>('/files/office?path=' + encodeURIComponent(filePath))
      .then((data) => {
        if (!mounted.current) return;
        setDoc(data);
        revision.current = data.revision;
        const original = Object.fromEntries(
          data.sections.flatMap((section) =>
            section.fields.map((field) => [field.id, field.value]),
          ),
        );
        const saved = drafts.get(filePath);
        if (saved) {
          pending.current = { ...saved.changes };
          revision.current = saved.revision;
          setValues({ ...original, ...saved.changes });
          failed.current = true;
          setError(
            saved.revision === data.revision
              ? wt('上次修改尚未保存，可重试保存。')
              : wt('文件已变化；已保留上次草稿，请下载草稿后合并。'),
          );
          setState(wt('草稿待处理'));
        } else {
          setValues(original);
          setState(wt('已加载'));
        }
      })
      .catch((e) => {
        if (mounted.current) {
          setError(e.message);
          setState(wt('打开失败'));
        }
      });
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      void flushRef.current();
    };
  }, [filePath]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length || busy.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, []);
  const change = (id: string, value: string) => {
    setValues((previous) => ({ ...previous, [id]: value }));
    pending.current[id] = value;
    drafts.set(filePath, { revision: revision.current, changes: { ...pending.current } });
    setState(failed.current ? wt('草稿待处理') : wt('待保存'));
    clearTimeout(timer.current);
    if (!failed.current) timer.current = setTimeout(() => void flushRef.current(), 600);
  };
  const downloadDraft = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { path: filePath, revision: revision.current, changes: pending.current },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'office-unsaved-draft.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const section = doc?.sections[page];
  const rows = [...new Set(section?.fields.map((f) => f.row || 1))].sort((a, b) => a - b);
  const columns = [...new Set(section?.fields.map((f) => f.column || 1))].sort((a, b) => a - b);
  const cells = new Map(section?.fields.map((f) => [`${f.row || 1}:${f.column || 1}`, f]));
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="office-preview">
      <div className="flex items-center gap-3 p-3 border-b border-white/10 text-xs flex-wrap">
        <strong>
          {doc?.format.toUpperCase()} {wt('内容预览与编辑')}
        </strong>
        <span role="status">{state}</span>
        <button
          onClick={() => {
            failed.current = false;
            void flushRef.current();
          }}
        >
          {wt('立即保存')}
        </button>
        <a href={'/api/files/serve?path=' + encodeURIComponent(filePath)} download>
          {wt('下载文件')}
        </a>
      </div>
      <div className="preview-toolbar"><ZoomControls scale={zoom} onChange={setZoom} onFit={() => setZoom(1)} /></div>
      <p className="text-xs opacity-65 px-3 py-2">
        {wt('修改后自动保存到原文件。此处预览文字和单元格；图片、图表及复杂排版保留在原文件中。')}
        {doc?.format === 'xlsx' ? wt('公式可编辑，计算结果由 Excel / WPS 打开后重算。') : ''}
      </p>
      {error && (
        <div role="alert" className="p-3 text-sm text-red-400">
          {error}
          <button className="ml-3 underline" onClick={downloadDraft}>
            {wt('下载未保存修改')}
          </button>
        </div>
      )}
      {doc && (
        <div className="flex gap-2 px-3 pb-2 overflow-x-auto shrink-0">
          {doc.sections.map((item, i) => (
            <button
              key={i}
              aria-pressed={page === i}
              onClick={() => setPage(i)}
              className={
                'px-3 py-1 rounded text-xs ' +
                (page === i ? 'bg-blue-600 text-white' : 'bg-gray-500/15')
              }
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto p-4 bg-black/5">
        <div style={{ zoom }}>
        {section?.fields.some((f) => f.readOnly) && (
          <p className="text-sm mb-3">
            {wt('此工作表包含共享或数组公式，当前只读，请在 Excel / WPS 中编辑。')}
          </p>
        )}
        {section &&
          (doc?.format === 'xlsx' ? (
            rows.length * columns.length <= 50000 ? (
              <table className="border-collapse bg-white text-gray-900 text-sm">
                <thead>
                  <tr>
                    <th className="border bg-gray-100 p-2">{wt('行')}</th>
                    {columns.map((c) => (
                      <th className="border bg-gray-100 p-2 min-w-32" key={c}>
                        {columnName(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row}>
                      <th className="border bg-gray-100 p-2 font-normal">{row}</th>
                      {columns.map((column) => {
                        const field = cells.get(`${row}:${column}`);
                        return (
                          <td key={column} className="border">
                            {field && (
                              <input
                                readOnly={field.readOnly}
                                className="w-full p-2 bg-transparent outline-blue-500"
                                aria-label={`${section.name} ${columnName(column)}${row}`}
                                value={values[field.id] ?? ''}
                                onChange={(e) => change(field.id, e.target.value)}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>{wt('工作表范围过大，请下载后在 Excel / WPS 中编辑。')}</p>
            )
          ) : (
            <article
              className={
                'bg-white text-gray-900 shadow p-6 mx-auto max-w-3xl ' +
                (doc?.format === 'pptx' ? 'min-h-80' : 'min-h-[600px]')
              }
            >
              <h3 className="text-xs text-gray-400 mb-4">{section.name}</h3>
              {section.fields.map((field, i) => (
                <textarea
                  key={field.id}
                  aria-label={wt('{{v0}} 文本 {{v1}}', { v0: section.name, v1: i + 1 })}
                  className="block w-full resize-y bg-transparent border border-transparent hover:border-blue-200 focus:border-blue-500 rounded p-1 my-1 outline-none"
                  rows={Math.max(
                    1,
                    Math.min(
                      12,
                      (values[field.id] || '').split('\n').length +
                        Math.floor((values[field.id] || '').length / 65),
                    ),
                  )}
                  value={values[field.id] ?? ''}
                  onChange={(e) => change(field.id, e.target.value)}
                />
              ))}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
function columnName(column: number) {
  let name = '';
  while (column > 0) {
    column--;
    name = String.fromCharCode(65 + (column % 26)) + name;
    column = Math.floor(column / 26);
  }
  return name;
}
