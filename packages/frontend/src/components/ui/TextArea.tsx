// 文本域
import type { TextareaHTMLAttributes, ReactNode } from 'react';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
}

export function TextArea({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: TextAreaProps) {
  const inputId = id ?? rest.name;
  return (
    <div className="input-group">
      {label ? (
        <label className="input-label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <textarea
        id={inputId}
        className={`textarea ${className ?? ''}`.trim()}
        {...rest}
      />
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
      {error ? <span className="text-sm text-danger">{error}</span> : null}
    </div>
  );
}
