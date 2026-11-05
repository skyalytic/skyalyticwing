import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '../src/components/workspace/EditorView';
import { useProjectPanel } from '../src/stores/project-panel-store';
import { apiClient } from '../src/services/api-client';
import { registerFileCloseGuard } from '../src/components/project/file-tab-lifecycle';

vi.mock('../src/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('../src/components/project/CodeEditor', () => ({ CodeEditor: ({ value, onChange }: any) => <textarea aria-label="文件内容" value={value} onChange={e => onChange(e.target.value)} /> }));
const root = 'E:/project';
let entries: Array<{name: string; type: string}>;
beforeEach(() => {
  vi.clearAllMocks();
  entries = [{ name: '子目录', type: 'dir' }, { name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }];
  useProjectPanel.setState({ projectDir: root, currentFile: '', openFiles: [], treeVersion: 0, initialized: true });
  vi.mocked(apiClient.get).mockImplementation(async url => {
    if (url.startsWith('/files/list')) return decodeURIComponent(url).endsWith(root) ? entries : [];
    if (url.startsWith('/files/read')) return { content: url.includes('a.txt') ? 'alpha' : 'beta', size: 5, revision: 'r1' };
    return {};
  });
  vi.mocked(apiClient.post).mockImplementation(async (url, body: any) => {
    if (url === '/files/create-entry') { entries = [...entries, { name: body.name, type: body.type }]; return { path: `${body.directory}/${body.name}` }; }
    return { revision: 'r2' };
  });
});

describe('project files workspace', () => {
  it('deduplicates Windows paths from file trees and chat attachments', () => {
    useProjectPanel.getState().openFile('E:\\Project\\同一文件.txt');
    useProjectPanel.getState().openFile('e:/project/同一文件.txt');
    expect(useProjectPanel.getState().openFiles).toEqual(['E:\\Project\\同一文件.txt']);
    expect(useProjectPanel.getState().currentFile).toBe('E:\\Project\\同一文件.txt');
  });
  it('offers folder reveal and opening on both child and root right-click menus', async () => {
    render(<EditorView />);
    fireEvent.contextMenu(await screen.findByText('子目录'));
    fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/files/local-action', { path: root + '/子目录', action: 'reveal' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    fireEvent.contextMenu(screen.getByText('project', { selector: '.font-medium' }));
    fireEvent.click(screen.getByRole('button', { name: '打开此文件夹' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/files/local-action', { path: root, action: 'open' }));
  });
  it('creates a file from the toolbar, refreshes the tree, and opens its tab', async () => {
    render(<EditorView />);
    fireEvent.click(await screen.findByRole('button', { name: '新建文件', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '新文件.txt' } });
    fireEvent.click(screen.getByRole('button', { name: '创建', exact: true }));
    expect(await screen.findByRole('tab', { name: '新文件.txt' })).toHaveAttribute('aria-selected', 'true');
    expect(apiClient.post).toHaveBeenCalledWith('/files/create-entry', { directory: root, name: '新文件.txt', type: 'file' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('creates within the selected subfolder and keeps duplicate-name failures editable', async () => {
    render(<EditorView />);
    fireEvent.contextMenu(await screen.findByText('子目录'));
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }));
    vi.mocked(apiClient.post).mockRejectedValueOnce(Error('已存在同名文件或文件夹'));
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '嵌套' } });
    fireEvent.click(screen.getByRole('button', { name: '创建', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已存在');
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('嵌套');
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '新的嵌套' } });
    fireEvent.click(screen.getByRole('button', { name: '创建', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiClient.post).toHaveBeenLastCalledWith('/files/create-entry', { directory: root + '/子目录', name: '新的嵌套', type: 'dir' });
  });
  it('keeps real editor drafts mounted across tabs and saves before closing', async () => {
    render(<EditorView />);
    fireEvent.click(await screen.findByText('a.txt'));
    const a = await screen.findByRole('textbox', { name: '文件内容' });
    fireEvent.change(a, { target: { value: 'edited alpha' } });
    fireEvent.click(screen.getByText('b.txt'));
    expect(await screen.findByRole('tab', { name: 'b.txt' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'a.txt' }));
    expect(screen.getByRole('textbox', { name: '文件内容' })).toBe(a);
    expect(a).toHaveValue('edited alpha');
    fireEvent.click(screen.getByRole('button', { name: '关闭文件 a.txt' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'a.txt' })).not.toBeInTheDocument());
    expect(apiClient.post).toHaveBeenCalledWith('/files/write', { path: root + '/a.txt', content: 'edited alpha', revision: 'r1' });
    expect(screen.getByRole('tab', { name: 'b.txt' })).toHaveAttribute('aria-selected', 'true');
  });
  it('keeps a tab open when saving fails and supports keyboard tab switching', async () => {
    render(<EditorView />);
    await screen.findByText('a.txt');
    act(() => { useProjectPanel.getState().openFile(root + '/a.txt'); useProjectPanel.getState().openFile(root + '/b.txt'); });
    const unregister = registerFileCloseGuard(root + '/b.txt', async () => { throw Error('保存冲突'); });
    fireEvent.click(screen.getByRole('button', { name: '关闭文件 b.txt' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭文件 b.txt' })).toBeEnabled());
    expect(useProjectPanel.getState().openFiles).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'b.txt' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'a.txt' })).toHaveAttribute('aria-selected', 'true');
    unregister();
  });
  it('uses the Office generator rather than creating a zero-byte docx', async () => {
    render(<EditorView />);
    fireEvent.click(screen.getByRole('button', { name: '新建文件', exact: true }));
    vi.mocked(apiClient.post).mockResolvedValueOnce({ path: root + '/计划.docx' });
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '计划.docx' } });
    fireEvent.click(screen.getByRole('button', { name: '创建', exact: true }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/files/office/create', { directory: root, name: '计划', format: 'docx', template: 'blank' }));
  });
});
