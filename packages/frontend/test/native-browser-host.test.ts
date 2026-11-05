import { afterEach, expect, it, vi } from 'vitest';
import { startNativeBrowserHost } from '@/services/native-browser';
import { useBrowserPanel } from '@/stores/browser-store';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/tauri-bridge', () => ({ isTauri: () => true }));
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('clears the annotation card when the native selection is cleared, even after a stale poll', async () => {
  vi.useFakeTimers();
  const selected = {tag:'button',text:'购买',selector:'#buy',outerHTML:'<button id="buy">购买</button>',rect:{x:1,y:2,w:60,h:20}};
  const nativeState = {activePageId:'p',tabs:[{id:'p',url:'https://example.com/',title:'产品'}],downloads:[],metadata:{url:'https://example.com/',title:'产品',selected:selected as typeof selected|null,selecting:false}};
  vi.stubGlobal('__TAURI_INTERNALS__', {invoke:vi.fn(async () => nativeState)});
  vi.mocked(apiClient.post).mockResolvedValue({commands:[]});
  vi.mocked(apiClient.get).mockResolvedValue({manual:false,agentBusy:false});
  stop = startNativeBrowserHost();
  await vi.advanceTimersByTimeAsync(0);
  expect(useBrowserPanel.getState().selected?.selector).toBe('#buy');
  useBrowserPanel.getState().clearSelected();
  await vi.advanceTimersByTimeAsync(300);
  expect(useBrowserPanel.getState().selected).not.toBeNull(); // in-flight old metadata
  nativeState.metadata.selected = null;
  await vi.advanceTimersByTimeAsync(300);
  expect(useBrowserPanel.getState().selected).toBeNull();
  expect(useBrowserPanel.getState().agentBusy).toBe(false);
});

it('updates native popup tabs and downloads while the backend command poll is stalled', async () => {
  vi.useFakeTimers();
  const nativeState = {
    activePageId: 'source',
    tabs: [{ id: 'source', url: 'https://www.baidu.com/', title: '搜索' }],
    downloads: [] as Array<{ id: string; name: string; status: string }>,
  };
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn(async () => structuredClone(nativeState)) });
  vi.mocked(apiClient.post).mockImplementation(async (path) => {
    if (path === '/builtin-browser/native/poll') return new Promise(() => {});
    return { commands: [] } as never;
  });
  stop = startNativeBrowserHost();
  await vi.advanceTimersByTimeAsync(0);
  nativeState.tabs.push({ id: 'popup', url: 'https://skyalytic.com/', title: '官网' });
  nativeState.activePageId = 'popup';
  nativeState.downloads.push({ id: 'download', name: 'Wing.exe', status: 'pending' });
  await vi.advanceTimersByTimeAsync(500);
  expect(useBrowserPanel.getState().tabs).toHaveLength(2);
  expect(useBrowserPanel.getState().snapshot?.pageId).toBe('popup');
  expect(useBrowserPanel.getState().downloads[0]?.status).toBe('pending');
  expect(useBrowserPanel.getState().nativeReady).toBe(true);
  nativeState.downloads[0]!.status = 'ready';
  await vi.advanceTimersByTimeAsync(500);
  expect(useBrowserPanel.getState().downloads[0]?.status).toBe('ready');
});

it('continues local browsing when the backend transport fails repeatedly', async () => {
  vi.useFakeTimers();
  const nativeState = {activePageId:'p',tabs:[{id:'p',url:'https://example.com/',title:'网页'}],downloads:[]};
  vi.stubGlobal('__TAURI_INTERNALS__', {invoke:vi.fn(async () => nativeState)});
  vi.mocked(apiClient.post).mockRejectedValue(new Error('命令通道不可用'));
  stop = startNativeBrowserHost();
  await vi.advanceTimersByTimeAsync(5000);
  expect(useBrowserPanel.getState().nativeReady).toBe(true);
  expect(useBrowserPanel.getState().snapshot?.pageId).toBe('p');
  expect(useBrowserPanel.getState().error).toBe('命令通道不可用');
});
