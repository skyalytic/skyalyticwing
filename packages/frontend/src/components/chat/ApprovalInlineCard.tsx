import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 内嵌审批卡：审批请求以卡片形式嵌入对话流（消息列表与输入框之间），
// 替代原全局弹窗 ApprovalDialog。待决时显示 4 种决策按钮，决策后卡片
// 成功后从操作区移除；已决样式仅供历史详情展示。
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/Icon';
import {
  useApprovalStore,
  type ApprovalDecision,
  type ApprovalResolvedRecord,
} from '@/stores/approval-store';
import { formatRelativeTime } from '@/utils/format';
import { toast } from '@/components/ui/Toast';
import type { ToolApprovalRequest } from '@/types';

/** 参数截断阈值 */
const ARGS_TRUNCATE_LIMIT = 500;

/** 命令类工具 */
function isCommandTool(toolName: string): boolean {
  return (
    toolName === 'bash' ||
    toolName === 'powershell' ||
    toolName === 'code_execution' ||
    toolName === 'code_build'
  );
}

/** 从参数中提取执行命令文本 */
function extractCommandText(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  return String(
    (a['command'] as string) ||
      (a['cmd'] as string) ||
      (a['script'] as string) ||
      (a['code'] as string) ||
      '',
  );
}

/** 决策的展示文案 */
const DECISION_LABEL: Record<ApprovalDecision, string> = {
  get 'allow-once'() {
    return wt('已批准（本次）');
  },
  get 'allow-always'() {
    return wt('已批准（始终）');
  },
  get denied() {
    return wt('已拒绝');
  },
  get 'deny-always'() {
    return wt('已拒绝（始终）');
  },
};

export interface ApprovalInlineCardProps {
  request: ToolApprovalRequest;
  /** 已决记录（存在时卡片为最终态，无按钮） */
  resolved?: ApprovalResolvedRecord;
}

