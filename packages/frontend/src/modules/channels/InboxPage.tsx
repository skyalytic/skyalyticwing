import { workbenchLocale } from '@/i18n/workbench-text';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';

interface Item {
  id: string;
  channelId: string;
  peer: string;
  thread: string;
  content: string;
  timestamp: number;
  direction: string;
  unread: boolean;
  task: string;
}
interface Draft {
  id: string;
  itemId: string;
  content: string;
  status: string;
  error?: string;
}
interface Inbox {
  items: Item[];
  drafts: Draft[];
}
/** Reject malformed responses before they can replace usable UI state. */
export function parseInbox(value: unknown): Inbox {
  const data = value as Inbox | null;
  if (
    !data ||
    !Array.isArray(data.items) ||
    !Array.isArray(data.drafts) ||
    !data.items.every(
      (i) =>
        i &&
        ['id', 'channelId', 'peer', 'thread', 'content', 'direction', 'task'].every(
          (k) => typeof (i as unknown as Record<string, unknown>)[k] === 'string',
        ) &&
        Number.isFinite(i.timestamp) &&
        typeof i.unread === 'boolean',
    ) ||
    !data.drafts.every(
      (d) =>
        d &&
        ['id', 'itemId', 'content', 'status'].every(
          (k) => typeof (d as unknown as Record<string, unknown>)[k] === 'string',
        ),
    )
  ) {
    throw new Error(wt('收件箱数据格式异常，请重试或检查本地服务。'));
  }
  return data;
}
export function InboxPage() {
  useWorkbenchLanguage();
  const [data, setData] = useState<Inbox>({ items: [], drafts: [] });
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState('');
  const [draftId, setDraftId] = useState<string>();
  const [confirm, setConfirm] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearIds, setClearIds] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const reload = async () => {
    const current = ++generation.current;
    try {
      const next = parseInbox(await apiClient.get<unknown>('/inbox'));
      if (current !== generation.current) return;
      setData(next);
      setError('');
    } catch (e) {
      if (current !== generation.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await reload();
      if (active) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => {
      active = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, []);
  const item = data.items.find((i) => i.id === selected);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast.error(wt('操作失败'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, body: unknown) =>
    run(() => apiClient.post(`/inbox/items/${encodeURIComponent(id)}`, body));
  const remove = (ids: string[]) => run(async () => {
    generation.current++;
    await apiClient.post('/inbox/clear', { ids });
    if (ids.includes(selected)) { setSelected(''); setDraftId(undefined); setContent(''); setConfirm(null); }
    setClearIds(null);
  });
  const visible = data.items.filter(
    (i) =>
      (filter === 'all' ||
        (filter === 'unread' && i.unread) ||
        (filter === 'todo' && i.task === 'todo')) &&
      `${i.channelId} ${i.peer} ${i.content}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main className="sky-inbox">
      <header>
        <div>
          <h1>{wt('统一收件箱')}</h1>
          <p>{wt('汇总渠道消息与待办。渠道会自动回复，你也可以在这里撰写补充回复。')}</p>
        </div>
        <Link to="/channels">{wt('接入渠道')}</Link>
      </header>
      <div className="sky-inbox-filters">
        <input
          aria-label={wt('搜索收件箱')}
          placeholder={wt('搜索渠道、联系人、内容')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {[
          ['all', wt('全部')],
          ['unread', wt('未读')],
          ['todo', wt('待办')],
        ].map(([id, label]) => (
          <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id!)}>
            {label} {id === 'unread' ? data.items.filter((i) => i.unread).length : ''}
          </button>
        ))}
        <button disabled={busy || data.items.length === 0} onClick={() => setClearIds(data.items.map(i => i.id))}>
          {wt('一键清理全部')}
        </button>
      </div>
      {error && (
        <div role="alert" className="sky-notice">
          {error} <button onClick={() => void reload()}>{wt('重试')}</button>
        </div>
      )}
      <div className="sky-inbox-grid">
        <section aria-label={wt('消息列表')}>
          {visible.length === 0 ? (
            <p>{wt('暂无消息。接入渠道后，收到的消息会自动汇总到这里。')}</p>
          ) : (
            visible.map((i) => (
              <button
                className="sky-inbox-item"
                disabled={busy}
                key={i.id}
                aria-pressed={i.id === selected}
                onClick={() => {
                  setSelected(i.id);
                  setDraftId(undefined);
                  setContent('');
                  setConfirm(null);
                  if (i.unread) void update(i.id, { unread: false });
                }}
              >
                <strong>
                  {i.unread ? '● ' : ''}
                  {i.channelId} · {i.peer}
                </strong>
                <span>{i.content.slice(0, 140)}</span>
                <small>
                  {new Date(i.timestamp).toLocaleString(workbenchLocale())} ·{' '}
                  {i.direction === 'inbound' ? wt('收到') : wt('已发送')}{' '}
                  {i.task === 'todo' ? wt('· 待办') : ''}
                </small>
              </button>
            ))
          )}
        </section>
        <section aria-label={wt('消息详情')}>
          {item ? (
            <>
              <h2>
                {item.channelId} · {item.peer}
              </h2>
              <p className="sky-inbox-content">{item.content}</p>
              <div className="sky-inbox-filters">
                <button disabled={busy} onClick={() => void remove([item.id])}>{wt('删除此消息')}</button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void update(item.id, { task: item.task === 'todo' ? 'done' : 'todo' })
                  }
                >
                  {item.task === 'todo' ? wt('完成待办') : wt('设为待办')}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void update(item.id, { unread: !item.unread })}
                >
                  {item.unread ? wt('标为已读') : wt('标为未读')}
                </button>
              </div>
              {data.drafts
                .filter((d) => d.itemId === item.id)
                .map((d) => (
                  <article key={d.id} className="sky-inbox-draft">
                    <strong>
                      {
                        (
                          {
                            draft: wt('待确认草稿'),
                            sending: wt('发送中'),
                            sent: wt('已发送'),
                            unknown: wt('结果待核对'),
                          } as Record<string, string>
                        )[d.status]
                      }
                    </strong>
                    <p className="sky-inbox-content">{d.content}</p>
                    {d.error && (
                      <p role="alert">
                        {d.error} {wt('请先在渠道核对，不要重复发送。')}
                      </p>
                    )}
                    {d.status === 'draft' && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          setContent(d.content);
                          setDraftId(d.id);
                          setConfirm(null);
                        }}
                      >
                        {wt('编辑此草稿')}
                      </button>
                    )}
                  </article>
                ))}
              {item.direction === 'inbound' && (
                <>
                  <label>
                    {wt('回复草稿')}
                    <textarea
                      aria-label={wt('回复草稿')}
                      value={content}
                      maxLength={20000}
                      onChange={(e) => {
                        setContent(e.target.value);
                        setConfirm(null);
                      }}
                      placeholder={wt('在这里撰写补充回复')}
                    />
                  </label>
                  <button
                    disabled={busy || !content.trim()}
                    onClick={() =>
                      void run(async () => {
                        const d = await apiClient.post<Draft>('/inbox/drafts', {
                          itemId: item.id,
                          content,
                          draftId,
                        });
                        setDraftId(d.id);
                        setConfirm(d);
                      })
                    }
                  >
                    {wt('保存草稿并预览发送')}
                  </button>
                </>
              )}
              {confirm && (
                <div role="dialog" aria-label={wt('确认发送回复')} className="sky-inbox-confirm">
                  <h3>{wt('确认发送')}</h3>
                  <p>
                    {wt('渠道：')}
                    {item.channelId} {wt('· 收件人：')}
                    {item.peer} {wt('· 会话：')}
                    {(() => {
                      try {
                        return JSON.parse(item.thread).filter(Boolean).join(' / ');
                      } catch {
                        return item.thread;
                      }
                    })()}
                  </p>
                  <p className="sky-inbox-content">{confirm.content}</p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await apiClient.post<Draft>(
                          `/inbox/drafts/${confirm.id}/send`,
                          { confirmedContent: confirm.content },
                        );
                        setConfirm(null);
                        if (result.status === 'sent') {
                          setContent('');
                          setDraftId(undefined);
                          toast.success(wt('已发送'));
                        } else toast.error(wt('发送结果待核对'), result.error);
                      })
                    }
                  >
                    {wt('确认，发送给此收件人')}
                  </button>
                  <button disabled={busy} onClick={() => setConfirm(null)}>
                    {wt('取消')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p>{wt('选择一条消息，查看上下文、安排待办或处理回复。')}</p>
          )}
        </section>
      </div>
      <Modal open={clearIds !== null} title={wt('清理全部收件消息')} onClose={() => {if (!busy) setClearIds(null);}}
        footer={<><button className="btn btn-secondary" disabled={busy} onClick={() => setClearIds(null)}>{wt('取消')}</button><button className="btn btn-danger" disabled={busy} onClick={() => clearIds && void remove(clearIds)}>{busy ? wt('处理中…') : wt('确认清理')}</button></>}>
        <p>{wt('将删除所选的 {{count}} 条本地消息及关联草稿。', {count: clearIds?.length || 0})}</p>
        <p>{wt('不会撤回渠道中的消息；清理期间新收到的消息会保留。')}</p>
      </Modal>
    </main>
  );
}
