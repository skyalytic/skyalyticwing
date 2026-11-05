// 集中式数据加载服务（对齐旧版 data-loader.js）：并行批量拉取 30+ 端点
// 传输层复用 api-client.ts（保留 stream/timeout/类型化错误优势）
import { create } from 'zustand';
import { apiClient } from './api-client';
import type {
  AgentInfo,
  ChannelStatusInfo,
  CronJob,
  LogEntry,
  PluginInfo,
  ToolListItem,
} from '@/types';

/** 集中数据切片（对应旧版 state 的各字段） */
export interface DataSlice {
  providers: unknown[];
  models: unknown[];
  channels: unknown[];
  channelStatus: Record<string, unknown>;
  channelLog: unknown[];
  agents: AgentInfo[];
  tools: ToolListItem[];
  sessions: unknown[];
  cronJobs: CronJob[];
  cronHistory: unknown[];
  usageData: Record<string, unknown>;
  logs: LogEntry[];
  approvals: unknown[];
  permissions: Record<string, unknown>;
  config: Record<string, unknown>;
  plugins: PluginInfo[];
  vectorsStats: Record<string, unknown>;
  vectorsList: { total?: number; entries?: unknown[] } | Record<string, unknown>;
  mcpServers: unknown[];
  mcpData: Record<string, unknown>;
  mcpLoopback: Record<string, unknown>;
  acpConfig: Record<string, unknown>;
  queueStats: Record<string, unknown>;
  workspaceFiles: Record<string, unknown>;
  skills: unknown[];
  remoteNodes: Record<string, unknown>;
  sandboxStatus: Record<string, unknown>;
  worktrees: Record<string, unknown>;
  fullStatus: Record<string, unknown>;
  bindings: unknown[];
  toolPolicies: unknown[];
  sandboxEnhanced: Record<string, unknown>;
  securityStatus: Record<string, unknown>;
  dreamStatus: Record<string, unknown>;
  marketplaceSources: unknown[];
  /** 最近一次加载是否失败（用于全局兜底提示） */
  loadError: boolean;
  loading: boolean;
  lastLoadedAt: number | null;
}

const EMPTY_SLICE: Omit<DataSlice, 'loadError' | 'loading' | 'lastLoadedAt'> = {
  providers: [],
  models: [],
  channels: [],
  channelStatus: {},
  channelLog: [],
  agents: [],
  tools: [],
  sessions: [],
  cronJobs: [],
  cronHistory: [],
  usageData: {},
  logs: [],
  approvals: [],
  permissions: {},
  config: {},
  plugins: [],
  vectorsStats: {},
  vectorsList: {},
  mcpServers: [],
  mcpData: {},
  mcpLoopback: {},
  acpConfig: {},
  queueStats: {},
  workspaceFiles: {},
  skills: [],
  remoteNodes: {},
  sandboxStatus: {},
  worktrees: {},
  fullStatus: {},
  bindings: [],
  toolPolicies: [],
  sandboxEnhanced: {},
  securityStatus: {},
  dreamStatus: {},
  marketplaceSources: [],
};

/** 全局数据 store（hook 与组件均可订阅） */
export const useDataStore = create<DataSlice & {
  set: (partial: Partial<DataSlice>) => void;
  reset: () => void;
}>()((set) => ({
  ...EMPTY_SLICE,
  loadError: false,
  loading: false,
  lastLoadedAt: null,
  set: (partial) => set(partial as Partial<DataSlice>),
  reset: () => set({ ...EMPTY_SLICE, loadError: false, loading: false, lastLoadedAt: null }),
}));

/** 安全提取数组字段 */
function arr<T = unknown>(d: unknown, ...keys: string[]): T[] {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  const o = d as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}

let modelRefreshGeneration = 0;
export async function refreshModelData(): Promise<void> {
  const generation = ++modelRefreshGeneration;
  const [providers, models] = await Promise.all([apiClient.get('/providers'), apiClient.get('/models')]);
  if (generation === modelRefreshGeneration) useDataStore.getState().set({ providers: arr(providers, 'providers'), models: arr(models, 'models') });
}

