import { primaryModifier, composingKey } from '@/utils/shortcuts';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 程序化输入弹窗（支持单行/多行），返回 Promise<string | null>
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Modal } from '../ui/Modal';

export interface InputPromptOptions {
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
}

export interface InputPromptModalProps extends InputPromptOptions {
  open: boolean;
  onResolve: (value: string | null) => void;
}

/** 声明式输入弹窗组件 */
export function InputPromptModal({
  title = wt('输入'),
  message,
  placeholder,
  defaultValue = '',
  multiline = false,
  open,
  onResolve,
}: InputPromptModalProps) {
  useWorkbenchLanguage();
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolve(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onResolve]);

  const submit = () => onResolve(value);

  return (
    <Modal
      open={open}
      title={title}
      onClose={() => onResolve(null)}
      width={450}
      footer={
        <>
          <button className="btn-secondary text-sm" onClick={() => onResolve(null)}>
            {wt('取消')}
          </button>
          <button className="btn-primary text-sm" onClick={submit}>
            {wt('确定')}
          </button>
        </>
      }
    >
      {message ? <p className="text-sm text-gray-400 mb-3">{message}</p> : null}
      {multiline ? (
        <textarea
          className="input-field w-full"
          rows={5}
          value={value}
          autoFocus
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (!composingKey(e.nativeEvent) && e.key === 'Enter' && primaryModifier(e)) { e.preventDefault(); submit(); }
          }}
        />
      ) : (
        <input
          type="text"
          className="input-field w-full"
          value={value}
          autoFocus
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (!composingKey(e.nativeEvent) && e.key === 'Enter') submit();
          }}
        />
      )}
    </Modal>
  );
}

/**
 * 命令式输入弹窗。
 * @returns Promise<string | null> —— 字符串为用户输入，null 表示取消
 *
 * 用法：const v = await showInputPrompt({ title: '重命名', multiline: false });
 */
export function showInputPrompt(options?: InputPromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(
      <InputPromptModal
        open
        title={options?.title}
        message={options?.message}
        placeholder={options?.placeholder}
        defaultValue={options?.defaultValue}
        multiline={options?.multiline}
        onResolve={done}
      />,
    );
  });
}

export default InputPromptModal;