export function ApprovalInlineCard({ request, resolved }: ApprovalInlineCardProps) {
  useWorkbenchLanguage();
  const respondApproval = useApprovalStore((s) => s.respondApproval);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const isCmd = isCommandTool(request.toolName);
  const cmdText = isCmd ? extractCommandText(request.args) : '';

  // 参数序列化与截断
  let argsStr = '';
  try {
    argsStr = request.args ? JSON.stringify(request.args, null, 2) : '';
  } catch {
    argsStr = String(request.args ?? '');
  }
  const tooLong = argsStr.length > ARGS_TRUNCATE_LIMIT;
  const argsDisplay = tooLong && !expanded ? argsStr.slice(0, ARGS_TRUNCATE_LIMIT) + '…' : argsStr;

  const handleRespond = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await respondApproval(request.id, decision, reason || undefined);
    } catch (e) {
      toast.error(wt('审批操作失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  // 已决状态：紧凑结果卡（无按钮、无备注输入）
  if (resolved) {
    const ok = resolved.decision === 'allow-once' || resolved.decision === 'allow-always';
    return (
      <div
        className="approval-card-resolved rounded-lg border px-3 py-2"
        style={{
          borderColor: ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)',
          background: ok ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          opacity: 0.85,
        }}
      >
        <div className="flex items-center justify-between gap-2" style={{ fontSize: uiFontSize(13) }}>
          <span className="flex items-center gap-2 min-w-0">
            <Icon name={isCmd ? 'terminal' : 'tool'} size={14} />
            <span className="font-mono truncate" style={{ color: 'var(--text-primary)' }}>
              {request.toolName}
            </span>
            <Badge variant={ok ? 'success' : 'danger'}>{DECISION_LABEL[resolved.decision]}</Badge>
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: uiFontSize(12), flexShrink: 0 }}>
            {formatRelativeTime(resolved.resolvedAt)}
          </span>
        </div>
        {resolved.reason ? (
          <div style={{ fontSize: uiFontSize(12), color: 'var(--text-muted)', marginTop: 4 }}>
            {resolved.reason}
          </div>
        ) : null}
        {isCmd && cmdText ? (
          <div
            className="font-mono mt-1"
            style={{ fontSize: uiFontSize(12), color: 'var(--text-secondary)', wordBreak: 'break-all' }}
          >
            {cmdText.slice(0, 160)}
            {cmdText.length > 160 ? '…' : ''}
          </div>
        ) : null}
      </div>
    );
  }

  // 待决状态：完整审批卡
  return (
    <div
      className="approval-card-pending rounded-lg border px-3 py-3"
      role="region"
      aria-label={wt('工具审批请求')}
      style={{
        borderColor: 'rgba(251,191,36,0.5)',
        background: 'rgba(251,191,36,0.05)',
      }}
    >
      {/* 头部：工具名 + 等待中徽标 */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="flex items-center gap-2 min-w-0" style={{ fontSize: uiFontSize(13) }}>
          <Icon name={isCmd ? 'terminal' : 'tool'} size={14} />
          <span style={{ color: 'var(--text-muted)' }}>
            {isCmd ? wt('命令执行请求') : wt('工具调用请求')}
          </span>
          <span
            className="font-mono font-bold truncate"
            style={{ color: 'var(--accent, #38bdf8)' }}
          >
            {request.toolName}
          </span>
        </span>
        <Badge variant="warning">{wt('等待审批')}</Badge>
      </div>

      {/* 审批原因 */}
      {request.reason ? (
        <div style={{ fontSize: uiFontSize(12), color: 'var(--warning, #fbbf24)', marginBottom: 6 }}>
          {request.reason}
        </div>
      ) : null}

      {/* 命令专属：执行命令文本 */}
      {isCmd && cmdText ? (
        <pre
          className="font-mono rounded"
          style={{
            fontSize: uiFontSize(12),
            color: 'var(--text-primary)',
            background: 'var(--bg-secondary, #1e293b)',
            padding: 8,
            marginTop: 4,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 120,
            overflow: 'auto',
          }}
        >
          {cmdText}
        </pre>
      ) : null}

      {/* 参数（截断 + 展开） */}
      {argsStr ? (
        <div className="mt-2">
          <div
            className="flex justify-between items-center"
            style={{ color: 'var(--text-muted)', fontSize: uiFontSize(12) }}
          >
            <span>{wt('参数')}</span>
            {tooLong ? (
              <button
                type="button"
                className="btn-secondary"
                style={{ fontSize: uiFontSize(11), padding: '2px 8px' }}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? wt('收起') : wt('展开全部')}
              </button>
            ) : null}
          </div>
          <pre
            className="font-mono"
            style={{
              color: 'var(--text-primary, #e2e8f0)',
              fontSize: uiFontSize(12),
              background: 'var(--bg-secondary, #1e293b)',
              padding: 8,
              borderRadius: 4,
              marginTop: 4,
              maxHeight: expanded ? 300 : 120,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {argsDisplay}
          </pre>
        </div>
      ) : null}

      {/* 备注（可选，紧凑单行） */}
      <input
        className="input-field mt-2"
        style={{ fontSize: uiFontSize(12), padding: '4px 8px' }}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={wt('备注（可选）')}
      />

      {/* 决策按钮 */}
      <div className="flex gap-2 justify-end flex-wrap mt-2">
        <button
          type="button"
          className="btn-danger"
          style={{ fontSize: uiFontSize(12), padding: '4px 12px' }}
          onClick={() => handleRespond('denied')}
          disabled={busy}
        >
          {wt('拒绝')}
        </button>
        <button
          type="button"
          className="btn-danger"
          style={{ fontSize: uiFontSize(12), padding: '4px 12px' }}
          onClick={() => handleRespond('deny-always')}
          disabled={busy}
          title={wt('拒绝并创建持久规则')}
        >
          {wt('始终拒绝')}
        </button>
        <button
          type="button"
          className="btn-primary"
          style={{ fontSize: uiFontSize(12), padding: '4px 12px', background: '#1d4ed8', color: '#fff' }}
          onClick={() => handleRespond('allow-always')}
          disabled={busy}
          title={wt('批准并创建持久规则')}
        >
          {wt('始终允许')}
        </button>
        <button
          type="button"
          className="btn-primary"
          style={{ fontSize: uiFontSize(12), padding: '4px 12px', background: '#15803d', color: '#fff', fontWeight: 600 }}
          onClick={() => handleRespond('allow-once')}
          disabled={busy}
        >
          {wt('批准一次')}
        </button>
      </div>
    </div>
  );
}
