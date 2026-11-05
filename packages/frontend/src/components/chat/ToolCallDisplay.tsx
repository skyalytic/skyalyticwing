import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工具调用展示
import { useState } from 'react';
import { toolPresentation } from './tool-presentation';
import { Icon } from '@/components/Icon';
import { JsonBlock } from './MarkdownRenderer';
import { prettyJson } from '@/utils/format';
import type { ToolCallInfo, ToolResult } from '@/types';

export interface ToolCallDisplayProps {
  call?: ToolCallInfo;
  name?: string;
  args?: unknown;
  result?: ToolResult | string | null;
  status?: 'running' | 'success' | 'error' | 'pending';
}

export function ToolCallDisplay({ call, name, args, result, status }: ToolCallDisplayProps) {
  useWorkbenchLanguage();
  const toolName = call?.name ?? name ?? 'unknown';
  const [expanded, setExpanded] = useState(false);
  const toolArgs = call?.arguments ?? args;
  const presentation = toolPresentation(toolName, toolArgs, result);
  const verification = toolName === 'task_verify';
  const verificationData =
    result && typeof result === 'object'
      ? (result.data as
          { checks?: Array<{ requirement: string; status: string; detail: string }> } | undefined)
      : undefined;
  const checks =
    verification && Array.isArray(verificationData?.checks)
      ? verificationData.checks.filter(
          (c) => c && typeof c.requirement === 'string' && typeof c.detail === 'string',
        )
      : [];

  const derivedStatus =
    status ??
    (typeof result === 'object' && result
      ? result.success
        ? 'success'
        : 'error'
      : result
        ? 'success'
        : 'running');

  const statusLabel = presentation.cancelled ? wt('已停止') : presentation.rejected ? wt('已拒绝') : derivedStatus === 'error' ? wt('失败') : derivedStatus === 'pending' ? wt('待执行') : '';
  const statusBadge = derivedStatus === 'running'
    ? <span className="tool-running-dot" aria-label={wt('运行中')} />
    : statusLabel ? <span className={derivedStatus === 'error' && !presentation.cancelled && !presentation.rejected ? 'tool-state-error' : 'tool-state-muted'}>{statusLabel}</span> : null;

  let resultText: string | null = null;
  let diffText: string | null = null;
  let warningText = '';
  let planItems: Array<{ id: string; text: string; done: boolean }> | null = null;
  if (typeof result === 'string') {
    resultText = result;
  } else if (result && typeof result === 'object') {
    const r = result as ToolResult & {
      data?: { diff?: string; items?: Array<{ id: string; text: string; done: boolean }> };
    };
    const details = r.data as Record<string, unknown> | undefined;
    warningText = Array.isArray(details?.['warnings']) ? details['warnings'].filter(v => typeof v === 'string').join('\n') : '';
    const execution = details && ('exitCode' in details || details['timedOut'] || details['cancelled'])
      ? [details['timedOut'] ? '执行超时' : '', details['cancelled'] ? '已取消' : '',
          details['exitCode'] != null ? `退出码：${details['exitCode']}` : '',
          typeof details['errorCode'] === 'string' ? details['errorCode'] : ''].filter(Boolean).join(' · ')
      : '';
    resultText = [r.error, execution, r.output].filter(Boolean).join('\n')
      || (!checks.length && r.data ? prettyJson(JSON.stringify(r.data)) : null);
    // file-write 附带的差异块：IDE 风格 -/+ 行渲染（AI 改文件可视化对比）
    if (
      r.data &&
      typeof r.data === 'object' &&
      typeof (r.data as { diff?: unknown }).diff === 'string'
    ) {
      diffText = (r.data as { diff: string }).diff;
    }
    // G Plan 卡：todo 工具的清单渲染成计划卡（复选框样式，实时反映拆解与完成进度）
    if (toolName === 'todo' && r.data && typeof r.data === 'object') {
      const items = (r.data as { items?: unknown }).items;
      if (Array.isArray(items) && items.length > 0) {
        planItems = items.filter(
          (it): it is { id: string; text: string; done: boolean } =>
            !!it && typeof it === 'object' && typeof (it as { text?: unknown }).text === 'string',
        );
      }
    }
  }

  return (
    <div className={`tool-call${expanded ? '' : ' tool-call-collapsed'}`}>
      <div className="tool-call-head">
        <span
          className="tool-call-name"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          onClick={() => setExpanded((v) => !v)}
          style={{ cursor: 'pointer' }}
        >
          <Icon name={presentation.path ? 'file' : 'tool'} size={14} />
          <span className="tool-call-title">{verification ? wt('任务验收') : wt(presentation.title)}</span>
          {presentation.target && <span className="tool-call-target" title={presentation.target}>{presentation.target}</span>}
          {(presentation.added > 0 || presentation.removed > 0) && <span className="tool-diff-count"><span>+{presentation.added}</span> <span>−{presentation.removed}</span></span>}
          <span className="tool-row-chevron">{expanded ? '⌄' : '›'}</span>
        </span>
        {statusBadge}
      </div>
      {expanded ? (
        <>
          {!verification && toolArgs !== undefined && toolArgs !== null ? (
            <JsonBlock data={toolArgs} />
          ) : null}
          {checks.length > 0 && (
            <ul className="space-y-2 p-3 text-sm">
              {checks.map((check, i) => (
                <li key={i}>
                  <strong>
                    {check.status === 'passed' ? '✓' : check.status === 'blocked' ? '○' : '×'}{' '}
                    {check.requirement}
                  </strong>
                  <p>{check.detail}</p>
                </li>
              ))}
            </ul>
          )}
          {planItems ? (
            <div
              className="rounded"
              style={{ background: 'var(--bg-secondary, #0f172a)', padding: 8, margin: '4px 0' }}
            >
              <div className="text-xs font-medium mb-1" style={{ color: 'var(--accent, #38bdf8)' }}>
                {wt('执行计划（')}
                {planItems.filter((p) => p.done).length}/{planItems.length}）
              </div>
              {planItems.map((p) => (
                <div key={p.id} className="flex items-start gap-1.5 text-xs py-0.5">
                  <span
                    className="shrink-0 mt-0.5 rounded-sm"
                    style={{
                      width: 12,
                      height: 12,
                      border: '1px solid ' + (p.done ? '#4ade80' : 'var(--text-muted)'),
                      background: p.done ? '#4ade80' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#052e16',
                      fontSize: uiFontSize(9),
                      lineHeight: 1,
                    }}
                  >
                    {p.done ? '✓' : ''}
                  </span>
                  <span
                    style={{
                      textDecoration: p.done ? 'line-through' : 'none',
                      color: p.done ? 'var(--text-muted)' : 'var(--text-primary)',
                    }}
                  >
                    {p.text}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {diffText ? (
            <pre
              className="font-mono text-xs rounded"
              style={{
                background: 'var(--bg-secondary, #0f172a)',
                padding: 8,
                margin: '4px 0',
                maxHeight: 260,
                overflow: 'auto',
                whiteSpace: 'pre',
              }}
            >
              {diffText.split('\n').map((line, i) => (
                <div
                  key={i}
                  style={{
                    color: line.startsWith('+')
                      ? '#4ade80'
                      : line.startsWith('-')
                        ? '#f87171'
                        : 'var(--text-muted)',
                  }}
                >
                  {line}
                </div>
              ))}
            </pre>
          ) : null}
          {warningText ? <div className="tool-call-result" style={{color:'var(--text-muted)'}}>附加记录提示：{warningText}</div> : null}
          {resultText ? (
            <div className={`tool-call-result ${derivedStatus === 'error' ? 'error' : 'success'}`}>
              {resultText}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
