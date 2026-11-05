// 徽章
import type { ReactNode } from 'react';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  const classes = [
    'badge',
    variant !== 'default' ? `badge-${variant}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <span className={classes}>{children}</span>;
}