/** 并行批量拉取 30+ 端点（对齐旧版 loadData） */
export async function loadData(): Promise<void> {
  const store = useDataStore.getState();
  store.set({ loading: true, loadError: false });
  // 各端点失败计数（catch 吞掉异常后 allSettled 恒为 fulfilled，需手动计数）
  let failedCount = 0;
  const fail = (label: string, e: unknown): void => {
    // A plan/role denial is an unavailable feature, not a lost server connection.
    if (e && typeof e === 'object' && 'status' in e && e.status === 403) return;
    failedCount++;
    console.warn(`load ${label} failed`, e);
  };

  const tasks: Promise<void>[] = [
    apiClient
      .get<{ providers?: unknown[] } | unknown[]>('/providers')
      .then((d) => useDataStore.getState().set({ providers: arr(d, 'providers') }))
      .catch((e) => { fail('providers', e); }),
    apiClient
      .get<{ models?: unknown[] } | unknown[]>('/models')
      .then((d) => useDataStore.getState().set({ models: arr(d, 'models') }))
      .catch((e) => { fail('models', e); }),
    apiClient
      .get<{ channels?: unknown[] } | unknown[]>('/channels')
      .then((d) => useDataStore.getState().set({ channels: arr(d, 'channels') }))
      .catch((e) => { fail('channels', e); }),
    apiClient
      .get<Record<string, unknown>>('/channels/status')
      .then((d) =>
        useDataStore.getState().set({
          // 后端 channelsService.getAllStatus() 直接返回 Record<type, snapshot>
          channelStatus: (d ?? {}) as Record<string, unknown>,
          channelLog: (d as { messageLog?: unknown[] })?.messageLog ?? [],
        }),
      )
      .catch((e) => { useDataStore.getState().set({ channelStatus: {}, channelLog: [] }); fail('channels/status', e); }),
    apiClient
      .get<{ agents?: AgentInfo[] } | AgentInfo[]>('/agents')
      .then((d) => useDataStore.getState().set({ agents: arr<AgentInfo>(d, 'agents') }))
      .catch((e) => { fail('agents', e); }),
    apiClient
      .get<{ tools?: ToolListItem[] } | ToolListItem[]>('/tools')
      .then((d) => useDataStore.getState().set({ tools: arr<ToolListItem>(d, 'tools') }))
      .catch((e) => { fail('tools', e); }),
    apiClient
      .get<{ sessions?: unknown[] } | unknown[]>('/sessions')
      .then((d) => useDataStore.getState().set({ sessions: arr(d, 'sessions') }))
      .catch((e) => { fail('sessions', e); }),
    apiClient
      .get<{ jobs?: CronJob[]; history?: unknown[] } | CronJob[]>('/cron')
      .then((d) =>
        useDataStore.getState().set({
          cronJobs: arr<CronJob>(d, 'jobs'),
          cronHistory: (d as { history?: unknown[] })?.history ?? [],
        }),
      )
      .catch((e) => { fail('cron', e); }),
    apiClient
      .get<Record<string, unknown>>('/usage')
      .then((d) => useDataStore.getState().set({ usageData: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('usage', e); }),
    apiClient
      .get<{ logs?: LogEntry[] } | LogEntry[]>('/monitor/logs')
      .then((d) => useDataStore.getState().set({ logs: arr<LogEntry>(d, 'logs') }))
      .catch((e) => { fail('logs', e); }),
    apiClient
      .get<{ approvals?: unknown[] } | unknown[]>('/approvals')
      .then((d) => useDataStore.getState().set({ approvals: arr(d, 'approvals') }))
      .catch((e) => { fail('approvals', e); }),
    apiClient
      .get<Record<string, unknown>>('/permissions')
      .then((d) => useDataStore.getState().set({ permissions: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('permissions', e); }),
    apiClient
      .get<Record<string, unknown>>('/config')
      .then((d) => useDataStore.getState().set({ config: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('config', e); }),
    apiClient
      .get<{ plugins?: PluginInfo[] } | PluginInfo[]>('/plugins')
      .then((d) => useDataStore.getState().set({ plugins: arr<PluginInfo>(d, 'plugins') }))
      .catch((e) => { fail('plugins', e); }),
    apiClient
      .get<Record<string, unknown>>('/vectors/stats')
      .then((d) => useDataStore.getState().set({ vectorsStats: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('vectors/stats', e); }),
    apiClient
      .get<{ total?: number; entries?: unknown[] } | Record<string, unknown>>('/vectors/list')
      .then((d) => useDataStore.getState().set({ vectorsList: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('vectors/list', e); }),
    apiClient
      .get<{ servers?: unknown[] } | Record<string, unknown>>('/mcp/servers')
      .then((d) =>
        useDataStore.getState().set({
          mcpServers: arr(d, 'servers'),
          mcpData: (d ?? {}) as Record<string, unknown>,
        }),
      )
      .catch((e) => { fail('mcp/servers', e); }),
    apiClient
      .get<Record<string, unknown>>('/mcp/loopback/status')
      .then((d) => useDataStore.getState().set({ mcpLoopback: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('mcp/loopback', e); }),
    apiClient
      .get<Record<string, unknown>>('/acp/status')
      .then((d) => useDataStore.getState().set({ acpConfig: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { useDataStore.getState().set({ acpConfig: {} }); fail('acp/status', e); }),
    apiClient
      .get<Record<string, unknown>>('/queue/stats')
      .then((d) => useDataStore.getState().set({ queueStats: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('queue/stats', e); }),
    apiClient
      .get<{ files?: Record<string, unknown>; skills?: unknown[] }>('/workspace')
      .then((d) =>
        useDataStore.getState().set({
          workspaceFiles: (d as { files?: Record<string, unknown> })?.files ?? {},
          skills: (d as { skills?: unknown[] })?.skills ?? [],
        }),
      )
      .catch((e) => { fail('workspace', e); }),
    apiClient
      .get<Record<string, unknown>>('/remote/nodes')
      .then((d) => useDataStore.getState().set({ remoteNodes: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('remote/nodes', e); }),
    apiClient
      .get<Record<string, unknown>>('/sandbox/status')
      .then((d) => useDataStore.getState().set({ sandboxStatus: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('sandbox/status', e); }),
    apiClient
      .get<Record<string, unknown>>('/worktrees')
      .then((d) => useDataStore.getState().set({ worktrees: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('worktrees', e); }),
    apiClient
      .get<Record<string, unknown>>('/status/full')
      .then((d) => useDataStore.getState().set({ fullStatus: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { fail('status/full', e); }),
    apiClient
      .get<unknown[] | { bindings?: unknown[] }>('/bindings')
      .then((d) => useDataStore.getState().set({ bindings: arr(d, 'bindings') }))
      .catch((e) => { useDataStore.getState().set({ bindings: [] }); fail('bindings', e); }),
    apiClient
      .get<unknown[] | { policies?: unknown[] }>('/tool-policies')
      .then((d) => useDataStore.getState().set({ toolPolicies: arr(d, 'policies') }))
      .catch((e) => { useDataStore.getState().set({ toolPolicies: [] }); fail('tool-policies', e); }),
    apiClient
      .get<Record<string, unknown>>('/sandbox-enhanced')
      .then((d) => useDataStore.getState().set({ sandboxEnhanced: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { useDataStore.getState().set({ sandboxEnhanced: {} }); fail('sandbox-enhanced', e); }),
    apiClient
      .get<Record<string, unknown>>('/security/status')
      .then((d) => useDataStore.getState().set({ securityStatus: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { useDataStore.getState().set({ securityStatus: {} }); fail('security/status', e); }),
    apiClient
      .get<Record<string, unknown>>('/memory/dream/status')
      .then((d) => useDataStore.getState().set({ dreamStatus: (d ?? {}) as Record<string, unknown> }))
      .catch((e) => { useDataStore.getState().set({ dreamStatus: {} }); fail('memory/dream/status', e); }),
    apiClient
      .get<{ sources?: unknown[] } | Record<string, unknown>>('/skill-marketplace/sources')
      .then((d) => useDataStore.getState().set({ marketplaceSources: arr(d, 'sources') }))
      .catch((e) => { useDataStore.getState().set({ marketplaceSources: [] }); fail('skill-marketplace/sources', e); }),
  ];

  // allSettled 恒不抛出；失败数经 fail() 计数，>0 时置 loadError
  await Promise.allSettled(tasks);
  useDataStore.getState().set({
    loading: false,
    loadError: failedCount > 0,
    lastLoadedAt: Date.now(),
  });
  if (failedCount > 0) {
    console.warn(`[DataLoader] ${failedCount} endpoints failed to load`);
  }
}

/** 按视图定向加载（对齐旧版 loadViewData） */
export async function loadViewData(view: string): Promise<void> {
  const S = useDataStore.getState();
  const set = S.set;
  const safe = <T,>(p: Promise<T>, fallback?: () => void): Promise<void> =>
    p.then(() => undefined).catch(() => fallback?.());

  switch (view) {
    case 'sessions':
      await safe(apiClient.get('/sessions').then((d) => set({ sessions: arr(d, 'sessions') })));
      break;
    case 'agents':
      await safe(apiClient.get('/agents').then((d) => set({ agents: arr<AgentInfo>(d, 'agents') })));
      break;
    case 'channels':
      await safe(
        apiClient.get<Record<string, unknown>>('/channels/status').then((d) =>
          set({
            // 后端 getAllStatus() 直接返回 Record<type, snapshot>
            channelStatus: (d ?? {}) as Record<string, unknown>,
            channelLog: (d as { messageLog?: unknown[] })?.messageLog ?? [],
          }),
        ),
      );
      break;
    case 'protocols':
    case 'mcp':
      await Promise.allSettled([
        apiClient.get('/mcp/servers').then((d) =>
          set({ mcpServers: arr(d, 'servers'), mcpData: (d ?? {}) as Record<string, unknown> }),
        ),
        apiClient.get<Record<string, unknown>>('/mcp/loopback/status').then((d) => set({ mcpLoopback: (d ?? {}) as Record<string, unknown> })),
        apiClient.get<Record<string, unknown>>('/acp/status').then((d) => set({ acpConfig: (d ?? {}) as Record<string, unknown> })),
      ]);
      break;
    case 'memory':
      await Promise.allSettled([
        apiClient.get<Record<string, unknown>>('/memory/dream/status').then((d) => set({ dreamStatus: (d ?? {}) as Record<string, unknown> })),
        apiClient.get<Record<string, unknown>>('/vectors/stats').then((d) => set({ vectorsStats: (d ?? {}) as Record<string, unknown> })),
      ]);
      break;
    case 'skills':
    case 'marketplace':
      await Promise.allSettled([
        apiClient.get('/workspace').then((d) =>
          set({ skills: (d as { skills?: unknown[] })?.skills ?? [] }),
        ),
        apiClient
          .get('/skill-marketplace/sources')
          .then((d) => set({ marketplaceSources: arr(d, 'sources') })),
      ]);
      break;
    case 'settings':
    case 'config':
    case 'dashboard':
    case 'security':
    case 'tools':
    case 'plugins':
      await safe(apiClient.get<Record<string, unknown>>('/config').then((d) => set({ config: (d ?? {}) as Record<string, unknown> })));
      break;
    case 'monitor':
      await safe(apiClient.get<Record<string, unknown>>('/queue/list').then((d) => set({ queueStats: (d ?? {}) as Record<string, unknown> })));
      break;
    case 'cron':
      await safe(
        apiClient.get('/cron').then((d) =>
          set({
            cronJobs: arr<CronJob>(d, 'jobs'),
            cronHistory: (d as { history?: unknown[] })?.history ?? [],
          }),
        ),
      );
      break;
    case 'usage':
      await safe(apiClient.get<Record<string, unknown>>('/usage').then((d) => set({ usageData: (d ?? {}) as Record<string, unknown> })));
      break;
    case 'worktrees':
      await safe(apiClient.get<Record<string, unknown>>('/worktrees').then((d) => set({ worktrees: (d ?? {}) as Record<string, unknown> })));
      break;
    case 'remote':
      await safe(apiClient.get<Record<string, unknown>>('/remote/nodes').then((d) => set({ remoteNodes: (d ?? {}) as Record<string, unknown> })));
      break;
    default:
      break;
  }
}

/** 执行工具（对齐旧版 executeCurrentTool：POST /api/tool/execute） */
export async function executeCurrentTool(
  toolId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return apiClient.post('/tool/execute', { tool: toolId, args }, { timeoutMs: 180_000 });
}

/** 拉取日志（对齐旧版 loadLogs） */
export async function loadLogs(): Promise<void> {
  try {
    const d = await apiClient.get<{ logs?: LogEntry[] } | LogEntry[]>('/monitor/logs');
    useDataStore.getState().set({ logs: arr<LogEntry>(d, 'logs') });
  } catch (e) {
    console.warn('load logs failed', e);
  }
}
