import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { BrowserDownloads } from '@/components/browser/BrowserDownloads';
import { BrowserPanel } from '@/components/browser/BrowserPanel';
import { useBrowserPanel } from '@/stores/browser-store';
import { nativeBrowser } from '@/services/native-browser';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/services/native-browser', () => ({ nativeAvailable: () => true, nativeBrowser: vi.fn(), nativeInvoke: vi.fn().mockResolvedValue({}) }));
const initial = useBrowserPanel.getState();
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(nativeBrowser).mockResolvedValue({});
  useBrowserPanel.setState({ ...initial, downloads: [
    { id: 'done', name: 'report.pdf', status: 'ready', path: 'C:/Downloads/report.pdf', bytes: 1048576, created_at: 1793025600000 },
    { id: 'busy', name: 'Wing.exe', status: 'pending' },
    { id: 'failed', name: 'notes.zip', status: 'failed' },
  ] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it('searches records, reports real states and never invents a download percentage', () => {
  render(<BrowserDownloads onClose={() => {}} />);
  expect(screen.getByText(/1.0 MB/)).toBeVisible();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText('文件总大小未知')).toBeVisible();
  expect(screen.queryByLabelText('删除下载记录：Wing.exe')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'REPORT' } });
  expect(screen.getByText('report.pdf')).toBeVisible(); expect(screen.queryByText('Wing.exe')).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'none' } });
  expect(screen.getByText('没有匹配的下载记录')).toBeVisible();
});
it('shows received bytes and determinate progress, then removes progress on completion or interruption', () => {
  useBrowserPanel.setState({downloads: [{id: 'real', name: 'actual.zip', status: 'pending', bytes: 1048576, total_bytes: 4194304}]});
  render(<BrowserDownloads onClose={() => {}} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  expect(screen.getByText(/1.0 MB \/ 4.0 MB/)).toHaveTextContent('25%');
  act(() => useBrowserPanel.setState({downloads: [{id: 'real', name: 'actual.zip', status: 'ready', bytes: 4194304, total_bytes: 4194304, path: 'C:/actual.zip'}]}));
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText(/已下载/)).toHaveTextContent('4.0 MB');
  act(() => useBrowserPanel.setState({downloads: [{id: 'real', name: 'actual.zip', status: 'failed', bytes: 1048576, error: '下载中断'}]}));
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText('下载中断')).toBeVisible();
  expect(screen.getByLabelText('删除下载记录：actual.zip')).toBeEnabled();
});
it('distinguishes received bytes from engine completion and exposes the native security prompt', async () => {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  const onClose=vi.fn();
  useBrowserPanel.setState({downloads:[{id:'verify',name:'installer.exe',status:'pending',bytes:100,total_bytes:100}]});
  render(<BrowserDownloads onClose={onClose} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow','100');
  expect(screen.getByText(/已接收文件，等待浏览器完成处理/)).toBeVisible();
  expect(screen.getByRole('button',{name:'installer.exe'})).toBeDisabled();
  fireEvent.click(screen.getByText('查看浏览器下载提示'));
  await waitFor(()=>expect(onClose).toHaveBeenCalled());
  expect(nativeBrowser).toHaveBeenCalledWith('download-dialog');
  platform.mockRestore();
});
it('deletes history through the native engine without deleting files, preserving running downloads', async () => {
  render(<BrowserDownloads onClose={() => {}} />);
  fireEvent.click(screen.getByLabelText('删除下载记录：report.pdf'));
  await waitFor(() => expect(screen.queryByText('report.pdf')).toBeNull());
  expect(nativeBrowser).toHaveBeenCalledWith('remove-download', { id: 'done' });
  expect(apiClient.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('清除已结束记录'));
  await waitFor(() => expect(screen.queryByText('notes.zip')).toBeNull());
  expect(screen.getByText('Wing.exe')).toBeVisible();
  expect(nativeBrowser).toHaveBeenCalledWith('clear-downloads');
});
it('retains the record and displays a failure when removal is rejected', async () => {
  vi.mocked(nativeBrowser).mockRejectedValueOnce(new Error('下载记录不可用'));
  render(<BrowserDownloads onClose={() => {}} />);
  fireEvent.click(screen.getByLabelText('删除下载记录：report.pdf'));
  expect(await screen.findByRole('alert')).toHaveTextContent('下载记录不可用');
  expect(screen.getByText('report.pdf')).toBeVisible();
});
it('reveals the actual saved file and announces newly started downloads', async () => {
  const view = render(<BrowserDownloads onClose={() => {}} />);
  fireEvent.click(screen.getByLabelText('打开所在文件夹：report.pdf'));
  await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/files/local-action', { path: 'C:/Downloads/report.pdf', action: 'reveal' }));
  view.unmount();useBrowserPanel.setState({ downloads: [] });render(<BrowserPanel />);
  act(() => useBrowserPanel.setState({ downloads: [{ id: 'new', name: 'file.zip', status: 'pending' }] }));
  expect(screen.getByRole('status')).toHaveTextContent('已开始下载：file.zip');
  expect(screen.getByLabelText('下载记录')).toHaveClass('is-downloading');
  act(() => useBrowserPanel.setState({ downloads: [{ id: 'new', name: 'file.zip', status: 'ready' }] }));
  expect(screen.getByRole('status')).toHaveTextContent('下载完成：file.zip');
  expect(screen.getByLabelText('下载记录')).not.toHaveClass('is-downloading');
});
