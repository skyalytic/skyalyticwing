import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 会话管理页面
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';
import { useSessions } from '@/hooks/use-sessions';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { toast } from '@/components/ui/Toast';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { Icon } from '@/components/Icon';
import { formatRelativeTime } from '@/utils/format';
import type { ChatMessage, SessionInfo } from '@/types';

export function SessionsPage() {
  useWorkbenchLanguage();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    sessions,
    loading,
    error,
    loadSessions,
    selectSession,
    createSession,
    deleteSession,
    renameSession,
  } = useSessions();
  const [renaming, setRenaming] = useState<SessionInfo | null>(null);
  const [title, setTitle] = useState('');
  const [viewing, setViewing] = useState<SessionInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  // K 子代理/系统会话透视：开关打开时附加显示系统内部会话（只读）
  const [showSystem, setShowSystem] = useState(false);
  const [systemSessions, setSystemSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!showSystem) {
      setSystemSessions([]);
      return;
    }
    apiClient
      .get<SessionInfo[]>('/sessions?includeSystem=1')
      .then((d) => setSystemSessions((d ?? []).filter((s) => s.id.startsWith('bg-task-'))))
      .catch(() => setSystemSessions([]));
  }, [showSystem]);

  const handleOpen = useCallback(
    (id: string) => {
      selectSession(id);
      navigate('/');
    },
    [selectSession, navigate],
  );

  /** K 系统会话透视开关（子代理/后台任务会话只读查看） */
  const toggleSystem = () => setShowSystem((v) => !v);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!(await showConfirm(wt('确定删除该会话？此操作不可撤销。')))) return;
      await deleteSession(id);
      toast.success(wt('会话已删除'));
    },
    [deleteSession],
  );

  const handleCreate = useCallback(async () => {
    const id = await createSession();
    if (id) {
      toast.success(wt('已创建新会话'));
      navigate('/');
    }
  }, [createSession, navigate]);

  const startRename = useCallback((s: SessionInfo) => {
    setRenaming(s);
    setTitle(s.title);
  }, []);

  const confirmRename = useCallback(async () => {
    if (!renaming) return;
    await renameSession(renaming.id, title.trim() || renaming.title);
    setRenaming(null);
    toast.success(t('sessions.renamed'));
  }, [renaming, title, renameSession, t]);

  const viewMessages = useCallback(async (s: SessionInfo) => {
    setViewing(s);
    setLoadingMsgs(true);
    try {
      const list = await apiClient.get<ChatMessage[]>(`/sessions/${s.id}/messages`);
      setMessages(list ?? []);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.sessionsManage')}</div>
          <div className="page-subtitle">{t('common.totalCount', { count: sessions.length })}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={toggleSystem}
            title={wt('显示子代理/后台任务等系统内部会话（只读透视）')}
          >
            {showSystem ? wt('隐藏系统会话') : wt('显示系统会话')}
          </Button>
          <Button variant="primary" onClick={handleCreate}>
            ＋ {t('topbar.newSession')}
          </Button>
        </div>
      </div>

      {error ? <div className="text-danger mb-4">{error}</div> : null}

      {loading ? (
        <SpinnerWrap label={t('common.loading')} />
      ) : sessions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="session" size={48} />
          </div>
          <div>{t('common.noData')}</div>
        </div>
      ) : (
        <div className="list">
          {(showSystem ? [...sessions, ...systemSessions] : sessions).map((s) => (
            <div className="list-row" key={s.id}>
              <div className="list-row-main">
                <div className="list-row-title">{s.title || t('chat.untitledSession')}</div>
                <div className="list-row-sub">
                  <Badge variant="info">
                    {t('common.messagesCount', { count: s.messageCount })}
                  </Badge>
                  <span style={{ marginLeft: 8 }}>
                    {t('common.updated')} {formatRelativeTime(s.updatedAt)}
                  </span>
                  {s.model ? <span style={{ marginLeft: 8 }}>· {s.model}</span> : null}
                </div>
              </div>
              <div className="list-row-actions">
                <Button size="sm" variant="secondary" onClick={() => handleOpen(s.id)}>
                  {t('common.open')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => viewMessages(s)}>
                  {t('common.view')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => startRename(s)}>
                  {t('common.rename')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => handleDelete(s.id)}>
                  {t('common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!renaming}
        title={t('common.rename')}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={confirmRename}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Input
          label={t('views.sessionsManage')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
      </Modal>

      <Modal
        open={!!viewing}
        title={viewing ? `${t('chat.messages')} - ${viewing.title}` : ''}
        onClose={() => setViewing(null)}
        width={640}
      >
        {loadingMsgs ? (
          <SpinnerWrap label={t('common.loading')} />
        ) : messages.length === 0 ? (
          <div className="empty-state">{t('common.noData')}</div>
        ) : (
          <div className="list">
            {messages.map((m) => (
              <div
                key={m.id}
                className="msg-content"
                style={{ background: 'var(--color-primary)' }}
              >
                <div className="text-sm text-muted mb-4">{m.role}</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
