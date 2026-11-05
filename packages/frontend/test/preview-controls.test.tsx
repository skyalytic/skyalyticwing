import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ImageAttachment, ImagePreview } from '@/components/project/ImagePreview';
import { PreviewFrame } from '@/components/project/PreviewControls';
import { FileActions } from '@/components/project/FileActions';
import { OfficePreview } from '@/components/project/OfficePreview';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/components/ui/Toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/browser/BrowserControls', () => ({ BrowserControls: () => null }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(apiClient.post).mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('preview controls', () => {
  it('opens a chat image, shows actual pixel size at 100%, zooms and closes', () => {
    render(<ImageAttachment src="/fixture.png" name="截图" />);
    fireEvent.click(screen.getByRole('button', { name: '放大图片 截图' }));
    const img = screen.getByRole('dialog').querySelector('img')!;
    Object.defineProperties(img, { naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 } });
    fireEvent.load(img); fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(img.style.width).toBe('2000px');
    fireEvent.click(screen.getByLabelText('放大预览')); expect(img.style.width).toBe('2200px');
    fireEvent.click(screen.getByLabelText('关闭')); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps an edited field mounted while expanding and collapsing', () => {
    render(<PreviewFrame><textarea aria-label="文档草稿" defaultValue="原文" /></PreviewFrame>);
    const field = screen.getByLabelText('文档草稿'); fireEvent.change(field, { target: { value: '未保存内容' } });
    fireEvent.click(screen.getByText('扩大预览')); expect(screen.getByRole('dialog')).toContainElement(field);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('文档草稿')).toBe(field); expect(field).toHaveValue('未保存内容');
  });
  it('reports a missing image instead of leaving an empty preview', () => {
    render(<ImagePreview src="/missing.png" name="missing" />); fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('alert')).toHaveTextContent('图片加载失败');
  });
  it('uses the selected Unicode path for native actions and reports failures', async () => {
    render(<FileActions filePath={'E:\\测试\\文档.docx'} />);
    fireEvent.click(screen.getByText('打开所在文件夹'));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/files/local-action', { path: 'E:\\测试\\文档.docx', action: 'reveal' }));
    await waitFor(() => expect(screen.getByText('用默认应用打开')).toBeEnabled());
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('文件不存在'));
    fireEvent.click(screen.getByText('用默认应用打开'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('文件操作失败', '文件不存在'));
  });
  it('zooms Office text without changing or saving document content', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ format: 'docx', revision: 'r1', sections: [{ name: '正文', fields: [{ id: 'p:0', value: '原文' }] }] });
    render(<OfficePreview filePath="E:/测试/文档.docx" />);
    const field = await screen.findByLabelText('正文 文本 1'); fireEvent.click(screen.getByLabelText('放大预览'));
    expect(field).toHaveValue('原文'); expect(field.closest('article')!.parentElement!.style.zoom).toBe('1.1'); expect(apiClient.post).not.toHaveBeenCalled();
  });
});
