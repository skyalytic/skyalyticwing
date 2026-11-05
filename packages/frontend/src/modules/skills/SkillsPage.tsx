import { ExtensionCatalog } from '../tools/ExtensionCatalog';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 技能中心（对齐旧版 renderSkillCenterView：本地技能/技能市场双 tab）
// 本地：已安装计数 + 创建技能 + 卡片（编辑/删除）
// 市场：搜索 + 市场源徽标 + 结果列表（安装/已安装/安装中）+ 分页（10/20/50/100）
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { showConfirm } from '../../components/modals/ConfirmDialog';
import { toast } from '../../components/ui/Toast';
import { EcosystemPage } from '../account/EcosystemPage';

interface Skill {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  emoji?: string;
  installed?: boolean;
  slug?: string;
  source?: string;
  auxFiles?: string[];
}

/** 市场搜索结果条目（对齐旧版 marketplaceResults） */
interface MarketResult {
  name?: string;
  slug?: string;
  identifier?: string;
  description?: string;
  source?: string;
  _source?: string;
  _error?: boolean;
}

/** 市场源（GET /skill-marketplace/sources → {sources}） */
interface MarketSource {
  name?: string;
  type?: string;
}

type TabId = 'local' | 'market';

const PAGE_SIZES = [10, 20, 50, 100];

export function SkillsPage() {
  useWorkbenchLanguage();
  const [market, setMarket] = useState(false);
  return (
    <>
      <div className="sky-resource-tabs">
        <button aria-pressed={!market} onClick={() => setMarket(false)}>
          {wt('本地技能')}
        </button>
        <button aria-pressed={market} onClick={() => setMarket(true)}>
          {wt('技能资源')}
        </button>
      </div>
      {market ? <><ExtensionCatalog kind="skills" /><EcosystemPage resourceKind="skill" /></> : <LegacySkillsPage />}
    </>
  );
}

function LegacySkillsPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [market, setMarket] = useState<MarketResult[]>([]);
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('local');
  const [query, setQuery] = useState('');
  const [busyName, setBusyName] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // 市场分页（旧版 _marketPageSize/_marketPage）
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  // 市场源分类筛选（市场形态 chips，按结果来源过滤）
  const [sourceFilter, setSourceFilter] = useState('all');

  // 创建技能弹窗（旧版 openModal('skillCreate')）
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    emoji: 'skill',
    description: '',
    steps: '',
  });
  const [creating, setCreating] = useState(false);

  // 编辑技能弹窗（旧版 openModal('skillEdit')：GET /skill-content → PUT /skills）
  const [editSkill, setEditSkill] = useState<{ name: string; content: string } | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);

  const importZip = async (file: File) => {
    setZipBusy(true);
    try {
      const body = new FormData(); body.append('file', file);
      const response = await authenticatedFetch('/api/skills/import-zip', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok || data.success === false) throw Error(data.message || data.error || '技能导入失败');
      toast.success(wt('技能 ZIP 已导入，脚本和素材已保留'));
      await load();
    } catch (error) { toast.error((error as Error).message); }
    finally { setZipBusy(false); }
  };
  const exportZip = async (name: string) => {
    setBusyName(name);
    try {
      const response = await authenticatedFetch('/api/skills/' + encodeURIComponent(name) + '/export-zip');
      if (!response.ok) { const data = await response.json(); throw Error(data.message || data.error || '技能导出失败'); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = name + '.zip';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusyName(null); }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authenticatedFetch('/api/skills');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // 后端 GET /api/skills 返回 {success, data:{skills:[...]}}（skill.service.listSkills）
      const list: Skill[] = json?.data?.skills ?? json?.skills ?? (Array.isArray(json) ? json : []);
      setSkills(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('加载技能失败'));
    } finally {
      setLoading(false);
    }
  };

  /** 市场源列表（旧版 /skill-marketplace/sources → {sources}） */
  const loadSources = async () => {
    try {
      const res = await authenticatedFetch('/api/skill-marketplace/sources');
      if (!res.ok) return;
      const json = await res.json();
      const list: MarketSource[] = Array.isArray(json)
        ? json
        : json?.sources || json?.data?.sources || [];
      setSources(list);
    } catch {
      /* 市场源加载失败不阻塞页面 */
    }
  };

  /** 市场搜索（旧版 searchMarketplace：Enter / 搜索按钮触发） */
  const loadMarket = async () => {
    setSearching(true);
    try {
      // 后端市场搜索走 GET /skill-marketplace/search?q=（响应：{results, total, sources}）
      const res = await authenticatedFetch(
        '/api/skill-marketplace/search?q=' + encodeURIComponent(query),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list: MarketResult[] = Array.isArray(json) ? json : json.results || json.skills || [];
      setMarket(list);
      setPage(1);
      setSourceFilter('all');
    } catch {
      setMarket([]);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    load();
    loadSources();
  }, []);

  const installedNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);

  const filteredLocal = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      [s.name, s.description, s.author].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [skills, query]);

  // ── 创建技能（旧版 createSkill：POST /skills {name,emoji,description,steps}） ──
  const submitCreate = async () => {
    if (!createForm.name.trim()) {
      toast.warn(wt('请填写技能名称'));
      return;
    }
    if (!createForm.description.trim()) {
      toast.warn(wt('请填写技能描述'));
      return;
    }
    setCreating(true);
    try {
      const res = await authenticatedFetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      toast.success(
        wt('技能 "{{v0}}" 创建成功！AI 现在可以在相关场景下使用此技能', { v0: createForm.name }),
      );
      setCreateOpen(false);
      setCreateForm({ name: '', emoji: 'skill', description: '', steps: '' });
      await load();
    } catch (e) {
      toast.error(wt('创建失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setCreating(false);
    }
  };

  // ── 编辑技能（旧版 editSkill/saveSkillEdit：GET /skill-content → PUT /skills） ──
  const openEdit = async (name: string) => {
    setEditSkill({ name, content: wt('加载中...') });
    setEditLoading(true);
    setEditContent('');
    try {
      const res = await authenticatedFetch('/api/skill-content?name=' + encodeURIComponent(name));
      const json = await res.json().catch(() => ({}));
      const content: string = json?.data?.content ?? json?.content ?? '';
      setEditSkill({ name, content });
      setEditContent(content);
    } catch {
      setEditSkill({ name, content: '' });
      setEditContent('');
    } finally {
      setEditLoading(false);
    }
  };

  const submitEdit = async () => {
    if (!editSkill) return;
    setSaving(true);
    try {
      const res = await authenticatedFetch('/api/skills', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editSkill.name, content: editContent }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      toast.success(wt('技能已保存'));
      setEditSkill(null);
      await load();
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  // ── 删除技能（旧版 deleteSkill：DELETE /skills/:id） ──
  const uninstall = async (name: string) => {
    if (!(await showConfirm(wt('确定要删除技能 "{{v0}}" 吗？', { v0: name })))) return;
    setBusyName(name);
    try {
      const res = await authenticatedFetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusyName(null);
    }
  };

  // ── 安装市场技能（旧版 installMarketplaceSkill：POST /skill-marketplace/install） ──
  const install = async (r: MarketResult) => {
    const slug = r.slug || r.identifier || r.name || '';
    setBusyName(slug);
    try {
      const res = await authenticatedFetch('/api/skill-marketplace/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, source: r._source || r.source || 'clawhub' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      toast.success(wt('技能 "{{v0}}" 安装成功', { v0: slug }));
      await load();
    } catch (e) {
      toast.error(wt('安装失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusyName(null);
    }
  };

  /** 市场结果展示名（旧版 name||identifier||slug||meta.title） */
  const marketName = (r: MarketResult): string => r.name || r.identifier || r.slug || '?';

  const isInstalled = (r: MarketResult): boolean => {
    const slug = r.slug || r.identifier || r.name || '';
    return installedNames.has(slug) || installedNames.has(marketName(r));
  };

  // 市场源分类（市场形态 chips：全部 + 出现过的来源）
  const sourceNames = useMemo(
    () => Array.from(new Set(market.map((r) => r._source || r.source || '').filter(Boolean))),
    [market],
  );
  const filteredMarket = useMemo(
    () =>
      sourceFilter === 'all'
        ? market
        : market.filter((r) => (r._source || r.source || '') === sourceFilter),
    [market, sourceFilter],
  );

  // 市场分页切片（旧版 pageResults）
  const totalPages = Math.max(1, Math.ceil(filteredMarket.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const pageResults = filteredMarket.slice((curPage - 1) * pageSize, curPage * pageSize);

  /** 本地技能卡片（旧版 grid-cols-2 卡片：emoji+名称+描述+编辑/删除） */
  const renderLocalCard = (s: Skill, idx: number) => {
    return (
      <div className="card p-3" key={`${s.name}-${idx}`}>
        <div className="flex items-start gap-2">
          <span
            className="flex items-center justify-center shrink-0"
            style={{ width: 24, height: 24 }}
          >
            <Icon name={s.emoji || 'skill'} size={20} />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm text-primary truncate">{s.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5 truncate">{wt(s.description || '')}</p>
            {s.auxFiles && s.auxFiles.length > 0 ? (
              <div className="text-xs text-cyan-400 mt-1 flex items-center gap-1">
                <Icon name="file" size={12} /> {wt('辅助文件:')}
                {s.auxFiles.join(', ')}
              </div>
            ) : null}
            <div className="flex gap-1 mt-1">
              <button className="text-xs px-2 py-1 rounded" disabled={busyName === s.name} onClick={() => void exportZip(s.name)}>{wt('导出 ZIP 分享')}</button>
              <button
                className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400 hover:bg-blue-900/60"
                onClick={() => void openEdit(s.name)}
              >
                {wt('编辑')}
              </button>
              <button
                className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                onClick={() => void uninstall(s.name)}
                disabled={busyName === s.name}
              >
                {wt('删除')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="skill" size={20} /> {t('views.skillCenter')}
        </h2>
        <button className="btn-secondary text-sm" onClick={tab === 'market' ? loadMarket : load}>
          <span className="inline-flex items-center gap-1">
            <Icon name="refresh" size={14} /> {t('common.refresh')}
          </span>
        </button>
      </div>
      <div className="flex items-center gap-3 mb-4">
        <label className="btn-secondary text-sm">
          {zipBusy ? wt('导入中…') : wt('导入 ZIP 技能包')}
          <input type="file" accept=".zip,application/zip" aria-label={wt('导入 ZIP 技能包')} disabled={zipBusy} className="sr-only"
            onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importZip(file); }} />
        </label>
        <span className="text-xs text-gray-400">{wt('支持他人分享的完整技能目录，包含 SKILL.md、脚本和素材。ZIP ≤ 64 MB，解压后 ≤ 256 MB。')}</span>
      </div>

      {tab === 'local' ? (
        <>
          {/* 已安装计数 + 创建技能（旧版本地 tab 顶栏） */}
          <div className="flex justify-between items-center mb-3">
            <span className="text-sm text-gray-400">
              {wt('已安装:')}
              {skills.length}
            </span>
            <button className="btn-primary text-sm" onClick={() => setCreateOpen(true)}>
              <span className="inline-flex items-center gap-1">
                <Icon name="plus" size={12} /> {wt('创建技能')}
              </span>
            </button>
          </div>

          {/* 本地搜索框（过滤已安装列表） */}
          <div className="flex gap-2 mb-4">
            <div className="flex-1 relative">
              <span
                className="absolute"
                style={{ left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}
              >
                <Icon name="search" size={16} />
              </span>
              <input
                className="input-field text-sm w-full"
                style={{ paddingLeft: 32 }}
                placeholder={t('views.searchSkill')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          {loading ? (
            <div className="card p-8 text-center text-gray-400">
              <span className="spinner inline-block" />
              <p className="mt-2 text-sm">{wt('加载中…')}</p>
            </div>
          ) : error ? (
            <div className="card p-8 text-center text-red-400">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Icon name="alert" size={20} />
                <span>{wt('加载失败')}</span>
              </div>
              <p className="text-sm text-gray-500">{error}</p>
              <button className="btn-secondary text-sm mt-3" onClick={load}>
                {wt('重试')}
              </button>
            </div>
          ) : filteredLocal.length === 0 ? (
            <div className="card p-6 text-center text-gray-500">
              <p>{query ? wt('没有匹配的技能') : wt('暂无本地技能')}</p>
              {!query ? <p className="text-xs mt-1">{wt('从技能市场安装或手动创建')}</p> : null}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredLocal.map((s, i) => renderLocalCard(s, i))}
            </div>
          )}
        </>
      ) : (
        <>
          {/* 市场搜索卡（旧版：搜索框+按钮+市场源徽标） */}
          <div className="card p-4 mb-4">
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                className="input-field flex-1 text-sm"
                placeholder={t('views.searchSkill')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadMarket();
                }}
              />
              <button className="btn-primary text-sm flex items-center gap-1" onClick={loadMarket}>
                {searching ? (
                  <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                ) : null}
                {wt('搜索')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {sources.length
                ? sources.map((s, i) => (
                    <span
                      key={`${s.name || s.type}-${i}`}
                      className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900/30 text-blue-400"
                    >
                      {s.name || s.type || '?'}
                    </span>
                  ))
                : null}
            </div>
          </div>

          {/* 市场源分类 chips（市场形态：按来源过滤） */}
          {sourceNames.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {['all', ...sourceNames].map((s) => (
                <button
                  key={s}
                  className={
                    'text-xs px-2.5 py-1 rounded-full ' +
                    (sourceFilter === s
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600')
                  }
                  onClick={() => {
                    setSourceFilter(s);
                    setPage(1);
                  }}
                >
                  {s === 'all' ? wt('全部') : s}
                </button>
              ))}
            </div>
          ) : null}

          {searching ? (
            <div className="flex items-center justify-center py-12">
              <span className="animate-spin inline-block w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full mr-3" />
              <span className="text-gray-400 text-sm">{t('views.searching')}</span>
            </div>
          ) : pageResults.length === 0 ? (
            <div className="card p-6 text-center text-gray-500">
              <p>{t('views.noSkillFound')}</p>
              <p className="text-xs mt-2">
                <button className="text-cyan-400 underline mr-3" onClick={() => void loadMarket()}>
                  {t('views.retry')}
                </button>
                <button
                  className="text-cyan-400 underline"
                  onClick={() => {
                    setMarket([]);
                    setQuery('');
                  }}
                >
                  {t('views.searchHint')}
                </button>
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pageResults.map((r, i) => {
                  if (r._error) {
                    return (
                      <div
                        className="card p-2 border-l-2 border-red-500 md:col-span-2"
                        key={`err-${i}`}
                      >
                        <span className="text-red-400 text-xs">{r.name || 'Error'}</span>
                        <span className="text-xs text-gray-500 ml-2">{r.description || ''}</span>
                      </div>
                    );
                  }
                  const name = marketName(r);
                  const slug = r.slug || r.identifier || r.name || '';
                  const installed = isInstalled(r);
                  return (
                    <div className="card p-3 flex items-start gap-3" key={`${slug}-${i}`}>
                      <span
                        className="flex items-center justify-center shrink-0 rounded bg-yellow-900/30 text-yellow-400"
                        style={{ width: 36, height: 36 }}
                      >
                        <Icon name="skill" size={20} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-primary truncate">{name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900/30 text-blue-400">
                            {r._source || r.source || ''}
                          </span>
                        </div>
                        <p
                          className="text-xs text-gray-400 mt-0.5"
                          style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {r.description || ''}
                        </p>
                      </div>
                      <div className="shrink-0 self-center">
                        {installed ? (
                          <span className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-500 cursor-not-allowed inline-flex items-center gap-1">
                            <Icon name="check" size={12} /> {t('views.installed')}
                          </span>
                        ) : busyName === slug ? (
                          <button
                            className="text-xs px-2 py-1 rounded bg-yellow-900/30 text-yellow-400 flex items-center gap-1"
                            disabled
                          >
                            <span className="animate-spin inline-block w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full" />
                            {t('views.installing')}
                          </button>
                        ) : (
                          <button
                            className="text-xs px-2.5 py-1 rounded bg-green-900/30 text-green-400 hover:bg-green-900/60 inline-flex items-center gap-1"
                            onClick={() => void install(r)}
                          >
                            <Icon name="plus" size={12} /> {t('views.install')}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* 分页（旧版：总数+每页条数+上下页） */}
              {filteredMarket.length > 0 ? (
                <div className="flex items-center justify-between mt-4 text-xs text-gray-400">
                  <div className="flex items-center gap-2">
                    <span>
                      {t('views.total')} {filteredMarket.length}
                    </span>
                    <select
                      className="input-field text-xs py-0.5 w-20"
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(parseInt(e.target.value, 10));
                        setPage(1);
                      }}
                    >
                      {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <span>{t('views.perPage')}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className={
                        'px-2 py-0.5 rounded ' +
                        (curPage > 1
                          ? 'bg-gray-700 hover:bg-gray-600'
                          : 'bg-gray-800 text-gray-600 cursor-not-allowed')
                      }
                      onClick={() => curPage > 1 && setPage(curPage - 1)}
                      disabled={curPage <= 1}
                    >
                      &lt;
                    </button>
                    <span className="px-2">
                      {curPage} / {totalPages}
                    </span>
                    <button
                      className={
                        'px-2 py-0.5 rounded ' +
                        (curPage < totalPages
                          ? 'bg-gray-700 hover:bg-gray-600'
                          : 'bg-gray-800 text-gray-600 cursor-not-allowed')
                      }
                      onClick={() => curPage < totalPages && setPage(curPage + 1)}
                      disabled={curPage >= totalPages}
                    >
                      &gt;
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      {/* 创建技能弹窗（旧版 skillCreate modal：名称/图标/描述/步骤） */}
      {createOpen ? (
        <div className="modal-overlay" onClick={() => setCreateOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="skill" size={18} /> {wt('创建技能')}
              </h2>
              <button className="modal-close" onClick={() => setCreateOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="form-label">{wt('技能名称 *')}</label>
                <input
                  className="form-input"
                  value={createForm.name}
                  onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={wt('如：daily-report')}
                />
              </div>
              <div>
                <label className="form-label">{wt('图标（图标名）')}</label>
                <input
                  className="form-input"
                  value={createForm.emoji}
                  onChange={(e) => setCreateForm((f) => ({ ...f, emoji: e.target.value }))}
                  placeholder="skill"
                />
              </div>
              <div>
                <label className="form-label">{wt('技能描述 *')}</label>
                <input
                  className="form-input"
                  value={createForm.description}
                  onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder={wt('描述技能的适用场景，AI 会据此自动调用')}
                />
              </div>
              <div>
                <label className="form-label">{wt('操作步骤')}</label>
                <textarea
                  className="form-input font-mono text-xs"
                  rows={10}
                  value={createForm.steps}
                  onChange={(e) => setCreateForm((f) => ({ ...f, steps: e.target.value }))}
                  placeholder={wt('# 技能步骤（Markdown）\n\n1. 第一步…\n2. 第二一步…')}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setCreateOpen(false)}>
                {wt('取消')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void submitCreate()}
                disabled={creating}
              >
                {creating ? wt('创建中…') : wt('创建')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 编辑技能弹窗（旧版 skillEdit modal：内容编辑器） */}
      {editSkill ? (
        <div className="modal-overlay" onClick={() => setEditSkill(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="flex items-center gap-2">
                <Icon name="skill" size={18} /> {wt('编辑技能:')}
                {editSkill.name}
              </h2>
              <button className="modal-close" onClick={() => setEditSkill(null)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <textarea
              id="skillEditor"
              className="form-input font-mono text-xs"
              rows={18}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              disabled={editLoading}
              placeholder={editLoading ? wt('加载中...') : ''}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button className="btn-secondary" onClick={() => setEditSkill(null)}>
                {wt('取消')}
              </button>
              <button
                className="btn-primary"
                onClick={() => void submitEdit()}
                disabled={saving || editLoading}
              >
                {saving ? wt('保存中…') : wt('保存')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
