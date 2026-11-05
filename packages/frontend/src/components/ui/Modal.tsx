import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 模态框
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  closeOnOverlay?: boolean;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
  closeOnOverlay = true,
}: ModalProps) {
  useWorkbenchLanguage();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const overlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (closeOnOverlay && e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className="modal-overlay" onMouseDown={overlayClick}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        {title ? (
          <div className="modal-header">
            <div className="modal-title">{title}</div>
            <button className="modal-close" onClick={onClose} aria-label={wt('关闭')}>
              ×
            </button>
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
