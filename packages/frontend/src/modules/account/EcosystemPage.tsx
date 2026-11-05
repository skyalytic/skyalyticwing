import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { authenticatedFetch } from '@/services/authenticated-fetch';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import './ecosystem.css';
import { EcosystemGovernance } from './EcosystemGovernance';
type Item = {
  id: string;
  name: string;
  kind: string;
  description: string;
  version: string;
  publisher: string;
  source: string;
  license: string;
  permissions: string[];
  install?: { envKeys: string[] };
  oauth?: { scopes: string[] };
  priceCents?: number;
  revision?: number;
  updateAvailable?: boolean;
  installedVersion?: string;
};
type Field = {
  key: string;
  label: string;
  help: string;
  secret: boolean;
  type: string;
  required: boolean;
  configured: boolean;
  value: string;
};
type Connection = { id: string; status: string; enabled: boolean };
// Keep older catalog releases compatible with the terminology used in Wing.
const resourceText = (value: string) =>
  wt(value)
    .replace(/专家团/g, '智能体团')
    .replace(/专家/g, '智能体')
    .replace(/\bExperts\b/g, 'Agents')
    .replace(/\bExpert\b/g, 'Agent')
    .replace(/\bexperts\b/g, 'agents')
    .replace(/\bexpert\b/g, 'agent');
