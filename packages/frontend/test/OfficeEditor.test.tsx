import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollaboraEditor as OfficeEditor } from '@/components/project/CollaboraEditor';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  vi.mocked(apiClient.get).mockImplementation(async (route) =>
    route === '/office-engine/status'
      ? { ready: true }
      : {
          url: 'http://localhost:9980',
          callback: 'http://localhost:3000',
          internal: '',
          frameOrigin: 'http://localhost:3000',
        },
  );
  vi.mocked(apiClient.post).mockResolvedValue({
    id: 'test',
    editorUrl: 'http://localhost:9980/editor',
    credential: 'private-file-token',
    expires: Date.now() + 60000,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('Full Office host', () => {
  it('keeps the current frame when reload cannot confirm storage, and reloads only after a save response', async () => {
    const config={url:'http://localhost:9980',callback:'http://localhost:3000',internal:'',frameOrigin:'http://localhost:3000'};
    let storageAvailable=false;
    vi.mocked(apiClient.get).mockImplementation(async route=>{
      if(route==='/office-engine/status')return {ready:true};
      if(route.startsWith('/office-engine/sessions/')){if(!storageAvailable)throw new Error('offline');return {savedAt:100,error:null};}
      return config;
    });
    render(<OfficeEditor filePath="C:/reload.docx"/>);
    const frame=await screen.findByTitle('Office 完整文档编辑器') as HTMLIFrameElement;
    fireEvent.click(screen.getByRole('button',{name:'保存后重新载入'}));
    await screen.findByText('无法确认原文件状态，已保留当前编辑器。');
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    storageAvailable=true;
    fireEvent.click(screen.getByRole('button',{name:'保存后重新载入'}));
    await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('正在保存'));
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    fireEvent(window,new MessageEvent('message',{origin:'http://localhost:9980',source:frame.contentWindow!,data:JSON.stringify({MessageId:'Action_Save_Resp',Values:{success:false,result:'unmodified'}})}));
    await waitFor(()=>expect(apiClient.post).toHaveBeenCalledTimes(2));
  });
  it('ignores forged messages and treats an unmodified document as a successful no-op', async () => {
    render(<OfficeEditor filePath="C:/test.docx" />);
    const frame = (await screen.findByTitle('Office 完整文档编辑器')) as HTMLIFrameElement;
    await waitFor(() => expect(HTMLFormElement.prototype.submit).toHaveBeenCalled());
    const data = JSON.stringify({
      MessageId: 'Action_Save_Resp',
      Values: { success: false, result: 'unmodified' },
    });
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'http://attacker.invalid',
        source: frame.contentWindow!,
        data,
      }),
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('无需重复保存');
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'http://localhost:9980',
        source: frame.contentWindow!,
        data,
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('无需重复保存');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'http://localhost:9980',
        source: frame.contentWindow!,
        data: JSON.stringify({
          MessageId: 'Action_Save_Resp',
          Values: { success: false, result: 'failed' },
        }),
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败');
  });
  it('saves user-configured private engine addresses through the configuration API', async () => {
    vi.mocked(apiClient.get).mockImplementation(async (route) =>
      route === '/office-engine/status'
        ? { ready: false, reason: '尚未连接' }
        : {
            url: '',
            internal: '',
            callback: 'http://localhost:3000',
            frameOrigin: 'http://localhost:3000',
          },
    );
    render(<OfficeEditor filePath="C:/test.docx" />);
    await screen.findByText('尚未连接');
    fireEvent.change(screen.getByLabelText('编辑引擎地址'), {
      target: { value: 'http://private-office:9980' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));
    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(
        '/office-engine/configuration',
        expect.objectContaining({ url: 'http://private-office:9980' }),
      ),
    );
  });
});
