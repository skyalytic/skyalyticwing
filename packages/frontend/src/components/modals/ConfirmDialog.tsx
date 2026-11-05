import { uiFontSize } from '@/utils/typography';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 深色主题样式化确认对话框（替代浏览器原生 confirm）
// 提供：声明式 <ConfirmDialog/> 组件 + 命令式 showConfirm() (Promise<boolean>)
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Icon } from '../Icon';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作时确定按钮为红色 */
  danger?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onResolve: (ok: boolean) => void;
}

/** 声明式确认对话框组件 */
export function ConfirmDialog({
  title = wt('确认操作'),
  message,
  confirmText = wt('确定'),
  cancelText = wt('取消'),
  danger = true,
  open,
  onResolve,
}: ConfirmDialogProps) {
  useWorkbenchLanguage();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(false);
      if (e.key === 'Enter') onResolve(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onResolve]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onResolve(false);
      }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true">
        <div className="flex items-center gap-2 mb-4">
          <span style={{ color: danger ? 'var(--error)' : 'var(--accent)' }}>
            <Icon name={danger ? 'alert' : 'shield'} size={20} />
          </span>
          <h3
            style={{
              fontSize: uiFontSize(16),
              fontWeight: 600,
              color: danger ? 'var(--error)' : 'var(--text-primary)',
            }}
          >
            {title}
          </h3>
        </div>
        <div
          style={{
            fontSize: uiFontSize(14),
            lineHeight: 1.6,
            color: 'var(--text-secondary)',
            marginBottom: 20,
          }}
        >
          {message}
        </div>
        <div className="flex gap-3 justify-end">
          <button className="btn-secondary text-sm" onClick={() => onResolve(false)}>
            {cancelText}
          </button>
          <button
            className="btn-primary text-sm"
            style={danger ? { background: '#dc2626', borderColor: '#dc2626' } : undefined}
            onClick={() => onResolve(true)}
            autoFocus
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 命令式确认弹窗，替代原生 confirm()。
 * @returns Promise<boolean> —— true 表示用户确认，false 表示取消
 *
 * 用法：const ok = await showConfirm('确定删除？'); if (!ok) return;
 */
export function showConfirm(
  message: string,
  options?: Omit<ConfirmOptions, 'message'>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(
      <ConfirmDialog
        open
        message={message}
        title={options?.title}
        confirmText={options?.confirmText}
        cancelText={options?.cancelText}
        danger={options?.danger ?? true}
        onResolve={done}
      />,
    );
  });
}

export default ConfirmDialog;
