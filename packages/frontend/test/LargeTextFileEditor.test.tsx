import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreview } from '@/components/project/FilePreview';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/components/project/CodeEditor', () => ({ CodeEditor: ({ value, onChange }: any) => <textarea aria-label="代码编辑器" value={value} onChange={e => onChange(e.target.value)} /> }));
const page = { content: 'original', offset: 0, end: 8, size: 11 * 1024 ** 3, revision: 'r1', segmentHash: 'h1' };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(apiClient.get).mockImplementation(async url => url.includes('editor=true') ? { size: page.size, segmented: true } : url.includes('text-draft') ? {} : url.includes('text-save') ? { state: 'saving', copied: 1, total: page.size } : page); vi.mocked(apiClient.post).mockResolvedValue({ id: 'job-1' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('large-file automatic persistence', () => {
 it('opens >10 GiB by pages and automatically submits edits without a manual save', async () => {
   render(<FilePreview filePath="C:/large/auto.txt" />); const editor = await screen.findByRole('textbox', { name: '代码编辑器' });
   expect(screen.getByText(/11.00 GiB/)).toBeInTheDocument(); expect(apiClient.post).not.toHaveBeenCalled();
   vi.useFakeTimers(); fireEvent.change(editor, { target: { value: 'latest draft' } });
   await act(async () => { vi.advanceTimersByTime(1200); });
   expect(apiClient.post).toHaveBeenCalledWith('/files/text-autosave', expect.objectContaining({ content: 'latest draft', revision: 'r1' }));
   expect(screen.getByRole('status')).toHaveTextContent('草稿已保存');
   expect(screen.getByRole('button', { name: '下一段' })).toBeDisabled();
 });
 it('flushes pending edits when switching files', async () => {
   const ui = render(<FilePreview filePath="C:/large/first.txt" />); fireEvent.change(await screen.findByRole('textbox', { name: '代码编辑器' }), { target: { value: 'survive navigation' } });
   ui.rerender(<FilePreview filePath="C:/large/second.txt" />);
   await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/files/text-autosave', expect.objectContaining({ path: 'C:/large/first.txt', content: 'survive navigation' })));
 });
});
