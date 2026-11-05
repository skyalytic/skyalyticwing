// 输入框
import type { InputHTMLAttributes, ReactNode } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
}

export function Input({ label, hint, error, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <div className="input-group">
      {label ? (
        <label className="input-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        className={`input ${className ?? ''}`.trim()}
        {...rest}
      />
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </div>
  );
}
