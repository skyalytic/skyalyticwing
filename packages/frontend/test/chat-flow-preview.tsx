// Development-only visual fixture. Uses the real transcript components and styles.
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {MessageList} from '../src/components/chat/MessageList';
import {useChatStore} from '../src/stores/chat-store';
import '../src/i18n';
import '../src/styles/global.css';
import '../src/index.css';
import '../src/styles/workbench.css';
import '../src/styles/workspace.css';
import type {ChatMessage} from '../src/types';
document.documentElement.classList.add('light');
localStorage.setItem('app.language','zh-CN');
const s=useChatStore.getState(); s.clear(); s.activateSession('fixture');
s.startToolCall('read','file-read',{path:'src/components/Conversation.tsx'},'fixture');
s.finishToolCall('read','file-read',{success:true,output:'export function Conversation() { return <main />; }'},'fixture');
s.startToolCall('edit','file-edit',{path:'src/components/Conversation.tsx'},'fixture');
s.finishToolCall('edit','file-edit',{success:true,data:{diff:'--- before\n+++ after\n-<section className="bubble">\n+<section className="transcript">\n+  <MessageList />'}},'fixture');
s.startToolCall('test','powershell',{command:'pnpm test -- conversation'},'fixture');
s.finishToolCall('test','powershell',{success:false,error:'Request cancelled',data:{cancelled:true}},'fixture');
const m=(id:string,role:ChatMessage['role'],content:string,turnId='a',turnSequence=0):ChatMessage=>({id,role,content,turnId,turnSequence,timestamp:1700000000000,sessionId:'fixture'});
const messages:ChatMessage[]=[m('u','user','检查对话输出，按参考样式修改。'),
 {...m('a1','assistant','我先查看对话组件，再检查消息是怎样保存和显示的。','a',1),phase:'progress'},
 {...m('tool-read','tool','','a',2),toolCallId:'read',toolName:'file-read'},
 {...m('tool-edit','tool','','a',3),toolCallId:'edit',toolName:'file-edit'},
 {...m('a2','assistant','旧错误没有绑定到原轮次。我会让它留在触发错误的那次对话下面。','a',4),phase:'progress'},
 {...m('tool-test','tool','','a',5),toolCallId:'test',toolName:'powershell'},
 {...m('a:status','system','已停止','a',6),phase:'status',turnStatus:'cancelled'},
 m('u2','user','先不做了，你好。','b'),m('b1','assistant','你好，有什么想聊的？','b',1)];
function Preview(){return <MemoryRouter><main style={{maxWidth:860,height:'100vh',margin:'0 auto',display:'flex',flexDirection:'column',background:'var(--bg-primary)'}}><MessageList messages={messages} isStreaming={false} streamingContent=""/></main></MemoryRouter>;}
createRoot(document.getElementById('root')!).render(<Preview/>);