async function request(path: string, method = 'GET', body?: unknown) {
  const r = await authenticatedFetch('/api/ecosystem' + path, {
    method,
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const raw = await r.json();
  const d = raw.data ?? raw;
  if (!r.ok || raw.success === false)
    throw new Error(
      typeof raw.message === 'string'
        ? raw.message
        : typeof raw.error === 'string'
          ? raw.error
          : wt('官网服务暂不可用'),
    );
  return d;
}
export function EcosystemPage({ resourceKind }: { resourceKind?: 'skill' | 'mcp' | 'agent' }) {
  useWorkbenchLanguage();
  const [items, setItems] = useState<Item[]>([]),
    [installed, setInstalled] = useState<Item[]>([]),
    [q, setQ] = useState(''),
    [kind, setKind] = useState(''),
    [tab, setTab] = useState('catalog');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(''),
    [loading, setLoading] = useState(false),
    [preview, setPreview] = useState(false);
  const [oauthLink, setOauthLink] = useState(''),
    [oauthId, setOauthId] = useState('');
  const [configure, setConfigure] = useState<Item | null>(null),
    [credentials, setCredentials] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<Field[]>([]),
    [connections, setConnections] = useState<Connection[]>([]);
  const generation = useRef(0);
  const scopedKind = resourceKind === 'agent' ? '' : resourceKind || kind;
  const matchesScope = (item: Item) =>
    resourceKind === 'agent'
      ? ['expert', 'team', 'agent'].includes(item.kind)
      : !scopedKind || item.kind === scopedKind || (scopedKind==='mcp'&&item.kind==='plugin');
  const resourceTitle =
    resourceKind === 'skill'
      ? wt('技能资源')
      : resourceKind === 'mcp'
        ? wt('MCP 插件资源')
        : wt('智能体资源');
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const local = await request('/installed');
      if (current !== generation.current) return;
      setInstalled(local.items || []);
      const status = await request('/connections');
      if (current !== generation.current) return;
      setConnections(status.items || []);
      const data = await request('/catalog?q=' + encodeURIComponent(q) + '&kind=' + scopedKind);
      if (current !== generation.current) return;
      setItems(data.items || []);
      setInstalled(data.installed || []);
      setPreview(Boolean(data.preview));
    } catch (e) {
      if (current === generation.current) {
        setError(e instanceof Error ? wt(e.message) : wt('加载失败'));
        setItems([]);
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [q, scopedKind]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!oauthId) return;
    const timer = setInterval(() => {
      void request('/' + encodeURIComponent(oauthId) + '/oauth/status')
        .then((status) => {
          if (!['pending', 'exchanging'].includes(status.status)) {
            setNotice(status.error || wt('授权状态：') + status.status);
            setOauthId('');
            setOauthLink('');
            void refresh();
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [oauthId, refresh]);
  async function lifecycle(item: Item, operation: string) {
    if (
      !(await showConfirm(
        operation === 'upgrade'
          ? wt('升级会保留旧版回滚副本，连接器升级后需要重新授权。继续？')
          : operation === 'rollback'
            ? wt('恢复上一个版本？当前技能会保留副本，连接器需要重新授权。')
            : operation === 'revoke'
              ? wt('撤销连接器授权并清除本地凭据？')
              : wt('删除回滚副本后无法再恢复旧版，继续？'),
      ))
    )
      return;
    setBusy(item.id);
    try {
      const r = await request(
        '/' + encodeURIComponent(item.id) + '/' + operation,
        operation === 'backup' ? 'DELETE' : 'POST',
      );
      setNotice(r.note ? wt(r.note) : wt('操作完成'));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? wt(e.message) : wt('操作失败'));
    } finally {
      setBusy('');
    }
  }
  async function authorize(item: Item) {
    setBusy(item.id);
    setError('');
    try {
      if (!item.oauth) {
        const setup = await request('/' + encodeURIComponent(item.id) + '/configuration');
        setFields(setup.fields);
        setCredentials(Object.fromEntries(setup.fields.map((f: Field) => [f.key, f.value])));
        setConfigure({ ...item, source: setup.source, description: setup.description });
        return;
      }
      const result = await request('/' + encodeURIComponent(item.id) + '/oauth/start', 'POST');
      setOauthLink(result.url);
      setOauthId(item.id);
      setNotice(wt('请在浏览器完成授权；申请权限：') + item.oauth.scopes.join('、'));
    } catch (e) {
      setError(e instanceof Error ? wt(e.message) : wt('授权失败'));
    } finally {
      setBusy('');
    }
  }
  async function connect() {
    if (!configure) return;
    setBusy(configure.id);
    setError('');
    try {
      const result = await request('/' + encodeURIComponent(configure.id) + '/configure', 'POST', {
        env: credentials,
      });
      setNotice(wt(result.note) + wt(' · {{v0}} 个工具', { v0: result.toolCount }));
      setCredentials({});
      setConfigure(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? wt(e.message) : wt('连接失败'));
    } finally {
      setBusy('');
    }
  }
  async function action(item: Item, remove: boolean) {
    if (
      !(await showConfirm(
        remove
          ? wt(
              '将删除该资源的本地安装内容（包括对此技能的编辑），请先备份需要保留的内容。第三方业务数据不受影响。',
            )
          : wt('{{v0}}\n来源：{{v1}}\n权限：{{v2}}\n{{v3}}', {
              v0: resourceText(item.name),
              v1: item.source,
              v2: item.permissions?.map((p) => wt(p)).join('; ') || wt('见资源说明'),
              v3:
                item.kind === 'mcp'
                  ? wt('仅安装连接配置，默认停用；首次启动需要从 npm 下载依赖。')
                  : wt('技能仅提供流程说明，执行仍使用当前工作台权限。'),
            }),
        {
          title: remove ? wt('卸载资源') : wt('安装资源'),
          confirmText: remove ? wt('卸载') : wt('安装'),
          danger: remove,
        },
      ))
    )
      return;
    setBusy(item.id);
    setError('');
    try {
      const r = await request(
        '/' + encodeURIComponent(item.id) + (remove ? '' : '/install'),
        remove ? 'DELETE' : 'POST',
      );
      setNotice(r.note ? wt(r.note) : wt('已卸载'));
      await refresh();
      if (!remove && item.kind === 'mcp' && !item.oauth) await authorize(item);
    } catch (e) {
      setError(e instanceof Error ? wt(e.message) : wt('操作失败'));
    } finally {
      setBusy('');
    }
  }
  const list = (tab === 'installed' ? installed : items).filter(
    (i) =>
      matchesScope(i) &&
      (tab !== 'installed' || `${i.name} ${i.description}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div className="sky-dashboard sky-ecosystem">
      <header className="sky-page-heading">
        <div>
          <h1>{resourceKind ? resourceTitle : wt('把你的工具，接进工作流')}</h1>
          <p>
            {resourceKind
              ? wt('浏览、安装与管理当前模块的资源。')
              : wt('从官网发现技能与连接器。安装在本地，授权由你掌握。')}
          </p>
        </div>
        <a href="https://skyalytic.com/ecosystem" target="_blank" rel="noreferrer">
          {wt('浏览官网 ↗')}
        </a>
      </header>
      <div className="eco-toolbar">
        <div>
          <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}>
            {wt('发现资源')}
          </button>
          <button
            className={tab === 'installed' ? 'active' : ''}
            onClick={() => setTab('installed')}
          >
            {wt('已安装 ·') + ' '}
            {installed.filter(matchesScope).length}
          </button>
        </div>
      </div>
      {preview && <p className="sky-notice">{wt('内部验收目录 · 2.0.0 尚未发布')}</p>}
      {error && !configure && (
        <p role="alert" className="eco-error">
          {error}
          {wt('。已安装资源仍可在本地查看和卸载。')}
        </p>
      )}
      {notice && (
        <p role="status" className="sky-notice">
          {notice}
        </p>
      )}
      {loading ? (
        <p>{wt('正在获取官网目录…')}</p>
      ) : (
        <div className="sky-card-grid">
          {list.map((item) => {
            const local = installed.find((x) => x.id === item.id);
            const isInstalled = Boolean(local);
            const connection = connections.find((x) => x.id === item.id);
            return (
              <article className="sky-panel eco-card" key={item.id}>
                <div className="eco-meta">
                  <span>
                    {(
                      {
                        mcp: wt('MCP 连接器'),
                        plugin: wt('Wing 本地插件'),
                        skill: wt('工作技能'),
                        expert: wt('智能体'),
                        team: wt('智能体团'),
                      } as Record<string, string>
                    )[item.kind] || item.kind}
                  </span>
                  <span>{item.version}</span>
                </div>
                <h2>{resourceText(item.name)}</h2>
                {isInstalled && item.kind === 'mcp' && (
                  <p className="eco-connection">
                    {connection?.status === 'running'
                      ? wt('插件已连接 · 账号权限待任务验证')
                      : connection?.status === 'error'
                        ? wt('连接异常 · 请重新配置')
                        : connection?.enabled
                          ? wt('已配置 · 当前未运行')
                          : wt('未连接 · 待配置或重试')}
                  </p>
                )}
                <p>{resourceText(item.description)}</p>
                <p className="eco-origin">
                  {wt(item.publisher)} · {item.license}
                </p>
                <details>
                  <summary>{wt('来源与权限')}</summary>
                  <a
                    href={item.source.startsWith('https://') ? item.source : undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {wt('第三方原始来源 ↗')}
                  </a>
                  <ul>
                    {item.permissions?.map((p) => (
                      <li key={p}>{wt(p)}</li>
                    ))}
                  </ul>
                </details>
                <div className="eco-actions">
                  <button disabled={!!busy} onClick={() => void action(item, isInstalled)}>
                    {busy === item.id
                      ? wt('处理中…')
                      : isInstalled
                        ? wt('卸载')
                        : wt('安装')}
                  </button>
                  {isInstalled && item.kind === 'mcp' && (
                    <button disabled={!!busy} onClick={() => void authorize(local || item)}>
                      {wt('授权连接')}
                    </button>
                  )}
                  {isInstalled && item.kind === 'mcp' && (
                    <button disabled={!!busy} onClick={() => void lifecycle(item, 'revoke')}>
                      {wt('撤销授权')}
                    </button>
                  )}
                  {isInstalled && ['expert', 'team'].includes(item.kind) && (
                    <Link to="/agents">{wt('编辑智能体')}</Link>
                  )}
                  {isInstalled && ['skill', 'mcp','plugin'].includes(item.kind) && (
                    <>
                      <button disabled={!!busy} onClick={() => void lifecycle(item, 'upgrade')}>
                        {wt('更新版本')}
                      </button>
                      <button disabled={!!busy} onClick={() => void lifecycle(item, 'rollback')}>
                        {wt('回滚')}
                      </button>
                      <button disabled={!!busy} onClick={() => void lifecycle(item, 'backup')}>
                        {wt('清除回滚副本')}
                      </button>
                    </>
                  )}
                  {isInstalled && item.kind === 'skill' && (
                    <Link to="/skills">{wt('查看本地技能')}</Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {!loading && !list.length && (
        <section className="sky-panel">
          <h2>{tab === 'installed' ? wt('还没有安装官网资源') : wt('暂无可用资源')}</h2>
          <p>
            {tab === 'installed'
              ? wt('在官网目录选择需要的技能或连接器。')
              : wt('资源需经审核、签名与上架后才会显示；当前不会回退到其他市场。')}
          </p>
        </section>
      )}
      {!resourceKind && <EcosystemGovernance />}
      <p className="eco-footnote">
        {wt('官网只提供目录与安装制品。本地会话、企业协作库和第三方账号凭据不会因此同步到官网。')}
      </p>
      {oauthLink && (
        <p>
          <a href={oauthLink} target="_blank" rel="noreferrer">
            {wt('打开第三方授权页面 ↗')}
          </a>
          <span>{wt('（在运行 Wing 的电脑上完成）')}</span>
        </p>
      )}
      {configure && (
        <div className="eco-dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={wt('授权连接器')}
            className="sky-panel eco-dialog"
          >
            <h2>
              {wt('连接')}
              {wt(configure.name)}
            </h2>
            <p>{configure.description}</p>
            <p>
              {wt('凭据加密保存到当前工作台。已保存的密钥留空表示保留；撤销授权会清除本地凭据。')}
            </p>
            <a
              href={configure.source.startsWith('https://') ? configure.source : undefined}
              target="_blank"
              rel="noreferrer"
            >
              {wt('查看来源与配置说明 ↗')}
            </a>
            <p>
              {wt(
                '连接检测只验证插件启动和工具列表，实际账号权限以任务执行结果为准。首次连接可能需要几分钟下载依赖。',
              )}
            </p>
            {error && (
              <p role="alert" className="eco-error">
                {error}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              {fields.length === 0 && (
                <p>{wt('此连接器无需填写 API 密钥，点击下方按钮启动并检测。')}</p>
              )}
              {fields.map((field) => (
                <label key={field.key} className="eco-field">
                  {wt(field.label)}
                  <small>
                    {field.key} ·{' '}
                    {field.configured ? wt('已保存') : field.required ? wt('必填') : wt('可选')}
                  </small>
                  {field.type === 'boolean' ? (
                    <select
                      aria-label={wt(field.label)}
                      value={credentials[field.key] || 'true'}
                      disabled={!!busy}
                      onChange={(e) =>
                        setCredentials({ ...credentials, [field.key]: e.target.value })
                      }
                    >
                      <option value="true">{wt('true · 启用隐式 TLS')}</option>
                      <option value="false">{wt('false · 按服务商配置 STARTTLS')}</option>
                    </select>
                  ) : (
                    <input
                      autoFocus={fields[0] === field}
                      aria-label={wt(field.label)}
                      type={field.secret ? 'password' : field.type === 'port' ? 'number' : 'text'}
                      min={field.type === 'port' ? 1 : undefined}
                      max={field.type === 'port' ? 65535 : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      required={field.required && !field.configured}
                      disabled={!!busy}
                      placeholder={
                        field.secret && field.configured ? wt('已保存，留空保留') : undefined
                      }
                      value={credentials[field.key] || ''}
                      onChange={(e) =>
                        setCredentials({ ...credentials, [field.key]: e.target.value })
                      }
                    />
                  )}
                  <small>{wt(field.help)}</small>
                </label>
              ))}
              <div className="eco-actions">
                <button disabled={!!busy}>{busy ? wt('正在连接…') : wt('保存并连接')}</button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setConfigure(null);
                    setCredentials({});
                    setError('');
                  }}
                >
                  {wt('取消')}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
