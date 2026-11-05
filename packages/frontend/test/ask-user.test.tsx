import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { AskUserModal } from '../src/components/modals/AskUserModal';
import { useAskUserStore } from '../src/stores/ask-user-store';
import { useSessionStore } from '../src/stores/session-store';
import { useWebSocket } from '../src/hooks/use-websocket';
import { apiClient } from '../src/services/api-client';

const mocks = vi.hoisted(()=>({listeners:new Map<string,(e:any)=>void>(),status:undefined as undefined|((s:string,n:number)=>void)}));
vi.mock('@/services/ws-client',()=>({wsClient:{
  on:(name:string,fn:(e:any)=>void)=>{mocks.listeners.set(name,fn);return ()=>mocks.listeners.delete(name)},
  onStatus:(fn:any)=>{mocks.status=fn;return ()=>{}}, getStatus:()=> 'connected',
  send:vi.fn(),connect:vi.fn(),disconnect:vi.fn(),reconnect:vi.fn(),
}}));
vi.mock('@/services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
vi.mock('react-i18next',async importOriginal=>({...await importOriginal<typeof import('react-i18next')>(),useTranslation:()=>({t:(s:string)=>s,i18n:{language:'zh-CN'}})}));
vi.mock('@/components/ui/Toast',()=>({toast:{info:vi.fn(),error:vi.fn(),warn:vi.fn(),success:vi.fn()}}));

function Host(){ useWebSocket(); return <AskUserModal/>; }
const question = (id:string,sessionId='one')=>({id,sessionId,question:'原始 BGM 在哪里？'+id,options:['文件已放好','稍后提供'],multiple:false});
beforeEach(()=>{
  vi.clearAllMocks();mocks.listeners.clear();
  useAskUserStore.setState({requests:[]});
  useSessionStore.setState({currentSessionId:'one'});
  vi.mocked(apiClient.get).mockResolvedValue([]);
  vi.mocked(apiClient.post).mockResolvedValue({success:true});
});
afterEach(cleanup);

describe('ask_user visible answer flow',()=>{
  it('is mounted by the production layout, accepts a custom path alongside choices and submits its request id',async()=>{
    expect(readFileSync(new NodeURL('../src/components/layout/Layout.tsx',import.meta.url),'utf8')).toContain('<AskUserModal />');
    render(<Host/>);
    await act(async()=>{});
    act(()=>mocks.listeners.get('ask_user_request')!({type:'ask_user_request',data:question('a')}));
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(screen.getByText('文件已放好'));
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'E:/music/original.wav'}});
    fireEvent.click(screen.getByText('chat.askUser.submit'));
    await waitFor(()=>expect(apiClient.post).toHaveBeenCalledWith('/tools/ask-user/respond',{id:'a',answer:['E:/music/original.wav']}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('shows only a text response for a human step and accepts 好了', async()=>{
    render(<AskUserModal/>);
    act(()=>useAskUserStore.getState().show({...question('step'),options:[],question:'完成后回复好了'}));
    expect(screen.queryByText('确认')).toBeNull();
    expect(screen.queryByText('chat.askUser.singleHint')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'好了'}});
    fireEvent.click(screen.getByText('chat.askUser.submit'));
    await waitFor(()=>expect(apiClient.post).toHaveBeenCalledWith('/tools/ask-user/respond',{id:'step',answer:['好了']}));
  });
  it('switches cleanly between a written answer and a supplied option',async()=>{
    render(<AskUserModal/>);
    act(()=>useAskUserStore.getState().show(question('a')));
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'原来的文字'}});
    fireEvent.click(screen.getByText('稍后提供'));
    expect(screen.getByRole('textbox')).toHaveValue('');
    fireEvent.click(screen.getByText('chat.askUser.submit'));
    await waitFor(()=>expect(apiClient.post).toHaveBeenCalledWith('/tools/ask-user/respond',{id:'a',answer:['稍后提供']}));
  });
  it('restores pending questions and keeps other sessions separate; cancel submits an empty answer',async()=>{
    vi.mocked(apiClient.get).mockResolvedValue([question('a'),question('b','two')]);
    render(<Host/>);
    await screen.findByText('原始 BGM 在哪里？a');
    expect(screen.queryByText('原始 BGM 在哪里？b')).toBeNull();
    act(()=>useSessionStore.setState({currentSessionId:'two'}));
    expect(screen.getByText('原始 BGM 在哪里？b')).toBeVisible();
    fireEvent.click(screen.getByText('chat.askUser.cancel'));
    await waitFor(()=>expect(apiClient.post).toHaveBeenCalledWith('/tools/ask-user/respond',{id:'b',answer:[]}));
    await waitFor(()=>expect(useAskUserStore.getState().requests.map(q=>q.id)).toEqual(['a']));
    act(()=>mocks.listeners.get('ask_user_resolved')!({type:'ask_user_resolved',data:{id:'a'}}));
    expect(useAskUserStore.getState().requests).toEqual([]);
  });
  it('queues questions without replacement and keeps failed submissions available to retry',async()=>{
    render(<Host/>);await act(async()=>{});
    act(()=>{useAskUserStore.getState().show(question('a'));useAskUserStore.getState().show(question('b'));});
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByText('文件已放好'));
    fireEvent.click(screen.getByText('chat.askUser.submit'));
    await waitFor(()=>expect(screen.getByText('chat.askUser.submit')).not.toBeDisabled());
    expect(screen.getByText('原始 BGM 在哪里？a')).toBeVisible();
    fireEvent.click(screen.getByText('chat.askUser.submit'));
    await screen.findByText('原始 BGM 在哪里？b');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
