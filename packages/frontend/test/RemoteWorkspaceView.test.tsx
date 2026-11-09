import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteWorkspaceView,
  RemoteWorkspacePicker,
  type RemoteWorkspace,
} from '@/components/workspace/RemoteWorkspaceView';
import { useSessionStore } from '@/stores/session-store';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
import { apiClient } from '@/services/api-client';
import i18n from '@/i18n';
vi.mock('@/services/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/components/project/OfficeEditor', () => ({
  OfficeEditor: ({ filePath, remoteWorkspaceId }: any) => (
    <div data-testid="remote-canvas" data-workspace={remoteWorkspaceId}>
      {filePath}
    </div>
  ),
}));
vi.mock('@/stores/project-panel-store', () => ({ useProjectPanel: { getState: vi.fn() } }));
vi.mock('@/stores/session-store', () => ({ useSessionStore: { getState: vi.fn() } }));
vi.mock('@/stores/workspace-tab-store', () => ({ useWorkspaceTabs: { getState: vi.fn() } }));
let next = 0;
const fixture = (): RemoteWorkspace => ({
  id: 'remote-ui-' + ++next,
  name: 'Fixture',
  transport: 'ssh',
  target: 'fixture.invalid',
  root: '/work',
});
const post = vi.mocked(apiClient.post);
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});
it.each(['ssh', 'wsl', 'docker'])(
  'creates and binds a %s workspace using the selected transport',
  async (transport) => {
    const workspace = { ...fixture(), transport };
    vi.mocked(apiClient.get).mockResolvedValue({ workspaces: [] });
    post.mockImplementation(async (url) =>
      url === '/remote-workspaces' ? workspace : { bound: workspace.id },
    );
    vi.mocked(useSessionStore.getState).mockReturnValue({ currentSessionId: 'session' } as any);
    vi.mocked(useProjectPanel.getState).mockReturnValue({
      initProjectDir: vi.fn().mockResolvedValue(undefined),
    } as any);
    const openTab = vi.fn(),
      close = vi.fn();
    vi.mocked(useWorkspaceTabs.getState).mockReturnValue({ openTab } as any);
    render(<RemoteWorkspacePicker close={close} />);
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Remote' } });
    fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: transport } });
    fireEvent.change(screen.getByLabelText('远程目标'), { target: { value: 'worker' } });
    fireEvent.change(screen.getByLabelText('远程项目路径'), { target: { value: '/work' } });
    fireEvent.click(screen.getByRole('button', { name: '连接', exact: true }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/remote-workspaces', {
      name: 'Remote',
      transport,
      target: 'worker',
      root: '/work',
      port: transport === 'ssh' ? 22 : undefined,
    });
    expect(post).toHaveBeenCalledWith('/remote-workspaces/bind', {
      sessionId: 'session',
      id: workspace.id,
    });
    expect(openTab).toHaveBeenCalledWith('editor');
  },
);
afterEach(cleanup);
describe('remote workspace editing and review', () => {
  it('opens Office in the document editor and PDF at the remote endpoint without text reads', async () => {
    const workspace = fixture();
    post.mockImplementation(async (_url, body: any) => {
      if (body.op === 'list')
        return {
          entries: [
            { path: '/work/book.docx', name: 'book.docx' },
            { path: '/work/file.pdf', name: 'file.pdf' },
          ],
        };
      if (body.op === 'office-read')
        return {
          format: 'docx',
          revision: 'r1',
          sections: [{ name: '正文', fields: [{ id: 'p:0', value: '远程文档' }] }],
        };
      throw Error('Unexpected operation');
    });
    render(<RemoteWorkspaceView workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'book.docx' }));
    expect(await screen.findByTestId('remote-canvas')).toHaveTextContent('/work/book.docx');
    expect(screen.getByTestId('remote-canvas')).toHaveAttribute('data-workspace', workspace.id);
    await waitFor(() => expect(screen.getByRole('button', { name: 'file.pdf' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'file.pdf' }));
    await waitFor(() =>
      expect(document.querySelector('iframe[title="/work/file.pdf"]')).toHaveAttribute(
        'src',
        '/api/remote-workspaces/' + workspace.id + '/document?inline=1&path=%2Fwork%2Ffile.pdf',
      ),
    );
    expect(post.mock.calls.some(([, body]: any) => body.op === 'read')).toBe(false);
  });
  it('keeps drafts when switching files, creating the same name and remounting the editor', async () => {
    const workspace = fixture();
    post.mockImplementation(async (_url, body: any) => {
      if (body.op === 'list')
        return {
          entries: [
            { path: '/work/a', name: 'a' },
            { path: '/work/b', name: 'b' },
          ],
        };
      if (body.op === 'read') return { content: body.args.path, revision: 'r1' };
      if (body.op === 'write') return { revision: 'r2' };
      throw Error('Unexpected operation');
    });
    const view = render(<RemoteWorkspaceView workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'a', exact: true }));
    fireEvent.change(await screen.findByLabelText('远程文件内容'), {
      target: { value: 'my draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'b', exact: true }));
    await waitFor(() => expect(screen.getByLabelText('远程文件内容')).toHaveValue('/work/b'));
    fireEvent.click(screen.getByRole('button', { name: 'a', exact: true }));
    await waitFor(() => expect(screen.getByLabelText('远程文件内容')).toHaveValue('my draft'));
    fireEvent.change(screen.getByLabelText('新文件路径'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: '新建', exact: true }));
    expect(screen.getByLabelText('远程文件内容')).toHaveValue('my draft');
    view.unmount();
    render(<RemoteWorkspaceView workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'a', exact: true }));
    expect(await screen.findByLabelText('远程文件内容')).toHaveValue('my draft');
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/remote-workspaces/' + workspace.id + '/operation', {
        op: 'write',
        args: { path: '/work/a', content: 'my draft', revision: 'r1' },
      }),
    );
  });
  it('keeps failed-save content and its original revision, allowing retry without overwriting external edits', async () => {
    const workspace = fixture();
    let fail = true;
    post.mockImplementation(async (_url, body: any) => {
      if (body.op === 'list') return { entries: [{ path: '/work/a', name: 'a' }] };
      if (body.op === 'read')
        return {
          content: fail ? 'original' : 'external edit',
          revision: fail ? 'r1' : 'external-revision',
        };
      if (body.op === 'write') {
        if (fail) throw Error('File changed; reload before saving');
        return { revision: 'r2' };
      }
      throw Error('Unexpected operation');
    });
    render(<RemoteWorkspaceView workspace={workspace} />);
    fireEvent.click(await screen.findByRole('button', { name: 'a', exact: true }));
    fireEvent.change(await screen.findByLabelText('远程文件内容'), {
      target: { value: 'new content' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('File changed');
    expect(screen.getByLabelText('远程文件内容')).toHaveValue('new content');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '撤销未保存修改' }));
    await waitFor(() => expect(screen.getByLabelText('远程文件内容')).toHaveValue('external edit'));
    fireEvent.change(screen.getByLabelText('远程文件内容'), { target: { value: 'merged edit' } });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '撤销未保存修改' })).toBeDisabled(),
    );
    expect(
      post.mock.calls
        .filter(([, body]: any) => body.op === 'write')
        .map(([, body]: any) => body.args.revision),
    ).toEqual(['r1', 'external-revision']);
  });
  it('binds stage and revert actions to the displayed file revision and HEAD', async () => {
    const workspace = fixture();
    post.mockImplementation(async (_url, body: any) => {
      if (body.op === 'git-status') return { entries: [{ path: 'a', status: 'M ' }] };
      if (body.op === 'git-diff') return { stdout: '+new', revision: 'r2', head: 'abc123' };
      if (body.op === 'git-revert') throw Error('File changed; refresh before reverting');
      return {};
    });
    render(<RemoteWorkspaceView workspace={workspace} changes />);
    fireEvent.click(await screen.findByRole('button', { name: 'M a' }));
    fireEvent.click(await screen.findByRole('button', { name: '暂存' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '还原到 HEAD' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '还原到 HEAD' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('File changed');
    expect(post).toHaveBeenCalledWith('/remote-workspaces/' + workspace.id + '/operation', {
      op: 'git-revert',
      args: { path: 'a', revision: 'r2', head: 'abc123' },
    });
    expect(post.mock.calls.every(([url]) => String(url).startsWith('/remote-workspaces/'))).toBe(
      true,
    );
  });
});
