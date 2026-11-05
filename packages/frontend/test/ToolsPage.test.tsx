import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolsPage } from '../src/modules/tools/ToolsPage';
import { apiClient } from '../src/services/api-client';
import { toast } from '../src/components/ui/Toast';
vi.mock('../src/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/i18n/workbench-text', () => ({ wt: (s: string) => s, useWorkbenchLanguage() {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string, options?: any) => s === 'views.toolsLoaded' ? `已加载 ${options.count} 个工具` : s }) }));
vi.mock('../src/components/ui/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../src/components/chat/MarkdownRenderer', () => ({ JsonBlock: () => null }));
vi.mock('../src/components/modals/AddToolModal', () => ({ AddToolModal: () => null }));
vi.mock('../src/modules/tools/ToolForm', () => ({ ToolForm: () => null }));

describe('unified tool list', () => {
  let rows: any[];
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [
      { name: 'file-read', description: '读取文件', category: 'file', installed: true, loaded: true },
      { name: 'file-write', description: '写入文件', category: 'file', installed: true, loaded: true },
      { name: 'powershell', description: '终端', category: 'command', installed: false, loaded: false },
    ];
    vi.mocked(apiClient.get).mockImplementation(async () => rows.map(t => ({ ...t })) as never);
    vi.mocked(apiClient.post).mockImplementation(async (url, body: any) => {
      if (url === '/tools/uninstall' || url === '/tools/install') rows = rows.map(t => t.name === body.name ? { ...t, installed: url === '/tools/install', loaded: url === '/tools/install' } : t);
      return {} as never;
    });
  });
  afterEach(cleanup);
  const row = (name: string) => within(screen.getByText(name).closest('tr')!);
  it('renders one list with an installation action on every row and counts loaded tools only', async () => {
    render(<ToolsPage />); await screen.findByText('file-read');
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.queryByRole('columnheader', { name: '状态' })).toBeNull();
    expect(screen.queryByText('已实现')).toBeNull();
    expect(screen.getByText('已加载 2 个工具')).toBeTruthy();
    expect(row('file-read').getByRole('button', { name: '卸载' })).toBeTruthy();
    expect(row('powershell').getByRole('button', { name: '安装' })).toBeTruthy();
    expect((row('powershell').getByRole('button', { name: '使用' }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiClient.get).toHaveBeenCalledWith('/tools/catalog');
    expect(apiClient.get).not.toHaveBeenCalledWith('/extensions');
  });
  it('uninstalls exactly one tool, retains its row for reinstall and leaves its sibling installed', async () => {
    render(<ToolsPage />); await screen.findByText('file-read');
    fireEvent.click(row('file-read').getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(screen.getByText('已加载 1 个工具')).toBeTruthy());
    expect(apiClient.post).toHaveBeenCalledWith('/tools/uninstall', { name: 'file-read' });
    expect(row('file-write').getByRole('button', { name: '卸载' })).toBeTruthy();
    fireEvent.click(row('file-read').getByRole('button', { name: '安装' }));
    await waitFor(() => expect(screen.getByText('已加载 2 个工具')).toBeTruthy());
    expect(apiClient.post).toHaveBeenCalledWith('/tools/install', { name: 'file-read' });
  });
  it('keeps the row installed when the server rejects removal', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('write failed'));
    render(<ToolsPage />); await screen.findByText('file-read');
    fireEvent.click(row('file-read').getByRole('button', { name: '卸载' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('操作失败', 'write failed'));
    expect(row('file-read').getByRole('button', { name: '卸载' })).toBeTruthy();
    expect(screen.getByText('已加载 2 个工具')).toBeTruthy();
  });
  it('keeps permission disabling separate from uninstall and prevents disabled tool execution', async () => {
    rows[0].disabled = true;
    render(<ToolsPage />); await screen.findByText('file-read');
    expect((row('file-read').getByRole('button', { name: '使用' }) as HTMLButtonElement).disabled).toBe(true);
    expect(row('file-read').getByRole('button', { name: '卸载' })).toBeTruthy();
    fireEvent.change(row('file-read').getByRole('combobox'), { target: { value: 'auto' } });
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/tools/permission', { toolId: 'file-read', permission: 'auto', disabled: false }));
    await waitFor(() => expect((row('file-read').getByRole('button', { name: '使用' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('rolls back a rejected permission change and prevents overlapping submissions', async () => {
    rows[0].permission = 'ask';
    let reject!: (error: Error) => void;
    vi.mocked(apiClient.post).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(<ToolsPage />); await screen.findByText('file-read');
    fireEvent.change(row('file-read').getByRole('combobox'), { target: { value: 'auto' } });
    expect((row('file-write').getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    reject(new Error('save failed'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('操作失败', 'save failed'));
    expect((row('file-read').getByRole('combobox') as HTMLSelectElement).value).toBe('ask');
    expect((row('file-write').getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);
  });
});
