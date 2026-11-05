import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Modal } from '@/components/ui/Modal';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useProjectPanel } from '@/stores/project-panel-store';
import { attachmentText, readContextReference } from '@/services/context-reference';
import { browserAnnotationPreview } from '@/services/browser-annotation';
import type { Attachment } from '@/types';
import './browser-annotation-chip.css';
export function ContextReferenceChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: () => void;
}) {
  useWorkbenchLanguage();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    body = useRef<HTMLDivElement>(null);
  const ref = readContextReference(attachment),
    legacy = attachmentText(attachment);
  const browser = ref ? null : browserAnnotationPreview(legacy);
  const lineRange =
    ref?.startLine !== undefined ? `${ref.startLine}–${ref.endLine ?? ref.startLine}` : '';
  const displayName = lineRange && ref?.path ? ref.path.split(/[\\/]/).pop() : attachment.name;
  const icon =
    ref?.kind === 'folder'
      ? 'folder'
      : ref?.kind === 'chat'
        ? 'chat'
        : ref?.kind === 'skill'
          ? 'skill'
          : ref?.kind === 'plugin'
            ? 'plugin'
            : ref
              ? 'file'
              : attachment.name?.startsWith('Office')
                ? 'doc'
                : attachment.name?.startsWith('画布')
                  ? 'frame'
                  : 'globe';
  const removeLabel = ref
    ? wt('移除引用')
    : wt(
        attachment.name?.startsWith('画布')
          ? '移除画布元素'
          : attachment.name?.startsWith('Office')
            ? '移除 Office 选区'
            : '移除网页批注',
      );
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const modal = body.current?.closest<HTMLElement>('[role="dialog"]');
    modal?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !modal) return;
      const buttons = [
        ...modal.querySelectorAll<HTMLElement>('button,[href],input,[tabindex="0"]'),
      ];
      const first = buttons[0],
        last = buttons.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    modal?.addEventListener('keydown', trap);
    return () => modal?.removeEventListener('keydown', trap);
  }, [open]);
  return (
    <>
      <span className="sky-browser-annotation-chip" title={ref?.path || attachment.name}>
        <button
          ref={trigger}
          type="button"
          className="wing-context-open"
          aria-label={wt('查看引用：{{name}}', { name: attachment.name || '' })}
          onClick={() => setOpen(true)}
        >
          <Icon name={icon} size={13} />
          <span className="wing-context-label">{displayName}</span>
          {lineRange && <span className="wing-context-range">{lineRange}</span>}
        </button>
        {onRemove && (
          <button type="button" aria-label={removeLabel} onClick={onRemove}>
            ×
          </button>
        )}
      </span>
      <Modal open={open} title={attachment.name} onClose={close} width={640}>
        <div ref={body} className="wing-context-detail">
          {browser?.url && <p className="wing-context-source">{browser.url}</p>}
          {ref?.path && <p className="wing-context-source">{ref.path}</p>}
          {ref?.startLine !== undefined && (
            <p>
              {ref.segmentOffset !== undefined ? wt('当前分段 · ') : ''}
              {wt('第 {{start}}–{{end}} 行', {
                start: ref.startLine,
                end: ref.endLine || ref.startLine,
              })}
              {ref.segmentOffset !== undefined
                ? ` · ${wt('分段起始字节')} ${ref.segmentOffset}`
                : ''}
            </p>
          )}
          <pre tabIndex={0}>
            {ref
              ? ref.content || ref.instruction || wt('发送后，AI 会按此路径读取引用内容。')
              : browser?.html || legacy || wt('引用内容不可读')}
          </pre>
          {ref?.truncated && (
            <p role="status">{wt('内容较长，此处为摘录；完整内容请打开来源查看。')}</p>
          )}
          {ref?.path && ['file', 'selection', 'rule'].includes(ref.kind) && (
            <button
              className="btn-secondary"
              onClick={() => {
                useProjectPanel.getState().openFile(ref.path!);
                close();
              }}
            >
              {wt('打开来源')}
            </button>
          )}
        </div>
      </Modal>
    </>
  );
}
