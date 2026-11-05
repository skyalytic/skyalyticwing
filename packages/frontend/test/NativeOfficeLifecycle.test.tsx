import {act,cleanup,render,screen,fireEvent} from '@testing-library/react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {OfficeEditor} from '@/components/project/OfficeEditor';
import {apiClient} from '@/services/api-client';
import {nativeInvoke} from '@/services/native-browser';
import {WORKSPACE_RESIZE_EVENT} from '@/components/project/use-workspace-resize';
vi.mock('@/services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
vi.mock('@/services/tauri-bridge',()=>({isTauri:()=>true}));
vi.mock('@/services/native-browser',()=>({nativeInvoke:vi.fn().mockResolvedValue(undefined)}));
beforeEach(()=>{
  vi.useFakeTimers();vi.clearAllMocks();
  vi.mocked(nativeInvoke).mockResolvedValue(undefined);
  vi.mocked(apiClient.get).mockImplementation(async path=>path==='/office-native/status'?{available:true}:{ready:true,savedAt:Date.now(),dirty:false,error:''});
  vi.mocked(apiClient.post).mockImplementation(async path=>path==='/office-native/open'?{id:'doc',url:'http://localhost:1000/#cap',name:'a.docx'}:{});
});
afterEach(async()=>{cleanup();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});vi.useRealTimers();vi.restoreAllMocks();delete document.body.dataset.wingWorkspaceResizing;});
it('opens the built-in editor directly and saves through its command API',async()=>{
  await act(async()=>{render(<OfficeEditor filePath="C:/a.docx"/>);});
  expect(nativeInvoke).toHaveBeenCalledWith('native_office_view',expect.objectContaining({action:'open',id:'doc'}));
  expect(screen.queryByText('安装 / 继续安装本地 Office')).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1200);});
  fireEvent.click(screen.getByRole('button',{name:'保存',exact:true}));
  expect(apiClient.post).toHaveBeenCalledWith('/office-native/sessions/doc/command',{action:'save'});
});
it('releases a document that finishes opening after the tab was closed',async()=>{
  let finish!:(value:unknown)=>void;
  vi.mocked(apiClient.post).mockImplementation(async path=>path==='/office-native/open'?new Promise(r=>{finish=r;}):{});
  let view!:ReturnType<typeof render>;
  await act(async()=>{view=render(<OfficeEditor filePath="C:/late.docx"/>);});view.unmount();
  await act(async()=>{finish({id:'late',url:'http://localhost:1000',name:'late.docx'});});
  expect(apiClient.post).toHaveBeenCalledWith('/office-native/sessions/late/release',{});
  expect(nativeInvoke).not.toHaveBeenCalledWith('native_office_view',expect.objectContaining({action:'open'}));
});
it('hides the native Office view during workspace dragging so it cannot steal the pointer',async()=>{
  vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as never);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:10,y:10,width:600,height:500} as DOMRect);
  await act(async()=>{render(<OfficeEditor filePath="C:/a.docx"/>);});
  document.body.dataset.wingWorkspaceResizing='true';fireEvent(window,new Event(WORKSPACE_RESIZE_EVENT));
  expect(nativeInvoke).toHaveBeenLastCalledWith('native_office_view',expect.objectContaining({action:'bounds',bounds:expect.objectContaining({visible:false})}));
  delete document.body.dataset.wingWorkspaceResizing;fireEvent(window,new Event(WORKSPACE_RESIZE_EVENT));
  expect(nativeInvoke).toHaveBeenLastCalledWith('native_office_view',expect.objectContaining({action:'bounds',bounds:expect.objectContaining({visible:true})}));
});
