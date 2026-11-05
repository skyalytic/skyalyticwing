import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficePreview } from '@/components/project/OfficePreview';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
const get = vi.mocked(apiClient.get), post = vi.mocked(apiClient.post);
beforeEach(() => { vi.resetAllMocks(); get.mockResolvedValue({ format:'docx', revision:'first', sections:[{ name:'正文', fields:[{ id:'p:0', value:'原文' }] }] }); post.mockResolvedValue({ revision:'next' }); });
afterEach(cleanup);
describe('Office right panel', () => {
  it('edits and saves the original file, using the returned revision on the next save', async () => {
    render(<OfficePreview filePath="C:/fixture/one.docx" />);
    const field = await screen.findByLabelText('正文 文本 1');
    fireEvent.change(field, { target:{value:'已修改'} }); fireEvent.click(screen.getByText('立即保存'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已保存'));
    expect(post).toHaveBeenLastCalledWith('/files/office',{path:'C:/fixture/one.docx',revision:'first',changes:[{id:'p:0',value:'已修改'}]});
    fireEvent.change(field, { target:{value:'再修改'} }); fireEvent.click(screen.getByText('立即保存'));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/files/office',expect.objectContaining({revision:'next'})));
  });
  it('retains unsaved edits and reports save conflicts rather than showing saved', async () => {
    post.mockRejectedValue(new Error('文件已修改'));
    render(<OfficePreview filePath="C:/fixture/conflict.docx" />);
    fireEvent.change(await screen.findByLabelText('正文 文本 1'), {target:{value:'保留草稿'}}); fireEvent.click(screen.getByText('立即保存'));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件已修改'); expect(screen.getByLabelText('正文 文本 1')).toHaveValue('保留草稿'); expect(screen.getByRole('status')).not.toHaveTextContent(/^已保存$/);
  });
  it('flushes even an empty replacement when the panel closes', async () => {
    const view=render(<OfficePreview filePath="C:/fixture/empty.docx" />);
    fireEvent.change(await screen.findByLabelText('正文 文本 1'),{target:{value:''}}); view.unmount();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/files/office',expect.objectContaining({changes:[{id:'p:0',value:''}]})));
  });
  it('serializes saves and does not discard text typed while a request is in flight', async () => {
    let complete!: (value: {revision:string}) => void;
    post.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<OfficePreview filePath="C:/fixture/queue.docx" />);
    const field=await screen.findByLabelText('正文 文本 1');
    fireEvent.change(field,{target:{value:'第一版'}}); fireEvent.click(screen.getByText('立即保存'));
    fireEvent.change(field,{target:{value:'第二版'}}); fireEvent.click(screen.getByText('立即保存'));
    expect(post).toHaveBeenCalledTimes(1); complete({revision:'second'});
    await waitFor(()=>expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith('/files/office',expect.objectContaining({revision:'second',changes:[{id:'p:0',value:'第二版'}]}));
    await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('已保存'));
  });
});
