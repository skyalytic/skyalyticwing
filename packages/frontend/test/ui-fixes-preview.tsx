// Isolated visual fixture: real application components and stores; no production API requests.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '../src/components/layout/Layout';
import { ChatView } from '../src/components/chat/ChatView';
import { SettingsPage } from '../src/modules/settings/SettingsPage';
import { useBrowserPanel } from '../src/stores/browser-store';
import { useWorkspaceTabs } from '../src/stores/workspace-tab-store';
import { applyStartupSettings, watchSystemAppearance } from '../src/utils/apply-settings';
import { apiClient } from '../src/services/api-client';
import { wsClient } from '../src/services/ws-client';
import { useSessionStore } from '../src/stores/session-store';
import { useApprovalStore } from '../src/stores/approval-store';
import { useProjectPanel } from '../src/stores/project-panel-store';
import { applyThemeToDocument } from '../src/hooks/use-theme';
import i18n from '../src/i18n';
import '../src/styles/global.css';
import '../src/index.css';
import '../src/styles/workbench.css';
import '../src/styles/workspace.css';

const nativeFetch = window.fetch.bind(window);
const params = new URLSearchParams(location.search);
applyThemeToDocument(params.get('theme') === 'dark' ? 'dark' : 'light');
void i18n.changeLanguage('zh-CN');
applyStartupSettings();
watchSystemAppearance();
localStorage.setItem('wing-chats-open', 'false');
const session = { id: 'qa-session', title: '帮我做一个小游戏随便的', createdAt: 1, updatedAt: 1, messageCount: 0 };
const project = '测试项目';
const history: unknown[] = [];
const handlers = new Map<string, Set<(event: any) => void>>();
const emit = (type: string, data: any) => handlers.get(type)?.forEach((fn) => fn({ type, data }));
Object.assign(wsClient, {
  connect() {}, disconnect() {}, send() {}, getStatus: () => 'connected',
  onStatus(callback: any) { callback('connected', 0); return () => {}; },
  on(type: string, callback: any) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(callback); return () => handlers.get(type)?.delete(callback); },
});
const jobs = params.has('long') ? Array.from({ length: 12 }, (_, index) => ({ id: `qa-video-${index}`, status: 'running', request: { prompt: `商品展示视频 ${index + 1}：生成任务列表滚动测试` } })) : [];
apiClient.get = async (path: string): Promise<any> => {
  if (path === '/files/projects') return [];
  if (path.startsWith('/office-engine/status')) return { ready: false, reason: '隔离验证：使用基础内容编辑' };
  if (path.startsWith('/office-engine/configuration')) return { managed: true };
  if (path.startsWith('/files/office')) return { format: 'docx', revision: 'r1', sections: [{ name: '产品使用说明', fields: [{ id: 'p:0', value: 'SkyalyticWing 文档预览验证\n放大只改变显示，不改变原文件的字号。\n扩大预览时保留当前编辑内容。' }] }] };
  if (path.startsWith('/files/list')) return (await nativeFetch('/__qa/files')).json();
  if (path.startsWith('/files/project')) return { path: project, source: 'session' };
  if (path === '/sessions') return [session];
  if (path.includes('/messages')) return [];
  if (path === '/sessions/recovery') return null;
  if (path === '/automation/media/video-tasks') return jobs;
  if (path === '/approvals/history') return history;
  return [];
};
apiClient.post = async (path: string, data: any): Promise<any> => {
  if (path === '/files/office') return { revision: 'r2' };
  if (path.startsWith('/approvals/')) { history.push({ id: path.split('/').pop(), toolName: 'file-write', ...data }); return {}; }
  throw Error('此隔离验证页不发送真实请求');
};
window.fetch = async () => new Response(JSON.stringify({ success: true, data: { connected: false, version: '2.0.0', required: false } }), { headers: { 'Content-Type': 'application/json' } });
useSessionStore.setState({ currentSessionId: session.id, sessions: [session] });
useProjectPanel.setState({ projectDir: project, dirSource: 'session', initialized: true, open: true });
const approve = () => useApprovalStore.getState().addApproval({ id: `qa-${Date.now()}`, sessionId: session.id, toolName: 'file-write', args: { path: 'snake.html' }, reason: '隔离审批测试', timestamp: Date.now() });
const write = async () => {
  await nativeFetch('/__qa/write', { method: 'POST' });
  emit('tool_result', { sessionId: session.id, toolName: 'file-write', callId: `qa-write-${Date.now()}`, result: { success: true, output: 'snake.html 已写入隔离测试目录' } });
};
const openPreview = (file: string) => { useWorkspaceTabs.getState().openTab('editor'); useProjectPanel.getState().openFile(project + '/' + file); };
const browserPreview = async () => {
  const screenshot = await (await nativeFetch('/__qa/browser-image')).text();
  useBrowserPanel.setState({ snapshot: { pageId: 'qa', url: 'https://example.com', title: '隔离网页预览', viewport: { width: 1600, height: 900 }, screenshot, elements: [], consoleTail: [], markedAt: 0 }, sync: async () => {}, clickAt: async (x, y) => { useBrowserPanel.setState({ error: `隔离点击坐标：${x}, ${y}` }); }, scrollAt: async () => {} });
  useWorkspaceTabs.getState().openTab('browser');
};
function Preview() {
  return <MemoryRouter><div style={{ position: 'fixed', bottom: 2, left: 10, zIndex: 120, fontSize: 11 }}>
    <span>隔离验证 · 演示会话　</span><button className="btn-secondary" onClick={approve}>测试审批</button>{' '}
    <button className="btn-secondary" onClick={() => void write()}>写入测试文件</button>
    <button className="btn-secondary" onClick={() => openPreview('preview.jpg')}>预览测试图片</button>
    <button className="btn-secondary" onClick={() => openPreview('说明.docx')}>预览测试文档</button>
    <button className="btn-secondary" onClick={() => void browserPreview()}>预览测试网页</button>
  </div><Routes><Route element={<Layout />}><Route path="/" element={<ChatView />} /><Route path="/settings" element={<SettingsPage />} /><Route path="*" element={<div style={{ padding: 30 }}>页面切换验证</div>} /></Route></Routes></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
