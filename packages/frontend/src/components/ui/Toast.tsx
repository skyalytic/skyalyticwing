// Toast 通知：内建全局 store + 命令式 API + 容器渲染
import { create } from 'zustand';
import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { genId } from '@/utils/format';
import { DEFAULT_TOAST_DURATION } from '@/utils/constants';
import type { ToastItem, ToastLevel } from '@/types';

interface ToastStore {
  toasts: ToastItem[];
  show: (toast: Omit<ToastItem, 'id'>) => string;
  remove: (id: string) => void;
  clear: () => void;
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (toast) => {
    const id = genId('toast');
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  remove: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** 命令式 API，可在非组件代码（如 api-client）中调用 */
export const toast = {
  show: (level: ToastLevel, title: string, message?: string, duration = DEFAULT_TOAST_DURATION) =>
    useToastStore.getState().show({ level, title, message, duration }),
  info: (title: string, message?: string) =>
    toast.show('info', title, message),
  success: (title: string, message?: string) =>
    toast.show('success', title, message),
  warn: (title: string, message?: string) =>
    toast.show('warn', title, message),
  error: (title: string, message?: string) =>
    toast.show('error', title, message),
  remove: (id: string) => useToastStore.getState().remove(id),
};

export interface ToastContainerProps {
  /** 最大同时显示数量 */
  limit?: number;
}

export function ToastContainer({ limit = 5 }: ToastContainerProps) {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  const visible = toasts.slice(-limit);

  return createPortal(
    <div className="toast-container">
      {visible.map((t) => (
        <ToastCard key={t.id} toast={t} onClose={() => remove(t.id)} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ toast: t, onClose }: { toast: ToastItem; onClose: () => void }) {
  useEffect(() => {
    if (t.duration <= 0) return;
    const timer = setTimeout(onClose, t.duration);
    return () => clearTimeout(timer);
  }, [t.duration, onClose]);

  return (
    <div className={`toast ${t.level}`} onClick={onClose} role="alert">
      <div className="toast-title">{t.title}</div>
      {t.message ? <div className="toast-message">{t.message}</div> : null}
    </div>
  );
}
