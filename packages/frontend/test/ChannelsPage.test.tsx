import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ChannelsPage} from '@/modules/channels/ChannelsPage';
import {ChannelConfigModal} from '@/components/modals/ChannelConfigModal';
import {apiClient} from '@/services/api-client';
import {toast} from '@/components/ui/Toast';

vi.mock('@/services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn(),put:vi.fn()}}));
vi.mock('@/components/ui/Toast',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock('@/i18n/workbench-text',()=>({useWorkbenchLanguage:()=>{},wt:(s:string)=>s}));
vi.mock('react-i18next',async()=>({...await vi.importActual<typeof import('react-i18next')>('react-i18next'),useTranslation:()=>({t:(s:string)=>s})}));
vi.mock('@/modules/bindings/BindingsPage',()=>({BindingsPage:()=>null}));
vi.mock('@/components/channel/WeChatQrLogin',()=>({WeChatQrLogin:({onFill}:any)=><button onClick={()=>onFill({botToken:'new-qr-token',baseUrl:'https://ilinkai.weixin.qq.com'})}>模拟扫码确认</button>}));
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>{cleanup();vi.useRealTimers();});
it('shows only the eight retained channels and prevents enabling deferred email and SMS',async()=>{
 const types=['weixin','wechat-work','dingtalk','feishu','email','sms','cli','webchat','telegram','slack'];
 vi.mocked(apiClient.get).mockImplementation(async(url)=>url==='/channels'?types.map(type=>({id:type,type,name:type,enabled:false,status:'disconnected'})) as any:{} as any);
 render(<ChannelsPage/>);
 await screen.findAllByText('weixin');
 for(const type of types.slice(0,8))expect(document.getElementById('channel-card-'+type)).not.toBeNull();
 for(const type of types.slice(8))expect(document.getElementById('channel-card-'+type)).toBeNull();
 for(const type of ['email','sms']) {
  const card=document.getElementById('channel-card-'+type)!;
  expect(within(card).getByRole('button',{name:'启用'})).toBeDisabled();
  expect(within(card).getByText('该渠道尚未接入，暂不能启用或连接')).toBeInTheDocument();
 }
 expect(apiClient.put).not.toHaveBeenCalled();
});
it('QR confirmation enables the channel and submits both the token and enabled state',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 render(<ChannelConfigModal open channelId="weixin" channelEnabled={false} onClose={()=>{}} onSave={save}/>);
 fireEvent.click(screen.getByRole('button',{name:'模拟扫码确认'}));
 expect(screen.getByRole('combobox')).toHaveValue('true');
 fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
 await waitFor(()=>expect(save).toHaveBeenCalledWith('weixin',expect.objectContaining({botToken:'new-qr-token'}),true));
});
it('editing existing configuration keeps a saved secret without returning or resubmitting it',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);
 render(<ChannelConfigModal open channelId="weixin" channelEnabled savedConfig={{baseUrl:'https://example.invalid'}} configuredSecrets={['botToken']} onClose={()=>{}} onSave={save}/>);
 expect(screen.getByPlaceholderText('已保存，留空保留；填写可替换')).toHaveValue('');
 fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
 await waitFor(()=>expect(save).toHaveBeenCalledWith('weixin',{baseUrl:'https://example.invalid'},true));
});
it('keeps a failed-save draft open without an unhandled rejection',async()=>{
 render(<ChannelConfigModal open channelId="weixin" channelEnabled={false} onClose={()=>{}} onSave={async()=>{throw Error('disk full');}}/>);
 fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'保存配置'})).not.toBeDisabled());
 expect(screen.getByRole('dialog')).toBeInTheDocument();
});
it('uses fresh status snapshots and reports enabled-but-failed separately from a successful connection',async()=>{
 let enabled=false;
 vi.mocked(apiClient.get).mockImplementation(async(url)=>{
  if(url==='/channels')return[{id:'weixin',type:'weixin',name:'微信',enabled,status:'disconnected',category:'im'}] as any;
  if(url==='/channels/status')return{weixin:{status:enabled?'error':'disconnected',lastError:enabled?'expired':null}} as any;
  return{} as any;
 });
 vi.mocked(apiClient.put).mockImplementation(async()=>{enabled=true;return{channel:{enabled:true,status:'error',lastError:'expired'}} as any;});
 render(<ChannelsPage/>);
 await screen.findByText('微信');
 fireEvent.click(screen.getByRole('button',{name:'启用'}));
 await waitFor(()=>expect(toast.error).toHaveBeenCalledWith('配置已保存，但连接失败','expired'));
 expect(await screen.findByRole('button',{name:'禁用'})).toBeEnabled();
 expect(screen.getByText('expired',{exact:false})).toBeInTheDocument();
 expect(toast.success).not.toHaveBeenCalled();
});
it('refreshes provider state while the page stays open instead of keeping stale list status',async()=>{
 vi.useFakeTimers();let state='disconnected';
 vi.mocked(apiClient.get).mockImplementation(async(url)=>url==='/channels'?[{id:'weixin',type:'weixin',name:'微信',enabled:true,status:'disconnected'}] as any:{weixin:{status:state}} as any);
 render(<ChannelsPage/>);await act(async()=>{await Promise.resolve();});
 expect(screen.getByText('未连接')).toBeInTheDocument();state='connected';
 await act(async()=>{await vi.advanceTimersByTimeAsync(5100);});
 const card=document.getElementById('channel-card-weixin')!;
 expect(within(card).getByText('topbar.connected')).toBeInTheDocument();
});
