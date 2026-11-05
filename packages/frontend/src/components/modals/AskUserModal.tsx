import { shortcutText, primaryModifier, composingKey } from '@/utils/shortcuts';
import { uiFontSize } from '@/utils/typography';
// ask_user 交互弹窗：Agent 向用户提问（单选 radio / 多选 checkbox / 自由文本），
// 风格对齐 ApprovalDialog；提交与取消均会回复后端，避免其挂起等待直到超时
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/Icon';
import { toast } from '@/components/ui/Toast';
import { apiClient } from '@/services/api-client';
import { useAskUserStore } from '@/stores/ask-user-store';
import { useSessionStore } from '@/stores/session-store';

export function AskUserModal({ allSessions = false }: { allSessions?: boolean } = {}) {
  const { t } = useTranslation();
  const sessionId = useSessionStore(s => s.currentSessionId);
  const request = useAskUserStore(s => s.requests.find(r => allSessions || !r.sessionId || r.sessionId === sessionId));
  const visible = !!request;
  const remove = useAskUserStore(s => s.remove);

  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const hasOptions = (request?.options?.length ?? 0) > 0;

  // 新请求弹出时重置本地输入状态
  useEffect(() => {
    if (visible) {
      setSelected([]);
      setText('');
      setBusy(false);
    }
  }, [visible, request?.id]);

  if (!visible || !request) return null;

  /** 统一回复：POST /api/tools/ask-user/respond body { id, answer }（单选传单元素数组；取消传空数组） */
  const respond = async (answer: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiClient.post('/tools/ask-user/respond', { id: request.id, answer });
      remove(request.id);
    } catch (e) {
      // 失败保留弹窗，用户可重试或取消（取消同样会回复空数组）
      setBusy(false);
      toast.error(t('chat.askUser.submitFailed'), e instanceof Error ? e.message : undefined);
    }
  };

  /** 选项点击：单选互斥，多选切换 */
  const toggle = (option: string) => {
    setText('');
    setSelected((prev) => {
      if (!request.multiple) return [option];
      return prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option];
    });
  };

  const answer = text.trim() ? [text.trim()] : selected;
  const canSubmit = answer.length > 0 && !busy;

  const footer = (
    <div className="flex gap-2 justify-end flex-wrap">
      <button
        type="button"
        className="btn-secondary"
        onClick={() => void respond([])}
        disabled={busy}
      >
        {t('chat.askUser.cancel')}
      </button>
      <button
        type="button"
        className="btn-primary"
        onClick={() => void respond(answer)}
        disabled={!canSubmit}
      >
        {t('chat.askUser.submit')}
      </button>
    </div>
  );

  return (
    <Modal
      open={visible}
      title={
        <span className="flex items-center gap-2">
          <Icon name="chat" size={18} />
          <Badge variant="info">{t('chat.askUser.badge')}</Badge>
          {t('chat.askUser.title')}
        </span>
      }
      onClose={() => void respond([])}
      width={520}
      closeOnOverlay={false}
      footer={footer}
    >
      {/* 问题卡片（对齐审批弹窗信息卡片样式） */}
      <div
        style={{
          background: 'var(--bg-tertiary, #0f172a)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 12,
        }}
      >
        {hasOptions && <div
          className="flex items-center gap-2 mb-1"
          style={{ fontSize: uiFontSize(12), color: 'var(--text-muted, #94a3b8)' }}
        >
          <Icon name="agent" size={14} />
          <span>{request.multiple ? t('chat.askUser.multipleHint') : t('chat.askUser.singleHint')}</span>
        </div>}
        <div style={{ fontSize: uiFontSize(14), color: 'var(--text-primary, #e2e8f0)', whiteSpace: 'pre-wrap' }}>
          {request.question}
        </div>
      </div>

      {hasOptions ? (
        /* 选项列表：multiple=true 多选 / false 单选（自绘选中态图标，不使用 emoji） */
        <div className="space-y-2">
          {request.options.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                type="button"
                key={option}
                className={`w-full text-left px-3 py-2 rounded border flex items-center gap-2 cursor-pointer ${
                  active
                    ? 'border-blue-500 bg-blue-900/30 text-blue-300'
                    : 'border-gray-600 bg-gray-700/50 text-gray-300 hover:border-gray-500'
                }`}
                onClick={() => toggle(option)}
                disabled={busy}
              >
                <span
                  className={`flex items-center justify-center flex-shrink-0 border ${
                    request.multiple ? 'rounded' : 'rounded-full'
                  } ${active ? 'border-blue-400 bg-blue-500' : 'border-gray-500'}`}
                  style={{ width: 16, height: 16 }}
                >
                  {active ? <Icon name="check" size={12} className="text-white" /> : null}
                </span>
                <span className="text-sm break-all">{option}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {/* Always allow an answer such as a file path, even when options exist. */}
      <label className="block mt-3">
        {hasOptions && <span className="text-sm">{t('chat.askUser.customAnswer')}</span>}
        <textarea
          className="input-field w-full resize-none"
          rows={4}
          value={text}
          autoFocus
          placeholder={shortcutText(t('chat.askUser.inputPlaceholder'))}
          aria-label={t('chat.askUser.customAnswer')}
          disabled={busy}
          onChange={(e) => { setText(e.target.value); setSelected([]); }}
          onKeyDown={(e) => {
            if (!composingKey(e.nativeEvent) && e.key === 'Enter' && primaryModifier(e) && canSubmit) {
              void respond(answer);
            }
          }}
        />
      </label>
    </Modal>
  );
}
