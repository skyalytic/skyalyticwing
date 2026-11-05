import { shortcutText } from '@/utils/shortcuts';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 命令面板组件：Portal 渲染，全局可用
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import { useCommandPalette } from '@/hooks/use-command-palette';

export function CommandPalette() {
  useWorkbenchLanguage();
  const {
    isOpen,
    query,
    selectedIndex,
    filteredCommands,
    close,
    setQuery,
    setSelectedIndex,
    executeCommand,
  } = useCommandPalette();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时自动聚焦输入框
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  // 选中项滚动到可视区
  useEffect(() => {
    if (isOpen && listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>('[data-palette-active="true"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="palette-container" onMouseDown={(e) => e.stopPropagation()}>
        {/* 搜索输入区 */}
        <div className="palette-input-wrap">
          <span className="palette-input-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder={wt('搜索命令...')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          <kbd className="palette-esc-hint">ESC</kbd>
        </div>

        {/* 命令列表 */}
        <div className="palette-list scrollbar-thin" ref={listRef}>
          {filteredCommands.length === 0 ? (
            <div className="palette-empty">{wt('无匹配命令')}</div>
          ) : (
            filteredCommands.map((cmd, i) => (
              <div
                key={cmd.id}
                className={`palette-item${i === selectedIndex ? ' active' : ''}`}
                data-palette-active={i === selectedIndex ? 'true' : 'false'}
                data-palette-idx={i}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => executeCommand(cmd)}
              >
                <span className="palette-item-icon">
                  <Icon name={cmd.icon} size={18} />
                </span>
                <span className="palette-item-text">
                  <span className="palette-item-label">{cmd.label}</span>
                  {cmd.description && <span className="palette-item-desc">{cmd.description}</span>}
                </span>
                {cmd.shortcut && <span className="palette-shortcut">{shortcutText(cmd.shortcut)}</span>}
              </div>
            ))
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="palette-footer">
          <span className="palette-footer-item">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <span>{wt('切换')}</span>
          </span>
          <span className="palette-footer-item">
            <kbd>Enter</kbd>
            <span>{wt('执行')}</span>
          </span>
          <span className="palette-footer-item">
            <kbd>Esc</kbd>
            <span>{wt('关闭')}</span>
          </span>
          <span className="palette-footer-item palette-footer-tip">
            <kbd>{shortcutText('Ctrl')}</kbd>
            <kbd>K</kbd>
            <span>{wt('切换面板')}</span>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
