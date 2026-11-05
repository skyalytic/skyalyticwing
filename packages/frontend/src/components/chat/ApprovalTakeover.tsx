import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 审批接管条：存在待决审批时占据输入区，
// Enter = 批准一次 / Esc = 拒绝；其余决策按钮与备注保留在卡内。
// 多个待决时逐个接管（队列数显示），其余留在 ApprovalInlineStack。
import { useEffect } from 'react';
import { ApprovalInlineCard } from './ApprovalInlineCard';
import { useApprovalStore } from '@/stores/approval-store';
import { useSessionStore } from '@/stores/session-store';
import { toast } from '@/components/ui/Toast';

export function ApprovalTakeover() {
  useWorkbenchLanguage();
  const pending = useApprovalStore((s) => s.pendingApprovals);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const sessionPending = pending.filter((request) => !request.sessionId || request.sessionId === sessionId);
  const current = sessionPending[0];

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      // A modal owns keyboard input while open (for example generation history).
      if (e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = e.target instanceof Element ? e.target : null;
      // 备注输入框内回车不触发批准（避免误操作）
      if (
        e.key === 'Enter' &&
        target &&
        target.closest('input, textarea, button, a, select, [contenteditable="true"], [role="button"]')
      )
        return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void useApprovalStore.getState().respondApproval(current.id, 'allow-once').catch((error) => {
          toast.error(wt('审批操作失败'), error instanceof Error ? error.message : undefined);
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void useApprovalStore.getState().respondApproval(current.id, 'denied').catch((error) => {
          toast.error(wt('审批操作失败'), error instanceof Error ? error.message : undefined);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  if (!current) return null;

  return (
    <div className="mb-1">
      <div className="flex items-center justify-between mb-1 text-xs text-gray-400">
        <span>
          {wt('审批接管——')}
          <b>Enter</b> {wt('批准一次 /')}
          <b>Esc</b> {wt('拒绝')}
        </span>
        {sessionPending.length > 1 ? (
          <span>{wt('待决队列 {{count}}', { count: sessionPending.length })}</span>
        ) : null}
      </div>
      <ApprovalInlineCard key={current.id} request={current} />
    </div>
  );
}
