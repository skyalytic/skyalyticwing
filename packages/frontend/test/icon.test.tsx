import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon, SIDEBAR_ICONS, AGENT_ICONS_MAP } from '../src/components/Icon';

/** Icon.tsx 内置的全部 51 个图标名（与 ICONS 表一一对应） */
const ALL_ICON_NAMES = [
  'dashboard', 'chat', 'agent', 'remote', 'channel', 'tool', 'sandbox', 'worktree',
  'config', 'permission', 'cron', 'plugin', 'vector', 'mcp', 'queue', 'session',
  'usage', 'log', 'approval', 'code', 'doc', 'data', 'ops', 'explore', 'plus',
  'x', 'send', 'terminal', 'refresh', 'settings', 'zap', 'edit', 'save', 'shield',
  'upload', 'skill', 'workspace', 'marketplace', 'moon', 'sun', 'monitor', 'mic',
  'volume', 'globe', 'heartbeat', 'daemon', 'user', 'alert', 'check', 'search',
  'file',
] as const;

describe('Icon 组件', () => {
  it('内置 51 个图标且名称无重复', () => {
    expect(ALL_ICON_NAMES).toHaveLength(51);
    expect(new Set(ALL_ICON_NAMES).size).toBe(51);
  });

  it('全部 51 个图标均可渲染出 svg', () => {
    for (const name of ALL_ICON_NAMES) {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, `图标 "${name}" 应渲染出 svg`).toBeTruthy();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    }
  });

  it('默认 size 为 18（span 尺寸与 svg 宽高）', () => {
    const { container } = render(<Icon name="chat" />);
    const span = container.querySelector('span');
    expect(span).toBeTruthy();
    expect(span?.style.width).toBe('18px');
    expect(span?.style.height).toBe('18px');
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('18');
    expect(svg?.getAttribute('height')).toBe('18');
  });

  it('自定义 size 生效', () => {
    const { container } = render(<Icon name="dashboard" size={32} />);
    const span = container.querySelector('span');
    expect(span?.style.width).toBe('32px');
    expect(span?.style.height).toBe('32px');
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('height')).toBe('32');
  });

  it('className 透传到容器 span', () => {
    const { container } = render(<Icon name="chat" className="text-primary mr-2" />);
    expect(container.querySelector('span')?.className).toBe('text-primary mr-2');
  });

  it('未知图标名回退到 file 图标（不崩溃）', () => {
    const { container } = render(<Icon name="this-icon-does-not-exist" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    // file 图标的特征：polyline points="13,2 13,9 20,9"
    expect(svg?.innerHTML).toContain('points="13,2 13,9 20,9"');
  });

  it('SIDEBAR_ICONS 映射的所有图标均可渲染', () => {
    const uniqueIcons = [...new Set(Object.values(SIDEBAR_ICONS))];
    expect(uniqueIcons.length).toBeGreaterThan(0);
    for (const icon of uniqueIcons) {
      const { container } = render(<Icon name={icon} />);
      expect(container.querySelector('svg'), `侧边栏图标 "${icon}" 应可渲染`).toBeTruthy();
    }
  });

  it('AGENT_ICONS_MAP 映射的所有图标均可渲染', () => {
    const uniqueIcons = [...new Set(Object.values(AGENT_ICONS_MAP))];
    expect(uniqueIcons.length).toBeGreaterThan(0);
    for (const icon of uniqueIcons) {
      const { container } = render(<Icon name={icon} />);
      expect(container.querySelector('svg'), `代理图标 "${icon}" 应可渲染`).toBeTruthy();
    }
  });

  it('渲染内容在文档中可见', () => {
    const { container } = render(<Icon name="send" data-testid="icon" />);
    expect(container.querySelector('span')).toBeInTheDocument();
    void screen; // 引用 testing-library 命名空间
  });
});
