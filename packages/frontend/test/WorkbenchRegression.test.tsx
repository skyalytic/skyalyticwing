import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { apiClient } from '@/services/api-client';
import { InboxPage } from '@/modules/channels/InboxPage';
import { TerminalView } from '@/components/workspace/TerminalView';
import { useChatStore } from '@/stores/chat-store';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  textarea = document.createElement('textarea'); cols=80; rows=24; callback?: (s:string)=>void;
  open(host:HTMLElement){host.append(this.textarea);this.textarea.addEventListener('input',()=>this.callback?.(this.textarea.value));}
  loadAddon(){} onData(callback:(s:string)=>void){this.callback=callback;return {dispose(){}};}
  attachCustomKeyEventHandler(){} focus(){} clear(){} dispose(){this.textarea.remove();}
  getSelection(){return '';} write(_s:string,done?:()=>void){done?.();} writeln(){}
} }));
vi.mock('@xterm/addon-fit', () => ({FitAddon: class {fit(){}}}));
const project = vi.hoisted(() => ({ projectDir: 'C:/wing-test', setPickerOpen: vi.fn() }));
vi.mock('@/stores/project-panel-store', () => ({
  useProjectPanel: (select: (s: typeof project) => unknown) => select(project),
}));
const get = vi.mocked(apiClient.get),
  post = vi.mocked(apiClient.post);
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class {observe(){} disconnect(){}});
  project.projectDir = 'C:/wing-test';
  await i18n.changeLanguage('zh-CN');
  useChatStore.setState({ toolCalls: {} });
});
afterEach(cleanup);
describe('workbench regressions', () => {
  it('asks for a project before opening a shell and keeps a running shell on project changes', async () => {
    project.projectDir = '';
    post.mockResolvedValue({ id: 'appearance-terminal', cwd: 'C:/wing-test', shell:'powershell.exe' });
    get.mockResolvedValue({ seq: 0, data: '', exited: false });
    const view = render(<TerminalView />);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '选择项目文件夹' }));
    expect(project.setPickerOpen).toHaveBeenCalledWith(true);
    project.projectDir = 'C:/wing-test'; view.rerender(<TerminalView />);
    await screen.findByRole('tab', {name: 'powershell'});
    expect(post).toHaveBeenCalledWith('/terminal/open', { cwd: 'C:/wing-test' });
    project.projectDir = 'C:/another-project'; view.rerender(<TerminalView />);
    expect(post.mock.calls.filter(([path]) => path === '/terminal/open')).toHaveLength(1);
    expect(post.mock.calls.some(([path]) => path.endsWith('/close'))).toBe(false);
  });
  it.each([{}, null, { items: [{ id: 'broken' }], drafts: [] }])(
    'malformed inbox responses show a recoverable error (%j)',
    async (value) => {
      get.mockResolvedValue(value);
      render(
        <MemoryRouter>
          <InboxPage />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('收件箱数据格式异常');
      get.mockResolvedValue({ items: [], drafts: [] });
      fireEvent.click(screen.getByRole('button', { name: '重试' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: '统一收件箱' })).toBeInTheDocument();
    },
  );
  it('switches a mounted inbox to English including its controls', async () => {
    get.mockResolvedValue({ items: [], drafts: [] });
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expect(screen.getByRole('heading', { name: 'Unified inbox' })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Search channels, contacts and messages'),
    ).toBeInTheDocument();
    expect(screen.queryByText('统一收件箱')).not.toBeInTheDocument();
  });
  it('closes a shell that finishes opening after its tab was closed', async () => {
    let finish!: (value: unknown) => void;
    post.mockImplementation((path) =>
      path === '/terminal/open'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ closed: true }),
    );
    const view = render(<TerminalView />);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/terminal/open', { cwd: 'C:/wing-test' }),
    );
    view.unmount();
    await act(async () => {
      finish({ id: 'late', cwd: 'C:/wing-test' });
    });
    expect(post).toHaveBeenCalledWith('/terminal/late/close', {});
  });
  it('shows rejected terminal input without replaying commands and separates AI results', async () => {
    get.mockResolvedValue({ seq: 0, data: '', exited: false });
    post.mockImplementation((path) =>
      path === '/terminal/open'
        ? Promise.resolve({ id: 'shell', cwd: 'C:/wing-test', shell: 'powershell.exe' })
        : path.endsWith('/input')
          ? Promise.reject(Error('offline'))
          : Promise.resolve({ closed: true }),
    );
    render(<TerminalView />);
    const input=await screen.findByLabelText('终端输入');
    fireEvent.input(input, { target: { value: 'Get-Date\r' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(post).toHaveBeenCalledWith('/terminal/shell/input',{text:'Get-Date\n',raw:true});
    act(() =>
      useChatStore.setState({
        toolCalls: {
          test: {
            toolName: 'powershell',
            args: { command: 'Write-Output proof' },
            status: 'success',
            result: { success: true, data: 'proof' },
          },
        },
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /AI 执行记录/ }));
    expect(screen.getByText(/Write-Output proof/)).toBeInTheDocument();
    expect(screen.getByText(/powershell · success/)).toBeInTheDocument();
    expect(post.mock.calls.filter(([url]) => url.endsWith('/input'))).toHaveLength(1);
  });
  it('resumes terminal output after a transient connection failure without resending input',async()=>{
    post.mockResolvedValue({id:'retry',cwd:'C:/wing-test',shell:'powershell.exe'});
    get.mockRejectedValueOnce(Error('temporary offline')).mockResolvedValue({seq:1,data:'recovered',exited:true});
    render(<TerminalView/>);
    await screen.findByText('temporary offline');
    await screen.findByText('进程已退出；点击 + 打开新终端');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(get.mock.calls.filter(([p])=>p.includes('/output'))).toHaveLength(2);
    expect(post.mock.calls.some(([p])=>p.endsWith('/input'))).toBe(false);
  });
});
