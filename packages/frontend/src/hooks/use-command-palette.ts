// 命令面板 Hook：管理打开/关闭/搜索/键盘导航/命令执行
import { useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePaletteStore, type PaletteCommand } from '@/stores/palette-store';
import { useSessionStore } from '@/stores/session-store';
import { composingKey, primaryModifier } from '@/utils/shortcuts';

export interface UseCommandPaletteReturn {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  filteredCommands: PaletteCommand[];
  open: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (q: string) => void;
  setSelectedIndex: (updater: number | ((prev: number) => number)) => void;
  executeCommand: (cmd: PaletteCommand) => void;
  executeSelected: () => void;
}

export function useCommandPalette(): UseCommandPaletteReturn {
  const language = useWorkbenchLanguage();
  const isOpen = usePaletteStore((s) => s.isOpen);
  const query = usePaletteStore((s) => s.query);
  const selectedIndex = usePaletteStore((s) => s.selectedIndex);
  const commands = usePaletteStore((s) => s.commands);
  const open = usePaletteStore((s) => s.open);
  const close = usePaletteStore((s) => s.close);
  const toggle = usePaletteStore((s) => s.toggle);
  const setQuery = usePaletteStore((s) => s.setQuery);
  const setSelectedIndex = usePaletteStore((s) => s.setSelectedIndex);

  const navigate = useNavigate();

  // 模糊过滤：按标题/描述匹配（不截断，与旧版一致，由列表容器滚动）
  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.description ? c.description.toLowerCase().includes(q) : false),
    );
  }, [commands, query, language]);

  // 执行单条命令
  const executeCommand = useCallback(
    (cmd: PaletteCommand) => {
      if (cmd.action === 'new-session') {
        navigate('/');
        // 通过 store 直接触发新建会话（绕过 React 作用域）
        void useSessionStore.getState().createSession();
      } else if (cmd.path) {
        navigate(cmd.path);
      }
      close();
    },
    [navigate, close],
  );

  const executeSelected = useCallback(() => {
    const cmd = filteredCommands[selectedIndex];
    if (cmd) executeCommand(cmd);
  }, [filteredCommands, selectedIndex, executeCommand]);

  // 全局快捷键：Ctrl+K 切换面板（对齐旧版 palette.js）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || composingKey(e) || e.repeat ||
          (e.target instanceof Element && e.target.closest('.xterm'))) return;
      if (primaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggle();
      } else if (primaryModifier(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        const command = commands.find(c => c.action === 'new-session');
        if (command) { e.preventDefault(); executeCommand(command); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle, commands, executeCommand]);

  // 面板内键盘导航：↑/↓ 切换、Enter 执行、Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (composingKey(e)) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        executeSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, filteredCommands.length, setSelectedIndex, executeSelected, close]);

  return {
    isOpen,
    query,
    selectedIndex,
    filteredCommands,
    open,
    close,
    toggle,
    setQuery,
    setSelectedIndex,
    executeCommand,
    executeSelected,
  };
}
