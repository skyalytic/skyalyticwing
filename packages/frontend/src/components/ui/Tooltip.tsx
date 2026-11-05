// 提示
import type { ReactNode } from 'react';
import { useState, type CSSProperties, type ReactElement } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  placement?: 'top' | 'bottom';
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  const tipStyle: CSSProperties | undefined =
    placement === 'bottom'
      ? { top: 'calc(100% + 6px)', bottom: 'auto' }
      : undefined;

  return (
    <span
      className="tooltip-wrap"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible ? (
        <span className="tooltip-content" style={tipStyle}>
          {content}
        </span>
      ) : null}
    </span>
  );
}
