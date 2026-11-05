import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from '@/stores/project-panel-store';
import '../project/OfficePreview.css';
interface Table {
  name: string;
  kind: string;
  columns: Array<{ name: string; type: string; pk: number }>;
}
interface Result {
  columns: string[];
  rows: unknown[][];
  truncated?: boolean;
  affected?: number;
  backup?: string;
}
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export function DatabaseView({ filePath }: { filePath?: string }) {
  useWorkbenchLanguage();
  const root = useProjectPanel((s) => s.projectDir);
  const [path, setPath] = useState(
    filePath || root + (root.includes('\\') ? '\\' : '/') + 'workspace.sqlite',
  );
  const [tables, setTables] = useState<Table[]>([]),
    [selected, setSelected] = useState<Table>();
  const [sql, setSql] = useState('SELECT name, type FROM sqlite_master ORDER BY name');
  const [result, setResult] = useState<Result>(),
    [status, setStatus] = useState(''),
    [error, setError] = useState('');
  const [write, setWrite] = useState(false),
    [busy, setBusy] = useState(false);
  const schema = async () => {
    try {
      const data = await apiClient.get<{ tables: Table[] }>(
        '/database/schema?path=' + encodeURIComponent(path),
      );
      setTables(data.tables);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (filePath) void schema();
  }, [filePath]);
  const run = async (query = sql, mutate = false) => {
    setBusy(true);
    setError('');
    try {
      const data = await apiClient.post<Result>('/database/' + (mutate ? 'execute' : 'query'), {
        path,
        sql: query,
      });
      setResult(data);
      setStatus(mutate ? wt('已提交，修改前已自动备份') : wt('查询完成'));
      if (mutate) await schema();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const select = (table: Table) => {
    setSelected(table);
    const query = 'SELECT * FROM ' + quote(table.name) + ' LIMIT 100';
    setSql(query);
    void run(query);
  };
  const update = async (row: unknown[], column: string, text: string) => {
    if (!selected || !result) return;
    const primary = selected.columns.filter((c) => c.pk);
    const col = result.columns.indexOf(column),
      before = row[col];
    if (String(before ?? '') === text) return;
    let value: unknown = text;
    if (text === 'null') value = null;
    else if (typeof before === 'number' && text.trim() && Number.isFinite(Number(text)))
      value = Number(text);
    const where = [...primary.map((c) => quote(c.name) + ' IS ?'), quote(column) + ' IS ?'].join(
      ' AND ',
    );
    const params = [value, ...primary.map((c) => row[result.columns.indexOf(c.name)]), before];
    setBusy(true);
    try {
      const data = await apiClient.post<Result>('/database/execute', {
        path,
        sql: 'UPDATE ' + quote(selected.name) + ' SET ' + quote(column) + ' = ? WHERE ' + where,
        params,
      });
      if (data.affected !== 1) throw new Error(wt('该行已变化，请刷新后重试'));
      await run();
      setStatus(wt('单元格已保存，修改前已自动备份'));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const editable =
    write &&
    selected?.kind === 'table' &&
    selected.columns.some((c) => c.pk) &&
    selected.columns.filter((c) => c.pk).every((c) => result?.columns.includes(c.name));
  return (
    <section className="wing-database" data-testid="database-workspace">
      <header>
        <strong>{wt('本地数据库 · SQLite')}</strong>
        <span role="status">{status}</span>
      </header>
      {!filePath && (
        <div className="wing-db-open">
          <input
            aria-label={wt('数据库路径')}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setTables([]);
              setSelected(undefined);
              setResult(undefined);
            }}
          />
          <button disabled={busy} onClick={() => void schema()}>
            {wt('打开数据库')}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void apiClient
                .post('/database/create', { path })
                .then(() => {
                  setStatus(wt('数据库已创建'));
                  void schema();
                })
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {wt('新建数据库')}
          </button>
        </div>
      )}
      <div className="wing-db-tables">
        {tables.map((table) => (
          <button key={table.name} onClick={() => select(table)}>
            {table.name}
          </button>
        ))}
      </div>
      <label className="wing-db-write">
        <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
        {wt('允许写入和编辑数据（自动备份）')}
      </label>
      <textarea
        aria-label={wt('SQL 查询')}
        value={sql}
        onChange={(e) => {
          setSql(e.target.value);
          setSelected(undefined);
        }}
        spellCheck={false}
      />
      <div className="wing-db-actions">
        <button disabled={busy} onClick={() => void run()}>
          {wt('执行只读查询')}
        </button>
        {write && (
          <button disabled={busy} onClick={() => void run(sql, true)}>
            {wt('执行写入 SQL')}
          </button>
        )}
        <button disabled={busy} onClick={() => void schema()}>
          {wt('刷新表结构')}
        </button>
      </div>
      {error && <div role="alert">{error}</div>}
      <div className="wing-db-results">
        {result && (
          <>
            <table>
              <thead>
                <tr>
                  {result.columns.map((column, i) => (
                    <th key={i}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, r) => (
                  <tr key={JSON.stringify(row) + r}>
                    {row.map((cell, c) => (
                      <td key={c}>
                        {(editable && typeof cell !== 'object') || (editable && cell === null) ? (
                          <input
                            aria-label={wt('行 {{v0}} {{v1}}', {
                              v0: r + 1,
                              v1: result.columns[c],
                            })}
                            disabled={busy}
                            defaultValue={String(cell ?? '')}
                            onBlur={(e) => void update(row, result.columns[c]!, e.target.value)}
                          />
                        ) : (
                          <span>
                            {typeof cell === 'object' && cell !== null
                              ? JSON.stringify(cell)
                              : String(cell ?? 'NULL')}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              {result.rows.length} {wt('行')}
              {result.truncated ? wt('（结果截断为 1000 行）') : ''}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
