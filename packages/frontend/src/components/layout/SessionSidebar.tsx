import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 左栏会话区：
// 置顶组 + 最近列表 + 归档折叠组；头部搜索框（标题即时匹配 + 250ms 防抖的
// 会话内容搜索，命中带摘要）。点击行打开会话；行 hover 提供置顶/归档/删除。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { apiClient } from '@/services/api-client';
import { useSessionStore } from '@/stores/session-store';
import type { SessionInfo } from '@/types';

/** 内容搜索命中项（GET /sessions/search） */
interface SessionSearchItem {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  match: 'title' | 'content';
  snippet?: string;
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return wt('刚刚');
  if (diff < 3_600_000) return wt('{{v0}} 分钟前', { v0: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return wt('{{v0}} 小时前', { v0: Math.floor(diff / 3_600_000) });
  return wt('{{v0}} 天前', { v0: Math.floor(diff / 86_400_000) });
}

export function SessionSidebar({ manageOpen = false }: { manageOpen?: boolean }) {
  useWorkbenchLanguage();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const loadSessions = useSessionStore((s) => s.loadSessions);
  const selectSession = useSessionStore((s) => s.selectSession);
  const pinSession = useSessionStore((s) => s.pinSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SessionSearchItem[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // 管理模式：全量会话（含系统会话）+ 系统会话显示开关（对齐原会话管理页能力）
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [showSystem, setShowSystem] = useState(false);
  const [recovery, setRecovery] = useState<{ archiveDirectory: string } | null>(null);
  useEffect(() => {
    let active = true;
    apiClient.get<{ archiveDirectory: string } | null>('/sessions/recovery')
      .then(value => { if (active) setRecovery(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!manageOpen) return;
    apiClient
      .get<SessionInfo[]>('/sessions?includeSystem=1')
      .then((d) => setAllSessions(d ?? []))
      .catch(() => setAllSessions([]));
  }, [manageOpen, sessions]);

  // 内容搜索：250ms 防抖（标题即时匹配由后端一并处理）
  useEffect(() => {
    const q = query.trim();
    let activeRequest = true;
    if (!q) {
      setSearchResults(null);
      return;
    }
    const t = setTimeout(() => {
      apiClient
        .get<SessionSearchItem[]>(`/sessions/search?q=${encodeURIComponent(q)}`)
        .then((d) => {
          if (activeRequest) setSearchResults(Array.isArray(d) ? d : []);
        })
        .catch(() => {
          if (activeRequest) setSearchResults([]);
        });
    }, 250);
    return () => {
      activeRequest = false;
      clearTimeout(t);
    };
  }, [query]);

  const openSession = (id: string) => {
    selectSession(id);
    navigate('/');
  };

  const active = sessions.filter((s) => !s.archived);
  const pinned = active.filter((s) => s.pinned);
  const recent = active.filter((s) => !s.pinned).slice(0, 12);
  const archived = sessions.filter((s) => s.archived);
  // 管理模式数据源：全量（含系统会话），开关过滤系统会话（id 前缀 bg-task-，对齐原会话管理页）
  const manageList = showSystem
    ? allSessions
    : allSessions.filter((s) => !s.id.startsWith('bg-task-'));
  const manageArchived = manageList.filter((s) => s.archived);
  const manageActive = manageList.filter((s) => !s.archived);

  const row = (s: SessionInfo) => (
    <div
      key={s.id}
      className={`group/s flex items-center gap-1 px-2 py-1 rounded cursor-pointer text-xs ${
        s.id === currentSessionId
          ? 'bg-blue-500/15 text-blue-300'
          : 'text-gray-300 hover:bg-black/20 dark:hover:bg-white/5'
      }`}
      onClick={() => openSession(s.id)}
      title={s.title}
    >
      <span className={`flex-1 truncate ${s.archived ? 'opacity-50' : ''}`}>{s.title}</span>
      <span className="text-[10px] opacity-40 shrink-0">{relTime(s.updatedAt)}</span>
      <span className="hidden group-hover/s:flex items-center gap-1 shrink-0">
        <Icon
          name="pin"
          size={12}
          title={s.pinned ? wt('取消置顶') : wt('置顶')}
          onClick={() => void pinSession(s.id, !s.pinned)}
          className={`cursor-pointer ${s.pinned ? 'text-blue-400' : 'opacity-50 hover:opacity-100'}`}
        />
        <Icon
          name="archive"
          size={12}
          title={s.archived ? wt('取消归档') : wt('归档')}
          onClick={() => void archiveSession(s.id, !s.archived)}
          className="cursor-pointer opacity-50 hover:opacity-100"
        />
        <Icon
          name="trash"
          size={12}
          title={wt('删除会话')}
          onClick={() => void deleteSession(s.id)}
          className="cursor-pointer opacity-50 hover:opacity-100 hover:text-red-400"
        />
      </span>
    </div>
  );

  return (
    <div className="sky-session-history flex flex-col min-h-0 flex-1">
      {recovery && (
        <details role="status" className="mx-2 my-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-relaxed">
          <summary className="cursor-pointer">{wt('历史会话文件需要恢复')}</summary>
          <p className="mt-2">{wt('原始文件已完整保留，新会话可以正常使用。备份位置：')}</p>
          <code className="block mt-1 break-all select-text">{recovery.archiveDirectory}</code>
        </details>
      )}
      {/* 搜索框（展开式：标题+内容全文搜索） */}
      <div className="px-2 pt-2 pb-1 shrink-0">
        <div className="sky-session-search">
          <Icon name="search" size={14} />
          <input
            type="text"
            className="sky-session-search-input"
            aria-label={wt('搜索会话')}
            placeholder={wt('搜索会话（标题/内容）…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-1 pb-2">
        {searchResults !== null ? (
          /* 搜索结果 */
          searchResults.length === 0 ? (
            <div className="px-2 py-2 text-xs opacity-40">{wt('无匹配会话')}</div>
          ) : (
            searchResults.map((r) => (
              <div
                key={r.sessionId}
                className="px-2 py-1.5 rounded cursor-pointer text-xs hover:bg-black/20 dark:hover:bg-white/5"
                onClick={() => {
                  setQuery('');
                  openSession(r.sessionId);
                }}
              >
                <div className="flex items-center gap-1">
                  <span className="flex-1 truncate text-gray-200">{r.title}</span>
                  <span className="text-[10px] opacity-40 shrink-0">
                    {r.messageCount} {wt('条')}
                  </span>
                </div>
                {r.snippet ? (
                  <div className="text-[10px] opacity-50 truncate mt-0.5">{r.snippet}</div>
                ) : null}
              </div>
            ))
          )
        ) : manageOpen ? (
          /* 管理模式：全量会话就地管理（含系统会话开关与归档展开） */
          <>
            <div className="px-2 pt-1 pb-0.5 text-[10px] tracking-wider opacity-40 flex items-center justify-between gap-1">
              <span>
                {wt('全部会话（')}
                {manageList.length}）
              </span>
              <button
                className="hover:opacity-80 underline underline-offset-2"
                onClick={() => setShowSystem((v) => !v)}
              >
                {showSystem ? wt('隐藏系统会话') : wt('显示系统会话')}
              </button>
            </div>
            {manageActive.length > 0 ? (
              manageActive.map(row)
            ) : (
              <div className="px-2 py-1 text-xs opacity-40">{wt('暂无会话')}</div>
            )}
            {manageArchived.length > 0 ? (
              <>
                <div className="px-2 pt-2 pb-0.5 text-[10px] tracking-wider opacity-40">
                  {wt('已归档（')}
                  {manageArchived.length}）
                </div>
                {manageArchived.map(row)}
              </>
            ) : null}
          </>
        ) : (
          <>
            {/* 置顶组 */}
            {pinned.length > 0 ? (
              <>
                <div className="px-2 pt-1 pb-0.5 text-[10px] tracking-wider opacity-40">
                  {wt('置顶')}
                </div>
                {pinned.map(row)}
              </>
            ) : null}
            {/* 最近 */}
            <div className="px-2 pt-1 pb-0.5 text-[10px] tracking-wider opacity-40">
              {wt('最近')}
            </div>
            {recent.length > 0 ? (
              recent.map(row)
            ) : (
              <div className="px-2 py-1 text-xs opacity-40">{wt('暂无会话')}</div>
            )}
            {/* 归档折叠组 */}
            {archived.length > 0 ? (
              <div className="mt-1">
                <button
                  className="w-full flex items-center gap-1 px-2 py-0.5 text-[10px] tracking-wider opacity-40 hover:opacity-70"
                  onClick={() => setShowArchived((v) => !v)}
                >
                  <Icon name="archive" size={10} />
                  {wt('已归档（')}
                  {archived.length}）
                </button>
                {showArchived ? archived.map(row) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
