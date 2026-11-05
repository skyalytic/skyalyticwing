// 加载动画
import type { CSSProperties } from 'react';

export interface SpinnerProps {
  size?: 'sm' | 'lg';
  className?: string;
  style?: CSSProperties;
}

export function Spinner({ size = 'sm', className, style }: SpinnerProps) {
  const classes = ['spinner', size === 'lg' ? 'spinner-lg' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <span className={classes} style={style} aria-label="loading" />;
}

export function SpinnerWrap({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <Spinner size="lg" />
      {label ? <span style={{ marginLeft: 8 }}>{label}</span> : null}
    </div>
  );
}
