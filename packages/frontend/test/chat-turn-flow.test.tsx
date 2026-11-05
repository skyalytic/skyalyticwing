import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useChatStore } from '@/stores/chat-store';
import { useAskUserStore } from '@/stores/ask-user-store';
import { MessageList } from '@/components/chat/MessageList';
import { toolPresentation } from '@/components/chat/tool-presentation';
import type { ChatMessage } from '@/types';
vi.mock('@/services/api-client', () => ({apiClient: {get: vi.fn().mockResolvedValue([]), put: vi.fn(), post: vi.fn()}}));
const message = (id: string, role: ChatMessage['role'], turnId: string, turnSequence: number, content = id): ChatMessage => ({id, role, turnId, turnSequence, content, timestamp: turnId === 'a' ? 1 : 10, sessionId: 's'});
beforeEach(() => {useChatStore.getState().clear(); useChatStore.getState().activateSession('s'); useAskUserStore.setState({requests: []});});

describe('turn transcript', () => {
  it('keeps cancellation at its original turn through subsequent replies and reopen', () => {
    const store = useChatStore.getState();
    const a = message('a:user','user','a',0);
    const stopped = {...message('a:status','system','a',999,'已停止'), phase:'status' as const, turnStatus:'cancelled' as const};
    store.addMessage(a); store.addMessage(stopped);
    const b = message('b:user','user','b',0);
    const reply = message('b:reply','assistant','b',1,'你好');
    store.mergeHistory('s',[a,b,reply]);
    expect(useChatStore.getState().messages.map(m => m.id)).toEqual(['a:user','a:status','b:user','b:reply']);
    store.mergeHistory('s',[a,stopped,b,reply]);
    store.activateSession('other'); store.activateSession('s');
    expect(useChatStore.getState().messages.map(m => m.id)).toEqual(['a:user','a:status','b:user','b:reply']);
  });
  it('anchors a legacy client error before the next user instead of at the transcript bottom', () => {
    const a = {...message('u1','user','a',0), turnId: undefined};
    const b = {...message('u2','user','b',0), turnId: undefined};
    useChatStore.getState().addMessage({id:'client-error_old',role:'system',content:'Request cancelled',timestamp:5});
    useChatStore.getState().mergeHistory('s',[a,b]);
    expect(useChatStore.getState().messages.map(m => m.id)).toEqual(['u1','client-error_old','u2']);
  });
  it('replaces streaming snapshots in place and ignores a late snapshot after completion', () => {
    const store = useChatStore.getState();
    store.addMessage(message('a:user','user','a',0));
    const text = {...message('a:text','assistant','a',1,'先查看'), phase:'progress' as const};
    store.settleAssistantMessage({...text, streaming:true});
    store.settleAssistantMessage({...text, content:'先查看文件',streaming:true});
    store.addMessage({...message('tool-1','tool','a',2,''),toolCallId:'1',toolName:'file-read'});
    store.settleAssistantMessage({...text, content:'先查看文件。',streaming:false});
    store.settleAssistantMessage({...text, streaming:true});
    expect(useChatStore.getState().messages.map(m => m.content)).toEqual(['a:user','先查看文件。','']);
  });
  it('renders tool-only work without an empty prose bubble or duplicate waiting indicator', () => {
    const tool = {...message('tool-1','tool','a',1,''),toolCallId:'1',toolName:'file-read'};
    useChatStore.getState().startToolCall('1','file-read',{path:'test.txt'},'s');
    const {container} = render(<MemoryRouter><MessageList messages={[tool]} isStreaming streamingContent="" /></MemoryRouter>);
    expect(container.querySelector('.chat-msg-assistant')).toBeNull();
    expect(container.querySelector('.chat-waiting')).toBeNull();
    expect(screen.getByText('test.txt')).toBeInTheDocument();
  });
  it('only groups uninterrupted tools and preserves expanded row details on updates', () => {
    const store = useChatStore.getState();
    store.startToolCall('1','powershell',{command:'git status'},'s');
    store.startToolCall('2','file-read',{path:'README.md'},'s');
    const tools = ['1','2'].map((id,i) => ({...message(`tool-${id}`,'tool','a',i+1,''),toolCallId:id,toolName:id==='1'?'powershell':'file-read'}));
    const view = (items: ChatMessage[]) => <MemoryRouter><MessageList messages={items} isStreaming streamingContent="" /></MemoryRouter>;
    const {container, rerender} = render(view(tools));
    fireEvent.click(screen.getByText('git status'));
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
    rerender(view([...tools,message('prose','assistant','a',3,'继续检查'),{...tools[0],id:'tool-3',toolCallId:'3',turnSequence:4}]));
    expect(container.querySelectorAll('.tool-process-group')).toHaveLength(1);
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
  });
  it('does not show generating dots while waiting for a user answer', () => {
    useAskUserStore.getState().show({id:'q',sessionId:'s',question:'选择文件',options:[],multiple:false});
    const {container} = render(<MemoryRouter><MessageList messages={[]} isStreaming streamingContent="" /></MemoryRouter>);
    expect(container.querySelector('.chat-waiting')).toBeNull();
  });
  it('uses extension presentation and counts real diff lines, excluding headers', () => {
    expect(toolPresentation('custom_tool',{}, {success:true,presentation:{title:'导出表格',summary:'report.xlsx'},data:{diff:'--- old\n+++ new\n-old\n+new\n+extra'}})).toMatchObject({title:'导出表格',target:'report.xlsx',added:2,removed:1});
  });
});
