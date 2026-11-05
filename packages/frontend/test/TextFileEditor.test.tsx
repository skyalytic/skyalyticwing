import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreview } from '@/components/project/FilePreview';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/components/project/CodeEditor', () => ({ CodeEditor: ({ value, onChange, onSave }: any) => <textarea aria-label="代码编辑器" value={value} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.ctrlKey&&e.key==='s'){e.preventDefault();onSave();}}}/> }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(apiClient.get).mockResolvedValue({ content: 'print("hello")\r\n', size: 16, revision: 'r1' }); vi.mocked(apiClient.post).mockResolvedValue({ revision: 'r2' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('IDE file editing and persistence', () => {
 it('opens editable immediately without an edit button or an initial write', async () => {
  render(<FilePreview filePath="C:/test/open.py"/>);
  expect(await screen.findByRole('textbox',{name:'代码编辑器'})).toHaveValue('print("hello")\n');
  expect(screen.queryByRole('button',{name:'编辑',exact:true})).not.toBeInTheDocument();expect(apiClient.post).not.toHaveBeenCalled();
 });
 it('serializes writes and sends the latest edit with the returned revision', async () => {
  let finish!: (v:any)=>void;vi.mocked(apiClient.post).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  render(<FilePreview filePath="C:/test/serialized.py"/>);const editor=await screen.findByRole('textbox');
  fireEvent.change(editor,{target:{value:'one'}});fireEvent.keyDown(editor,{key:'s',ctrlKey:true});
  fireEvent.change(editor,{target:{value:'two'}});fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));expect(apiClient.post).toHaveBeenCalledTimes(1);
  await act(async()=>finish({revision:'r2'}));
  await waitFor(()=>expect(apiClient.post).toHaveBeenCalledTimes(2));expect(apiClient.post).toHaveBeenLastCalledWith('/files/write',{path:'C:/test/serialized.py',content:'two',revision:'r2'});
 });
 it('flushes a pending draft to the original path when switching files', async () => {
  const ui=render(<FilePreview filePath="C:/test/first.py"/>);fireEvent.change(await screen.findByRole('textbox'),{target:{value:'changed'}});
  ui.rerender(<FilePreview filePath="C:/test/second.py"/>);await screen.findByRole('textbox');
  expect(apiClient.post).toHaveBeenCalledWith('/files/write',{path:'C:/test/first.py',content:'changed',revision:'r1'});
 });
 it('retains a conflicted draft across files and does not retry automatically', async () => {
  vi.mocked(apiClient.post).mockRejectedValue(new Error('revision conflict'));
  const ui=render(<FilePreview filePath="C:/test/conflict.py"/>);fireEvent.change(await screen.findByRole('textbox'),{target:{value:'keep my draft'}});fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));
  await screen.findByRole('alert');ui.rerender(<FilePreview filePath="C:/test/other.py"/>);await screen.findByRole('textbox');ui.rerender(<FilePreview filePath="C:/test/conflict.py"/>);
  expect(await screen.findByRole('textbox')).toHaveValue('keep my draft');expect(apiClient.post).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toHaveTextContent('草稿已保留');
 });
 it('autosaves after the debounce and never writes on merely opening Markdown', async () => {
  render(<FilePreview filePath="C:/test/readme.md"/>);const editor=await screen.findByRole('textbox');vi.useFakeTimers();fireEvent.change(editor,{target:{value:'# Updated'}});
  await act(async()=>vi.advanceTimersByTime(599));expect(apiClient.post).not.toHaveBeenCalled();await act(async()=>vi.advanceTimersByTime(1));expect(apiClient.post).toHaveBeenCalledTimes(1);
 });
});
