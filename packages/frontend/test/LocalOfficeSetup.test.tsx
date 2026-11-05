import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalOfficeSetup } from '@/components/project/LocalOfficeSetup';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
beforeEach(()=>vi.resetAllMocks());afterEach(cleanup);
describe('Local Office installation flow',()=>{
 it('exposes system setup when WSL is required, then shows restart instructions',async()=>{
  vi.mocked(apiClient.get).mockResolvedValue({phase:'system-setup-required',message:'需要 WSL',platform:'win32',running:false});
  vi.mocked(apiClient.post).mockResolvedValue({phase:'restart-required',message:'重启后继续',platform:'win32',running:false});
  render(<LocalOfficeSetup onReady={()=>{}}/>);fireEvent.click(await screen.findByText('启用 Windows 运行环境'));
  await screen.findByText('重启后继续');expect(apiClient.post).toHaveBeenCalledWith('/office-engine/local/enable-windows',expect.objectContaining({origin:window.location.origin}));
 });
 it('does not claim ready until the backend reports a successful engine check',async()=>{
  vi.mocked(apiClient.get).mockResolvedValue({phase:'not-installed',message:'未安装',platform:'darwin',running:false});
  vi.mocked(apiClient.post).mockResolvedValue({phase:'ready',message:'本地 Office 已安装并连接',platform:'darwin',running:false});
  const ready=vi.fn();render(<LocalOfficeSetup onReady={ready}/>);await screen.findByText('未安装');expect(screen.queryByText('进入完整 Office 编辑器')).toBeNull();
  fireEvent.click(screen.getByText('安装 / 继续安装本地 Office'));await waitFor(()=>expect(screen.getByText('进入完整 Office 编辑器')).toBeVisible());fireEvent.click(screen.getByText('进入完整 Office 编辑器'));expect(ready).toHaveBeenCalledOnce();
 });
});
