import { nativeInvoke } from '@/services/native-browser';
import { PERMISSION_CHOICES, PermissionModePicker } from '@/components/chat/PermissionModePicker';
import { workbenchLocale } from '@/i18n/workbench-text';
// 设置页面：个性化 / 运行状态 / 安全 / 模型 / 工具 / 外部接入 / 高级
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/ui/Toast';
import {
  ToolPolicyCreateModal,
  type ToolPolicyFormValues,
} from '../../components/modals/ToolPolicyCreateModal';
import { showConfirm } from '../../components/modals/ConfirmDialog';
import { changeLanguage } from '../../i18n';
import { authHeaders, getAuthToken, setAuthToken } from '../../services/auth-token';
import { isTauri, isAutostartEnabled, setAutostart } from '../../services/tauri-bridge';
import {
  readLocalSettings,
  saveLocalSettings,
  PREFERENCES_CHANGED,
  type PersonalizeSettings,
} from '@/utils/local-preferences';
import { applyStartupSettings, applyUiZoom } from '@/utils/apply-settings';
import { providerBrand, providerSvg } from './provider-icons';
// 工具管理统一复用 /tools 路由的 ToolsPage（消除设置页内嵌的第二套实现）
import { ToolsPage } from '@/modules/tools/ToolsPage';
// 监控 / 插件同样统一复用独立路由页组件
import { MonitorPage } from '@/modules/monitor/MonitorPage';
import { ProtocolsPage } from '@/modules/protocols/ProtocolsPage';
import { DaemonPage } from '@/modules/daemon/DaemonPage';
import { ModelCapabilities, emptyCapabilities, type CapabilityForm } from './ModelCapabilities';
import { ProviderTemplateInfo, type ProviderCatalogInfo } from './ProviderTemplateInfo';
import './model-settings.css';

/* ────────────────────────────── 类型 ────────────────────────────── */

interface SecurityConfig {
  approvalMode: 'auto' | 'ask' | 'yolo';
  pathWhitelist: string[];
  commandWhitelist: string[];
  ssrfProtection: boolean;
}

interface Provider {
  id: string;
  name: string;
  displayName?: string;
  apiKey?: string;
  maskedApiKey?: string;
  hasApiKey?: boolean;
  baseUrl?: string;
  models: string[];
  configured?: boolean;
  type?: string;
  region?: string;
  envKey?: string;
  maxTokens?: number;
  temperature?: number;
  vision?: boolean;
  local?: boolean;
  requiresApiKey?: boolean;
  /** 多实例条目的所属注册表厂商 ID（openai_2 → openai）；有值即为实例 */
  baseProvider?: string;
  visionModels?: string[];
  imageModels?: string[];
  videoModels?: string[];
  imageProtocol?: string;
  videoProtocol?: string;
  imageBaseUrl?: string;
  videoBaseUrl?: string;
  catalog?: ProviderCatalogInfo;
  preset?: Pick<Provider, 'baseUrl' | 'models' | 'visionModels' | 'imageModels' | 'videoModels' | 'imageProtocol' | 'videoProtocol' | 'imageBaseUrl' | 'videoBaseUrl'>;
}

interface Msg {
  text: string;
  ok: boolean;
}

/* ────────────────────── Provider 品牌图标（原版 logo，全量移植自旧版 config.js）────────────────────── */

/** 品牌图标：优先原版 SVG，回退品牌色首字母 */
function ProviderIcon({ id, size = 32 }: { id: string; size?: number }) {
  useWorkbenchLanguage();
  const brand = providerBrand(id);
  const svg = providerSvg(id);
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg shrink-0"
      style={{ width: size, height: size, background: '#f3f5f7', color: brand.bg }}
    >
      {svg ? (
        <span
          style={{ width: size * 0.7, height: size * 0.7, display: 'inline-flex' }}
          dangerouslySetInnerHTML={{
            __html: svg.replace('<svg', `<svg width="${size * 0.7}" height="${size * 0.7}"`),
          }}
        />
      ) : (
        <span className="text-xs font-bold" style={{ fontSize: size * 0.38 }}>
          {brand.label.charAt(0)}
        </span>
      )}
    </span>
  );
}

function providerName(p: Provider): string {
  return p.displayName || wt(p.name || p.id);
}

/* ────────────────────────────── 工具函数 ────────────────────────────── */

/**
 * fetch 封装：统一解包后端 {success, data} 包装。
 * - 响应体为 ApiResponse 形状（含 success 字段的对象）时返回 data；
 *   success=false 视为业务失败，抛出 error 信息。
 * - 非包装响应（裸数组/对象/文本）原样返回。
 * - options.raw = true 时跳过解包，直接返回原始 JSON（逃生通道）。
 */
async function apiFetch<T = any>(
  url: string,
  options: RequestInit & { raw?: boolean } = {},
): Promise<T> {
  const { raw, ...init } = options;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const txt = await res.text();
      if (txt) detail = txt.length > 200 ? txt.slice(0, 200) : txt;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const text = await res.text();
  if (!text) return {} as T;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return text as unknown as T;
  }
  if (raw) return json as T;
  if (json !== null && typeof json === 'object' && !Array.isArray(json) && 'success' in json) {
    const wrapped = json as { success?: boolean; data?: unknown; error?: string };
    if (wrapped.success === false) {
      throw new Error(wrapped.error || wt('请求失败: {{v0}}', { v0: url }));
    }
    return (wrapped.data ?? {}) as T;
  }
  return json as T;
}

function formatUptime(sec?: number): string {
  if (!sec || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}h ${m}m`;
}

function formatMemory(mb?: number): string {
  if (mb == null) return '--';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}

function formatNumber(n?: number): string {
  if (n == null) return '--';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/** 界面缩放按钮组（O 字号调节）：body zoom 即时生效，localStorage 持久化 */
function ZoomButtons() {
  useWorkbenchLanguage();
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('sky-ui-zoom') ?? '1'));
  const apply = (z: number) => {
    setZoom(z);
    localStorage.setItem('sky-ui-zoom', String(z));
    applyUiZoom(z);
  };
  const opts: Array<[string, number]> = [
    [wt('小'), 0.9],
    [wt('标准'), 1],
    [wt('大'), 1.1],
    [wt('特大'), 1.2],
  ];
  return (
    <div className="flex gap-1">
      {opts.map(([label, z]) => (
        <button
          key={label}
          className={`text-xs px-2 py-1 rounded border ${
            zoom === z
              ? 'border-blue-500 text-blue-400 bg-blue-500/10'
              : 'border-gray-700 text-gray-400 hover:bg-white/5'
          }`}
          onClick={() => apply(z)}
        >
          {wt(label)}
        </button>
      ))}
    </div>
  );
}

/* ────────────────────────────── 通用展示组件 ────────────────────────────── */

function Loading({ label = wt('加载中…') }: { label?: string }) {
  useWorkbenchLanguage();
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-gray-400">
      <span className="spinner" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  useWorkbenchLanguage();
  return (
    <div className="empty-state">
      <div className="opacity-30 mb-2">
        <Icon name={icon} size={48} />
      </div>
      <div>{text}</div>
    </div>
  );
}

function Feedback({ msg }: { msg: Msg | null }) {
  useWorkbenchLanguage();
  if (!msg) return null;
  return (
    <div className={`text-xs mt-3 ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: string;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  useWorkbenchLanguage();
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between">
        <div className="stat-label">{label}</div>
        <Icon name={icon} size={16} />
      </div>
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub ? <div className="text-xs text-gray-500 mt-1">{sub}</div> : null}
    </div>
  );
}

/* ────────────────────────────── 主页面 ────────────────────────────── */

const TABS: Array<{ id: string; labelKey?: string; label?: string; icon: string }> = [
  { id: 'personalize', labelKey: 'settings.personalize', icon: 'moon' },
  { id: 'status', label: '运行状态', icon: 'heartbeat' },
  { id: 'security', labelKey: 'settings.security', icon: 'shield' },
  { id: 'models', labelKey: 'settings.modelsProviders', icon: 'config' },
  { id: 'tools', labelKey: 'settings.tools', icon: 'tool' },
  { id: 'protocols', label: '外部应用接入 Wing', icon: 'zap' },
  { id: 'advanced', label: '高级', icon: 'settings' },
];

export function SettingsPage() {
  useWorkbenchLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const tab = searchParams.get('tab') || 'personalize';
  const switchTab = (next: string) => setSearchParams({ tab: next }, { replace: true });

  if (tab === 'plugins') return <Navigate to="/plugins" replace />;
  if (tab === 'dashboard' || tab === 'monitor' || tab === 'daemon') {
    const canonical = new URLSearchParams(searchParams);
    canonical.set('tab', tab === 'daemon' ? 'advanced' : 'status');
    if (tab === 'monitor') canonical.set('details', 'monitor');
    return <Navigate to={`/settings?${canonical}`} replace />;
  }
  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="settings" size={20} /> {t('settings.title')}
        </h2>
      </div>
      <div className="flex gap-2 mb-4 border-b border-gray-700 overflow-x-auto">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.id}
            aria-pressed={tab === tabItem.id}
            className={`tab-btn ${tab === tabItem.id ? 'active' : ''}`}
            onClick={() => switchTab(tabItem.id)}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name={tabItem.icon} size={14} /> {tabItem.labelKey ? t(tabItem.labelKey) : wt(tabItem.label!)}
            </span>
          </button>
        ))}
      </div>
      <div>
        {tab === 'personalize' && <PersonalizeTab />}
        {tab === 'status' && <RuntimeStatusTab />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'tools' && <ToolsPage />}
        {tab === 'protocols' && <ProtocolsPage />}
        {tab === 'advanced' && (<DaemonPage embedded />
        )}
      </div>
    </div>
  );
}

function RuntimeStatusTab() {
  useWorkbenchLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const expanded = searchParams.get('details') === 'monitor';
  return (
    <div>
      <DashboardTab />
      <section className="card mt-4">
        <button
          className="w-full flex items-center justify-between gap-2 text-left"
          aria-expanded={expanded}
          aria-controls="runtime-monitor-details"
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            if (expanded) next.delete('details');
            else next.set('details', 'monitor');
            setSearchParams(next, { replace: true });
          }}
        >
          <span className="font-bold">{wt('详细监控与日志')}</span>
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
        <p className="text-sm text-muted mt-2">{wt('查看实时指标、工具调用、词元用量与最近日志。')}</p>
        {expanded && <div id="runtime-monitor-details" className="mt-4"><MonitorPage embedded /></div>}
      </section>
    </div>
  );
}

/* ────────────────────────────── 个性化 ────────────────────────────── */

/** 个性化设置（对齐旧版 settings.js personalize 标签，持久化到 localStorage 'app.settings'） */
function PersonalizeTab() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PersonalizeSettings>(readLocalSettings);
  useEffect(() => {
    const refresh = () => setSettings(readLocalSettings());
    applyStartupSettings();
    window.addEventListener(PREFERENCES_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PREFERENCES_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  // 桌面端开机自启动状态（注册表 Run 项；浏览器开发模式无此概念）
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);

  // 桌面端：读取开机自启动状态（仅 Tauri 环境有意义）
  useEffect(() => {
    if (!isTauri()) return;
    void isAutostartEnabled().then(setAutostartOn);
  }, []);

  /** 切换开机自启动：写/删注册表 Run 项；失败时回滚开关并提示 */
  const toggleAutostart = async (v: boolean) => {
    if (autostartBusy) return;
    setAutostartBusy(true);
    try {
      const ok = await setAutostart(v);
      if (ok) {
        setAutostartOn(v);
        toast.success(wt(v ? '已开启开机自启动' : '已关闭开机自启动'));
      } else {
        toast.error(wt('设置失败'), wt('请检查应用权限或重新安装'));
      }
    } finally {
      setAutostartBusy(false);
    }
  };

  const update = (patch: Partial<PersonalizeSettings>) => {
    setSettings(saveLocalSettings(patch));
    applyStartupSettings();
    if (patch.interfaceLang !== undefined) {
      void changeLanguage(patch.interfaceLang);
    }
  };

  const themeOptions: Array<{ id: PersonalizeSettings['theme']; icon: string; label: string }> = [
    { id: 'dark', icon: 'moon', label: t('settings.darkMode') },
    { id: 'light', icon: 'sun', label: t('settings.lightMode') },
    { id: 'system', icon: 'monitor', label: t('settings.followSystem') },
  ];

  const toggleRow = (
    label: string,
    value: boolean,
    onChange: (v: boolean) => void,
    desc?: string,
  ) => (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-400">
        {label}
        {desc ? <span className="text-gray-600 ml-2">{desc}</span> : null}
      </span>
      <div
        className={`switch ${value ? 'on' : ''}`}
        role="switch"
        aria-label={label}
        tabIndex={0}
        aria-checked={value}
        onClick={() => onChange(!value)}
        onKeyDown={e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();onChange(!value);}}}
      />
    </div>
  );

  return (
    <div className="space-y-3">
      {/* 主题 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="moon" size={16} /> {t('settings.themeCard')}
        </h3>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.id}
              aria-pressed={settings.theme === opt.id}
              className={`p-4 rounded-lg border-2 text-center transition-all ${
                settings.theme === opt.id
                  ? 'border-cyan-400 bg-cyan-900/30 shadow-lg shadow-cyan-500/20'
                  : 'border-gray-600 bg-gray-800/50 hover:border-gray-500'
              }`}
              onClick={() => update({ theme: opt.id })}
            >
              <div className="mb-1 flex justify-center">
                <Icon name={opt.icon} size={24} />
              </div>
              <div className="text-xs">{opt.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 字号 + 紧凑模式 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="edit" size={16} /> {t('settings.interfaceCard')}
        </h3>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">{t('settings.fontSizeLabel')}</span>
          <span className="text-xs text-cyan-400">{settings.fontSize}px</span>
        </div>
        <input
          type="range"
          aria-label={t('settings.fontSizeLabel')}
          aria-valuetext={`${settings.fontSize}px`}
          min={12}
          max={20}
          value={settings.fontSize}
          className="w-full"
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
        />
        <div className="mt-3 space-y-2">
          {toggleRow(t('settings.compactMode'), settings.compactMode, (v) =>
            update({ compactMode: v }),
          )}
          {toggleRow(t('settings.sendOnEnter'), settings.sendOnEnter, (v) =>
            update({ sendOnEnter: v }),
          )}
          {toggleRow(t('settings.showTimestamps'), settings.showTimestamps, (v) =>
            update({ showTimestamps: v }),
          )}
          {toggleRow(t('settings.autoContinue'), settings.autoContinue, (v) =>
            update({ autoContinue: v }),
          )}
        </div>
      </div>

      {/* 对话 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="agent" size={16} /> {t('settings.chatCard')}
        </h3>
        <div className="mb-3">{toggleRow(wt('任务先规划，确认后执行'), settings.planMode, (v) => update({planMode:v}))}</div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">{t('settings.maxIterations')}</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={10}
              max={500}
              value={settings.maxIterations}
              className="input-field w-20 text-sm text-center"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) update({ maxIterations: Math.min(500, Math.max(10, n)) });
              }}
            />
            <span className="text-xs text-gray-500">10-500</span>
          </div>
        </div>
      </div>

      {/* 启动（仅桌面端显示；开机自启动桌面应用，静默最小化到托盘） */}
      {isTauri() && (
        <div className="card">
          <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
            <Icon name="zap" size={16} /> {wt('启动')}
          </h3>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {wt('开机自启动')}
              <span className="text-gray-600 ml-2">{wt('开机后自动启动并最小化到系统托盘')}</span>
            </span>
            <div
              className={`switch ${autostartOn ? 'on' : ''}`}
              role="switch"
              aria-checked={autostartOn}
              aria-busy={autostartBusy}
              onClick={() => void toggleAutostart(!autostartOn)}
            />
          </div>
        </div>
      )}

      {/* 界面缩放（字号调节：body zoom，即时生效并持久化） */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="usage" size={16} /> {wt('界面缩放')}
        </h3>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">{wt('整体界面字号缩放')}</span>
          <ZoomButtons />
        </div>
      </div>

      {/* 语言 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="globe" size={16} /> {t('settings.languageCard')}
        </h3>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">{t('settings.language')}</span>
          <select
            className="input-field text-sm w-40"
            value={settings.interfaceLang}
            onChange={(e) =>
              update({ interfaceLang: e.target.value as PersonalizeSettings['interfaceLang'] })
            }
          >
            <option value="zh-CN">{t('langs.zhCN')}</option>
            <option value="en">{t('langs.en')}</option>
            <option value="auto">{t('settings.followSystem')}</option>
          </select>
        </div>
      </div>

      {/* 沙箱模式（三级档位 + 权限预设） */}
      <SandboxModeCard />
    </div>
  );
}

/* ────────────────────────────── 仪表盘 ────────────────────────────── */

/** 沙箱档位卡：集中配置文件和命令执行权限：
 *  read-only 只读 / workspace-write 工作区 / danger-full-access 全权，
 *  被拦截的调用会走现有审批弹窗（一次性提权） */
function SandboxModeCard() {
  useWorkbenchLanguage();
  const [config, setConfig] = useState<{ mode: string; presetId: string | null } | null>(null);
  const [presets, setPresets] = useState<
    Array<{ id: string; name: string; description: string; mode: string }>
  >([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [profileRes, presetsRes] = await Promise.allSettled([
        fetch('/api/sandbox/profile', { headers: authHeaders() }),
        fetch('/api/sandbox/presets', { headers: authHeaders() }),
      ]);
      if (profileRes.status === 'fulfilled' && profileRes.value.ok) {
        const json = await profileRes.value.json().catch(() => null);
        if (json?.data?.config) setConfig(json.data.config);
      }
      if (presetsRes.status === 'fulfilled' && presetsRes.value.ok) {
        const json = await presetsRes.value.json().catch(() => null);
        if (Array.isArray(json?.data?.presets)) setPresets(json.data.presets);
      }
    } catch {
      /* 配置加载失败不阻塞页面 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/sandbox/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) throw new Error(json?.error || `HTTP ${res.status}`);
      // 预设应用后本地同步 presetId（后端 setProfile 返回的 config 已带）
      await load();
      toast.success(wt('沙箱档位已更新，新档位对后续工具调用生效'));
    } catch (e) {
      toast.error(wt('更新失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const MODE_LABELS: Record<string, string> = {
    'read-only': wt('只读'),
    'workspace-write': wt('工作区'),
    'danger-full-access': wt('全权'),
  };

  return (
    <div className="card">
      <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
        <Icon name="sandbox" size={16} /> {wt('沙箱模式')}
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        {wt('三级档位控制 AI 工具调用面：被拦截的调用会弹出一次性提权审批，批准仅对该次调用生效。')}
      </p>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {(['read-only', 'workspace-write', 'danger-full-access'] as const).map((m) => (
          <button
            key={m}
            className={
              'text-xs px-2 py-2 rounded border ' +
              (config?.mode === m
                ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
                : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:bg-gray-800')
            }
            disabled={busy}
            onClick={() => void apply({ mode: m })}
          >
            {wt(MODE_LABELS[m] ?? m)}
            <span className="block text-[10px] text-gray-500 mt-0.5 font-mono">{m}</span>
          </button>
        ))}
      </div>
      {presets.length > 0 ? (
        <div>
          <div className="text-xs text-gray-500 mb-1.5">{wt('权限预设（档位捆绑包）：')}</div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.id}
                title={wt(p.description)}
                className={
                  'text-xs px-2.5 py-1 rounded-full border ' +
                  (config?.presetId === p.id
                    ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
                    : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:bg-gray-800')
                }
                disabled={busy}
                onClick={() => void apply({ presetId: p.id })}
              >
                {wt(p.name)} ({wt(MODE_LABELS[p.mode] ?? p.mode)})
              </button>
            ))}
            {config?.presetId ? null : (
              <span className="text-[10px] text-gray-600 self-center">
                {wt('当前：自定义档位')}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DashboardTab() {
  useWorkbenchLanguage();
  const [data, setData] = useState<{ health: any; mon: any } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [h, s] = await Promise.allSettled([
      apiFetch<any>('/api/monitor/health'),
      apiFetch<any>('/api/monitor/stats'),
    ]);
    setData({
      health: h.status === 'fulfilled' ? h.value : {},
      mon: s.status === 'fulfilled' ? s.value : {},
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <Loading />;
  if (!data) return <EmptyState icon="dashboard" text={wt('暂无数据')} />;

  const { health, mon } = data;
  const uptime = health?.uptime ?? mon?.uptime;
  // 后端 MonitorStats.memory 为 NodeJS.MemoryUsage 对象（rss 单位字节）
  const memMB =
    mon?.memoryUsageMB ??
    (mon?.memory && typeof mon.memory === 'object' ? mon.memory.rss / 1048576 : mon?.memory);
  const memory = memMB != null && typeof memMB === 'number' ? Math.round(memMB) : undefined;
  const cpu = mon?.cpu ?? mon?.cpuUsage;
  const sessions = mon?.sessions ?? mon?.activeSessions;
  const messages = mon?.messages;
  const toolCount = typeof mon?.tools === 'object' ? mon?.tools?.total : mon?.tools;
  const pluginCount = typeof mon?.plugins === 'object' ? mon?.plugins?.totalLoaded : mon?.plugins;

  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <Icon name="dashboard" size={18} /> {wt('系统概览')}
        </h3>
        <button className="btn-secondary text-sm" onClick={load}>
          <span className="inline-flex items-center gap-1">
            <Icon name="refresh" size={12} /> {wt('刷新')}
          </span>
        </button>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-4 gap-3">
        <StatCard
          icon="heartbeat"
          label={wt('运行时间')}
          value={formatUptime(uptime)}
          color="var(--accent)"
        />
        <StatCard
          icon="usage"
          label={wt('内存使用')}
          value={formatMemory(memory)}
          color="var(--success)"
        />
        <StatCard
          icon="ops"
          label={wt('CPU 使用率')}
          value={cpu != null ? `${Number(cpu).toFixed(1)}%` : '--'}
          color="var(--warning)"
        />
        <StatCard
          icon="session"
          label={wt('活跃会话')}
          value={formatNumber(sessions)}
          color="var(--accent)"
        />
        <StatCard
          icon="chat"
          label={wt('消息总数')}
          value={formatNumber(messages)}
          color="var(--success)"
        />
        <StatCard
          icon="tool"
          label={wt('工具数量')}
          value={formatNumber(toolCount)}
          color="var(--accent)"
        />
        <StatCard
          icon="plugin"
          label={wt('插件数量')}
          value={formatNumber(pluginCount)}
          color="var(--warning)"
        />
        <StatCard
          icon="remote"
          label={wt('WebSocket 连接')}
          value={formatNumber(mon?.activeConnections ?? mon?.websockets ?? mon?.connections)}
          color="var(--accent)"
        />
      </div>

      <div className="card mt-4">
        <h3 className="font-bold mb-2 flex items-center gap-1.5">
          <Icon name="monitor" size={16} /> {wt('版本信息')} {isTauri() && <button className="btn" onClick={() => { void nativeInvoke('check_for_updates', {}).catch(() => {}); }}>{wt('检查更新')}</button>}
        </h3>
        <div className="text-sm text-gray-400">
          {health?.version ? (
            <span>
              {wt('当前版本：')}
              <span className="text-blue-400 font-mono">{health.version}</span>
            </span>
          ) : (
            <span className="text-gray-500">{wt('未获取到版本信息')}</span>
          )}
          {health?.status ? (
            <span className="ml-3">
              {wt('状态：')}
              <span
                className={`badge ${health.status === 'ok' ? 'badge-green' : health.status === 'degraded' ? 'badge-yellow' : 'badge-red'}`}
              >
                {health.status}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── 安全 ────────────────────────────── */

const SECURITY_SUBTABS: Array<{ id: string; label: string }> = [
  {
    id: 'overview',
    get label() {
      return wt('总览');
    },
  },
  {
    id: 'command',
    get label() {
      return wt('命令权限');
    },
  },
  {
    id: 'auth',
    get label() {
      return wt('访问鉴权');
    },
  },
  {
    id: 'sandbox',
    get label() {
      return wt('沙箱执行');
    },
  },
  {
    id: 'pairing',
    get label() {
      return wt('设备配对');
    },
  },
  {
    id: 'approvals',
    get label() {
      return wt('审批记录');
    },
  },
];

/** 安全模式（写 security.yolo，与后端 AgentLoop 安全闸门同源实时生效） */
const PERMISSION_MODES = PERMISSION_CHOICES.map(c => ({ id: c.id, label: wt(c.label), desc: wt(c.desc) }));

function SecurityTab() {
  useWorkbenchLanguage();
  const [secTab, setSecTab] = useState('overview');
  return (
    <div>
      <div className="flex gap-2 mb-4">
        {SECURITY_SUBTABS.map((t) => (
          <button
            key={t.id}
            className={`text-xs px-3 py-1.5 rounded ${secTab === t.id ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
            onClick={() => setSecTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {secTab === 'overview' && <SecurityOverview />}
      {secTab === 'command' && <SecurityCommand />}
      {secTab === 'auth' && <SecurityAuth />}
      {secTab === 'sandbox' && <SecuritySandbox />}
      {secTab === 'pairing' && <SecurityPairing />}
      {secTab === 'approvals' && <SecurityApprovals />}
    </div>
  );
}

/* ── 概览：安全扫描 + 密钥审计 ── */
interface ScanIssue {
  level?: string;
  file?: string;
  skill?: string;
  description?: string;
  suggestion?: string;
  message?: string;
}
function SecurityOverview() {
  useWorkbenchLanguage();
  const [skillName, setSkillName] = useState('');
  const [scanResult, setScanResult] = useState<ScanIssue[] | null>(null);
  const [secretResult, setSecretResult] = useState<string | ScanIssue[] | null>(null);
  const [busy, setBusy] = useState<'scan' | 'audit' | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);

  const scan = async () => {
    if (!skillName.trim()) {
      toast.warn(wt('请输入技能名称'));
      return;
    }
    setBusy('scan');
    setMsg(null);
    try {
      const r = await apiFetch<any>('/api/security/scan-skill', {
        method: 'POST',
        body: JSON.stringify({ skillName }),
      });
      // 后端 data = {skillName, safe, findings:[{file, rule, severity, desc}], totalFiles}
      const raw: any[] = r?.findings ?? r?.issues ?? (Array.isArray(r) ? r : []);
      const issues: ScanIssue[] = raw.map((f) => ({
        level: f.level ?? f.severity,
        file: f.file,
        description: f.description ?? f.desc ?? f.message,
        suggestion: f.suggestion ?? f.rule,
      }));
      setScanResult(issues);
      setMsg({ text: wt('扫描完成，发现 {{v0}} 个问题', { v0: issues.length }), ok: true });
    } catch (e) {
      setMsg({ text: wt('扫描失败: ') + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const audit = async () => {
    setBusy('audit');
    setMsg(null);
    try {
      const r = await apiFetch<any>('/api/security/audit', { method: 'POST' });
      // 后端 data = {findings:[{id, severity, area, description, fixable}], total, report}
      const raw: any[] = r?.findings ?? r?.issues ?? (Array.isArray(r) ? r : []);
      const issues: ScanIssue[] = raw.map((f) => ({
        level: f.level ?? f.severity,
        file: f.file ?? f.area,
        description: f.description ?? f.message,
        suggestion: f.suggestion ?? (f.fixable ? wt('可自动修复') : undefined),
      }));
      setSecretResult(issues.length ? issues : r?.report ? String(r.report) : JSON.stringify(r));
      setMsg({ text: wt('审计完成'), ok: true });
    } catch (e) {
      setMsg({ text: wt('审计失败: ') + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const levelColor = (lv?: string) => {
    const v = (lv || '').toLowerCase();
    return v === 'critical' || v === 'high' || v === 'error'
      ? 'text-red-400'
      : v === 'medium' || v === 'warn'
        ? 'text-yellow-400'
        : 'text-gray-400';
  };

  return (
    <div className="space-y-3">
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="search" size={16} /> {wt('安全扫描')}
        </h3>
        <div className="flex gap-2">
          <input
            className="input-field flex-1 text-sm"
            placeholder={wt('输入技能名称进行安全扫描...')}
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') scan();
            }}
          />
          <button className="btn-primary text-sm" onClick={scan} disabled={busy === 'scan'}>
            {busy === 'scan' ? wt('扫描中…') : wt('扫描')}
          </button>
        </div>
        {scanResult ? (
          <div className="mt-2 space-y-1">
            {scanResult.length === 0 ? (
              <div className="text-xs text-green-400">{wt('未发现安全问题')}</div>
            ) : (
              scanResult.map((s, i) => (
                <div key={i} className="bg-gray-800/50 rounded p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`font-bold ${levelColor(s.level)}`}>{s.level || 'info'}</span>
                    {s.file || s.skill ? (
                      <code className="text-blue-400">{s.file || s.skill}</code>
                    ) : null}
                  </div>
                  <div className="text-gray-300 mt-1">{s.description || s.message}</div>
                  {s.suggestion ? (
                    <div className="text-gray-500 mt-1">
                      {wt('修复建议:')}
                      {s.suggestion}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="shield" size={16} /> {wt('密钥审计')}
        </h3>
        <button className="btn-primary text-sm" onClick={audit} disabled={busy === 'audit'}>
          {busy === 'audit' ? wt('审计中…') : wt('运行审计')}
        </button>
        {secretResult ? (
          <div className="mt-2">
            {Array.isArray(secretResult) ? (
              secretResult.length === 0 ? (
                <div className="text-xs text-green-400">{wt('未发现密钥泄露')}</div>
              ) : (
                <div className="space-y-1">
                  {secretResult.map((s, i) => (
                    <div key={i} className="bg-gray-800/50 rounded p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`font-bold ${levelColor(s.level)}`}>
                          {s.level || 'warn'}
                        </span>
                        {s.file ? <code className="text-blue-400">{s.file}</code> : null}
                      </div>
                      <div className="text-gray-300 mt-1">{s.description || s.message}</div>
                      {s.suggestion ? (
                        <div className="text-gray-500 mt-1">
                          {wt('建议:')}
                          {s.suggestion}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            ) : (
              <pre className="text-xs text-gray-300 whitespace-pre-wrap">{secretResult}</pre>
            )}
          </div>
        ) : null}
      </div>
      <Feedback msg={msg} />
    </div>
  );
}

/* ── 命令权限：模式/分类测试/规则CRUD/权限规则/工具策略 ── */
function SecurityCommand() {
  useWorkbenchLanguage();
  const [modeSaving, setModeSaving] = useState(false);
  const [perms, setPerms] = useState<any>({
    mode: 'ask',
    commandRules: [],
    allow: [],
    deny: [],
    ask: [],
  });
  const [secStats, setSecStats] = useState<any>({});
  const [policies, setPolicies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [classifyCmd, setClassifyCmd] = useState('');
  const [classifyResult, setClassifyResult] = useState<any>(null);
  const [newRule, setNewRule] = useState({ command: '', type: 'allow', reason: '' });
  const [newPerm, setNewPerm] = useState({ tool: '', type: 'allow', reason: '' });
  const [policyOpen, setPolicyOpen] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const [p, s, tp] = await Promise.allSettled([
        apiFetch<any>('/api/permissions'),
        apiFetch<any>('/api/security/status'),
        apiFetch<any>('/api/tool-policies'),
      ]);
      if (p.status === 'fulfilled') setPerms(p.value || {});
      if (s.status === 'fulfilled') setSecStats(s.value || {});
      if (tp.status === 'fulfilled')
        setPolicies(Array.isArray(tp.value) ? tp.value : tp.value?.policies || []);
    } catch (e) {
      setMsg({ text: wt('加载失败: ') + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener('sky-permissions-changed', refresh);
    return () => window.removeEventListener('sky-permissions-changed', refresh);
  }, [load]);

  const switchMode = async (mode: string) => {
    setModeSaving(true);
    try {
      await apiFetch('/api/permissions/mode', { method: 'PUT', body: JSON.stringify({ mode }) });
      window.dispatchEvent(new Event('sky-permissions-changed'));
      setPerms((s: any) => ({ ...s, mode }));
      toast.success(wt('权限模式已切换'));
    } catch (e) {
      toast.error(wt('切换失败'), e instanceof Error ? e.message : undefined);
    } finally { setModeSaving(false); }
  };

  const classify = async () => {
    if (!classifyCmd.trim()) return;
    try {
      const r = await apiFetch<any>('/api/permissions/classify', {
        method: 'POST',
        body: JSON.stringify({ command: classifyCmd }),
      });
      setClassifyResult(r);
    } catch (e) {
      toast.error(wt('分类失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const addRule = async () => {
    if (!newRule.command.trim()) {
      toast.warn(wt('请输入命令名'));
      return;
    }
    try {
      await apiFetch('/api/permissions/command-rules', {
        method: 'POST',
        body: JSON.stringify(newRule),
      });
      toast.success(wt('规则已添加'));
      setNewRule({ command: '', type: 'allow', reason: '' });
      load();
    } catch (e) {
      toast.error(wt('添加失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const delRule = async (cmd: string) => {
    if (!(await showConfirm(wt('确定删除命令规则 "{{v0}}" 吗？', { v0: cmd })))) return;
    try {
      // 后端删除命令规则走 DELETE /permissions/command-rules（body: {command}）
      await apiFetch('/api/permissions/command-rules', {
        method: 'DELETE',
        body: JSON.stringify({ command: cmd }),
      });
      toast.success(wt('已删除'));
      load();
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const addPerm = async () => {
    if (!newPerm.tool.trim()) {
      toast.warn(wt('请输入工具名'));
      return;
    }
    try {
      await apiFetch('/api/permissions/rules', { method: 'POST', body: JSON.stringify(newPerm) });
      toast.success(wt('权限规则已添加'));
      setNewPerm({ tool: '', type: 'allow', reason: '' });
      load();
    } catch (e) {
      toast.error(wt('添加失败'), e instanceof Error ? e.message : undefined);
    }
  };

  /** 删除权限规则（按规则 id；审批"始终允许/始终拒绝"产生的规则在此撤销） */
  const delPerm = async (id: string, tool: string) => {
    if (!(await showConfirm(wt('确定删除工具 "{{v0}}" 的权限规则吗？', { v0: tool })))) return;
    try {
      await apiFetch(`/api/permissions/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast.success(wt('权限规则已删除'));
      load();
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  /** 删除工具策略（此前后端 DELETE 端点存在但前端无入口——策略只能建不能删） */
  const delPolicy = async (name: string) => {
    if (!(await showConfirm(wt('确定删除工具策略 "{{v0}}" 吗？', { v0: name })))) return;
    try {
      await apiFetch(`/api/tool-policies/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast.success(wt('策略已删除'));
      load();
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const savePolicy = async (v: ToolPolicyFormValues) => {
    try {
      await apiFetch('/api/tool-policies', {
        method: 'POST',
        body: JSON.stringify({
          name: v.name,
          allow: v.allow
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          deny: v.deny
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      toast.success(wt('工具策略已创建'));
      setPolicyOpen(false);
      load();
    } catch (e) {
      toast.error(wt('创建失败'), e instanceof Error ? e.message : undefined);
    }
  };

  if (loading) return <Loading />;

  const cmdRules: any[] = perms.commandRules || [];
  // 工具权限规则三态合并（GET /permissions 返回 allow/deny/ask 三个数组，此前前端只写不展示）
  const permRules: Array<{ id: string; tool: string; type: string; reason?: string }> = [
    ...(perms.allow || []),
    ...(perms.deny || []),
    ...(perms.ask || []),
  ];
  const modeDesc = PERMISSION_MODES.find((m) => m.id === perms.mode)?.desc || '';

  return (
    <div className="space-y-3">
      {/* 权限模式 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="approval" size={16} /> {wt('命令权限模式')}
        </h3>
        <div className="flex gap-2 mb-2">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.id}
              className={`text-xs px-3 py-1.5 rounded ${perms.mode === m.id ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}
              onClick={() => switchMode(m.id)}
              disabled={modeSaving}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">{modeDesc}</p>
        <div className="mt-2 text-xs text-gray-600 bg-gray-800/30 rounded p-2">
          <p className="mb-1">
            <span className="text-green-400">{wt('● 白名单命令')}</span>
            {wt(
              '：内置安全命令（ls/cat/git status 等只读命令）+ 用户添加的"始终允许"命令 — 任何模式免审批',
            )}
          </p>
          <p className="mb-1">
            <span className="text-red-400">{wt('● 黑名单命令')}</span>
            {wt('：用户"始终拒绝"的命令 — 任何模式直接拒绝')}
          </p>
          <p className="mb-1">
            <span className="text-yellow-400">{wt('● 名单外命令')}</span>
            {wt(
              '：其余一切命令（含危险命令，不预置黑名单）— 需要审批弹卡 / 自动审批必要时询问 / 完全访问直接执行',
            )}
          </p>
          <p>
            <span className="text-blue-400">{wt('● 工具')}</span>
            {wt('：工具管理三态独立判定 — 禁止任何模式拦截，自动任何模式放行，需确认跟随模式')}
          </p>
        </div>
      </div>

      {/* 安全守卫统计 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="shield" size={16} /> {wt('安全守卫')}
          <span
            className={`text-xs font-normal ${secStats.enabled ? 'text-green-400' : 'text-red-400'}`}
          >
            {secStats.enabled ? wt('● 已启用') : wt('○ 已禁用')}
          </span>
        </h3>
        <p className="text-xs text-gray-500 mb-2">
          {wt(
            '安全守卫已与命令权限系统整合，内置19种危险模式检测、6种Shell转义检测、25个敏感路径保护，自动拦截高危操作。命令规则可覆盖默认分类。',
          )}
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('允许规则')}</div>
            <div className="text-lg font-bold text-green-400">
              {secStats.commandRulesAllow ?? cmdRules.filter((r) => r.type === 'allow').length}
            </div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('禁止规则')}</div>
            <div className="text-lg font-bold text-red-400">
              {secStats.commandRulesDeny ?? cmdRules.filter((r) => r.type === 'deny').length}
            </div>
          </div>
          <div className="bg-gray-800/50 rounded p-3">
            <div className="text-xs text-gray-500 mb-1">{wt('审批记录')}</div>
            <div className="text-lg font-bold text-blue-400">{secStats.auditLogCount ?? 0}</div>
          </div>
        </div>
        <details className="mt-3 text-xs text-gray-500">
          <summary className="cursor-pointer hover:text-gray-300">
            {wt('查看内置检测说明（19种危险模式 / 6种Shell转义）')}
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2 bg-gray-900 p-2 rounded">
            <div>
              <span className="text-gray-400">{wt('危险模式:')}</span>
              {
                ' rm -rf /, chmod 777, sudo, curl|sh, wget|sh, dd, mkfs, :(){:|:&};:, > /dev/sda, kill -9 -1, pkill, shutdown, reboot, halt, init, history -c, export PATH, eval, base64|sh'
              }
            </div>
            <div>
              <span className="text-gray-400">{wt('Shell转义:')}</span>
              {' $(...), `...`, ${...}, ;, |, && / ||'}
            </div>
          </div>
        </details>
      </div>

      {/* 命令分类测试 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="terminal" size={16} /> {wt('命令分类测试')}
        </h3>
        <div className="flex gap-2 mb-2">
          <input
            className="input-field flex-1 text-sm"
            placeholder={wt('输入命令测试分类 (如: rm -rf /, ls -la, npm install)')}
            value={classifyCmd}
            onChange={(e) => setClassifyCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') classify();
            }}
          />
          <button className="btn-primary text-sm" onClick={classify}>
            {wt('分类')}
          </button>
        </div>
        {classifyResult ? (
          <div className="text-xs">
            <span className="mr-2">{wt('分类:')}</span>
            <span
              className={`font-bold ${
                classifyResult.level === 'dangerous' || classifyResult.category === 'dangerous'
                  ? 'text-red-400'
                  : classifyResult.level === 'normal' || classifyResult.category === 'safe'
                    ? 'text-green-400'
                    : 'text-gray-400'
              }`}
            >
              {classifyResult.level === 'dangerous'
                ? 'dangerous'
                : classifyResult.level === 'normal'
                  ? 'safe'
                  : classifyResult.category || classifyResult.classification || 'unknown'}
            </span>
            {classifyResult.cmdName ? (
              <span className="text-gray-500 ml-2">
                {wt('命令名:')}
                {classifyResult.cmdName}
              </span>
            ) : null}
            {classifyResult.matchedRules ? (
              <span className="text-gray-500 ml-2">
                {wt('匹配规则:')}
                {Array.isArray(classifyResult.matchedRules)
                  ? classifyResult.matchedRules.join(', ')
                  : String(classifyResult.matchedRules)}
              </span>
            ) : null}
            {classifyResult.reason ? (
              <div className="text-gray-500 mt-1">{classifyResult.reason}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 命令规则 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="permission" size={16} /> {wt('命令规则 (')}
          {cmdRules.length})
        </h3>
        <p className="text-xs text-gray-500 mb-2">
          {wt(
            '审批命令时选择"始终允许"或"始终拒绝"会自动创建命令规则，也可手动添加。命令规则优先于权限模式判断。',
          )}
        </p>
        {cmdRules.length ? (
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {cmdRules.map((r, i) => {
              const cls = r.type === 'allow' ? 'text-green-400' : 'text-red-400';
              const bg =
                r.type === 'allow' ? 'border-l-2 border-green-500' : 'border-l-2 border-red-500';
              return (
                <div
                  key={i}
                  className={`flex items-center justify-between bg-gray-800/50 rounded p-2 ${bg}`}
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-blue-400 font-mono">{r.command || '?'}</span>
                    <span className={`text-xs ${cls} ml-2`}>
                      {r.type === 'allow' ? wt('允许') : wt('禁止')}
                    </span>
                    {r.reason ? (
                      <span className="text-xs text-gray-500 ml-2">{r.reason}</span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {r.createdAt ? new Date(r.createdAt).toLocaleString(workbenchLocale()) : ''}
                    </span>
                    <button
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => delRule(r.command || r.id)}
                    >
                      {wt('删除')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            {wt('暂无命令规则。审批危险命令时选择"始终允许/始终拒绝"可自动创建。')}
          </p>
        )}
      </div>

      {/* 内置安全命令（只读白名单，来自 YoloClassifier） */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="shield" size={16} /> {wt('内置安全命令 (')}
          {(perms.builtinSafeCommands || []).length})
        </h3>
        <p className="text-xs text-gray-500 mb-2">
          {wt(
            '内置只读安全命令，任何模式免审批直接执行。如需改为需审批，可在下方添加对应"始终禁止"规则覆盖；如需移出免审批，删除该覆盖规则即可恢复。',
          )}
        </p>
        {perms.builtinSafeCommands?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {perms.builtinSafeCommands.map((c: string, i: number) => (
              <span
                key={i}
                className="text-xs font-mono text-green-400 bg-green-500/10 border border-green-500/20 rounded px-2 py-0.5"
              >
                {c}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-500">{wt('暂无内置安全命令（分类器未加载）。')}</p>
        )}
      </div>

      {/* 添加命令规则 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="plus" size={16} /> {wt('添加命令规则')}
        </h3>
        <p className="text-xs text-gray-500 mb-2">{wt('手动添加命令规则，覆盖默认分类。')}</p>
        <div className="flex gap-2">
          <input
            className="input-field flex-1 text-sm"
            placeholder={wt('命令名 (如: rm, curl, npm)')}
            value={newRule.command}
            onChange={(e) => setNewRule((s) => ({ ...s, command: e.target.value }))}
          />
          <select
            className="input-field text-sm"
            value={newRule.type}
            onChange={(e) => setNewRule((s) => ({ ...s, type: e.target.value }))}
          >
            <option value="allow">{wt('始终允许')}</option>
            <option value="deny">{wt('始终禁止')}</option>
          </select>
          <input
            className="input-field flex-1 text-sm"
            placeholder={wt('原因(可选)')}
            value={newRule.reason}
            onChange={(e) => setNewRule((s) => ({ ...s, reason: e.target.value }))}
          />
          <button className="btn-primary text-sm" onClick={addRule}>
            {wt('添加')}
          </button>
        </div>
      </div>

      {/* 权限规则列表（审批"始终允许/始终拒绝"自动创建的规则在此查看与撤销；此前只有添加入口无列表） */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="permission" size={16} /> {wt('权限规则 (')}
          {permRules.length})
        </h3>
        <p className="text-xs text-gray-500 mb-2">
          {wt('工具级权限规则。审批弹窗选择"始终允许/始终拒绝"会自动创建；删除规则即撤销该决策。')}
        </p>
        {permRules.length ? (
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {permRules.map((r, i) => {
              const cls =
                r.type === 'allow'
                  ? 'text-green-400'
                  : r.type === 'deny'
                    ? 'text-red-400'
                    : 'text-yellow-400';
              const bg =
                r.type === 'allow'
                  ? 'border-l-2 border-green-500'
                  : r.type === 'deny'
                    ? 'border-l-2 border-red-500'
                    : 'border-l-2 border-yellow-500';
              const label =
                r.type === 'allow' ? wt('允许') : r.type === 'deny' ? wt('禁止') : wt('需确认');
              return (
                <div
                  key={r.id || i}
                  className={`flex items-center justify-between bg-gray-800/50 rounded p-2 ${bg}`}
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-blue-400 font-mono">{r.tool || '?'}</span>
                    <span className={`text-xs ${cls} ml-2`}>{label}</span>
                    {r.reason ? (
                      <span className="text-xs text-gray-500 ml-2">{r.reason}</span>
                    ) : null}
                  </div>
                  <button
                    className="text-xs text-red-400 hover:text-red-300"
                    onClick={() => r.id && delPerm(r.id, r.tool)}
                  >
                    {wt('删除')}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500">{wt('暂无权限规则。')}</p>
        )}
      </div>

      {/* 添加权限规则 */}
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="permission" size={16} /> {wt('添加权限规则')}
        </h3>
        <p className="text-xs text-gray-500 mb-2">{wt('为特定工具添加权限规则。')}</p>
        <div className="flex gap-2">
          <input
            className="input-field flex-1 text-sm"
            placeholder={wt('工具名')}
            value={newPerm.tool}
            onChange={(e) => setNewPerm((s) => ({ ...s, tool: e.target.value }))}
          />
          <select
            className="input-field text-sm"
            value={newPerm.type}
            onChange={(e) => setNewPerm((s) => ({ ...s, type: e.target.value }))}
          >
            <option value="allow">{wt('允许')}</option>
            <option value="deny">{wt('禁止')}</option>
            <option value="ask">{wt('需确认')}</option>
          </select>
          <input
            className="input-field flex-1 text-sm"
            placeholder={wt('原因(可选)')}
            value={newPerm.reason}
            onChange={(e) => setNewPerm((s) => ({ ...s, reason: e.target.value }))}
          />
          <button className="btn-primary text-sm" onClick={addPerm}>
            {wt('添加')}
          </button>
        </div>
      </div>

      {/* 工具策略 */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Icon name="shield" size={16} /> {wt('工具策略 (')}
            {policies.length})
          </h3>
          <button className="btn-primary text-sm" onClick={() => setPolicyOpen(true)}>
            {wt('创建工具策略')}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          {wt(
            '工具策略可精细控制每个策略允许或禁止的工具范围。deny 名单中的工具将被直接拦截，allow 名单中的工具免审批。',
          )}
        </p>
        {policies.length ? (
          <div className="space-y-1 mt-2">
            {policies.map((p, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-gray-800/50 rounded p-2 text-xs"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-blue-400 font-mono">{p.name}</span>
                  {p.allow?.length ? (
                    <span className="text-green-400 ml-2">
                      {wt('允许:')}
                      {p.allow.join(', ')}
                    </span>
                  ) : null}
                  {p.deny?.length ? (
                    <span className="text-red-400 ml-2">
                      {wt('禁止:')}
                      {p.deny.join(', ')}
                    </span>
                  ) : null}
                </div>
                <button
                  className="text-xs text-red-400 hover:text-red-300 ml-2"
                  onClick={() => delPolicy(p.name)}
                >
                  {wt('删除')}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <ToolPolicyCreateModal
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        onSave={savePolicy}
      />
      <Feedback msg={msg} />
    </div>
  );
}

/* ── 访问鉴权：REST/WS Token 开关（读写 config.json security.auth，脱敏显示） ── */
function SecurityAuth() {
  useWorkbenchLanguage();
  const [auth, setAuth] = useState<{ mode: string; hasToken: boolean }>({
    mode: 'none',
    hasToken: false,
  });
  const [tokenInput, setTokenInput] = useState('');
  const [localTokenSet, setLocalTokenSet] = useState(false);
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);

  const load = useCallback(async () => {
    try {
      // 注意：security.auth.token 经后端 RedactInterceptor 脱敏为 '***'，真实值永不下发。
      // 因此"任何非空字符串（含 '***'）"都代表服务端已配置 token。
      const r = await apiFetch<any>('/api/config/security');
      const a = r?.value?.auth || r?.auth || {};
      const rawToken: unknown = a.token;
      setAuth({
        mode: a.mode === 'token' ? 'token' : 'none',
        hasToken: typeof rawToken === 'string' && rawToken.length > 0,
      });
    } catch {
      setAuth({ mode: 'none', hasToken: false });
    }
    setLocalTokenSet(Boolean(getAuthToken()));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    const mode = tokenInput.trim() ? 'token' : auth.mode;
    if (mode === 'token' && !tokenInput.trim() && !auth.hasToken) {
      toast.warn(wt('请输入访问令牌'));
      return;
    }
    setBusy('save');
    setMsg(null);
    try {
      // 写 config.json security.auth；输入为空时保留已配置 token 仅切换模式
      const body = tokenInput.trim()
        ? { auth: { mode: 'token', token: tokenInput.trim() } }
        : { auth: { mode } };
      await apiFetch('/api/config/security', { method: 'PUT', body: JSON.stringify(body) });
      // 同步本机请求头/WS 连接使用的 token
      if (tokenInput.trim()) setAuthToken(tokenInput.trim());
      setTokenInput('');
      setMsg({ text: wt('鉴权配置已保存（服务端即时生效）'), ok: true });
      load();
    } catch (e) {
      setMsg({ text: wt('保存失败: ') + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    if (
      !(await showConfirm(wt('确定关闭 Token 鉴权吗？关闭后所有 REST API 无需令牌即可访问。'), {
        danger: true,
      }))
    )
      return;
    setBusy('clear');
    setMsg(null);
    try {
      await apiFetch('/api/config/security', {
        method: 'PUT',
        body: JSON.stringify({ auth: { mode: 'none' } }),
      });
      setAuthToken(null);
      setMsg({ text: wt('已关闭 Token 鉴权'), ok: true });
      load();
    } catch (e) {
      setMsg({ text: wt('关闭失败: ') + (e instanceof Error ? e.message : String(e)), ok: false });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="shield" size={16} /> {wt('HTTP / WebSocket 访问鉴权')}
          <span
            className={`text-xs font-normal ${auth.mode === 'token' ? 'text-green-400' : 'text-gray-500'}`}
          >
            {auth.mode === 'token' ? wt('● Token 鉴权已启用') : wt('○ 未启用（默认，全部放行）')}
          </span>
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          {wt('启用后所有 REST API 请求须携带')}
          <code className="text-blue-400">Authorization: Bearer &lt;token&gt;</code> {wt('或')}{' '}
          <code className="text-blue-400">X-Auth-Token</code> {wt('头，WebSocket 连接须带')}
          <code className="text-blue-400">?token=</code>{' '}
          {wt('参数。 本前端会自动携带下方保存的令牌；也可通过环境变量')}
          <code className="text-blue-400">SKYALYTICWING_AUTH_TOKEN</code> {wt('在服务端启用。')}
        </p>
        <div className="flex gap-2 mb-2">
          <input
            type="password"
            className="input-field flex-1 text-sm"
            placeholder={
              auth.hasToken
                ? wt('已配置（脱敏显示），输入新值覆盖')
                : wt('输入访问令牌（建议 32 位以上随机串）')
            }
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            autoComplete="new-password"
          />
          <button className="btn-primary text-sm" onClick={save} disabled={busy !== null}>
            {busy === 'save' ? wt('保存中…') : wt('保存并启用')}
          </button>
          <button
            className="text-sm px-3 py-1 rounded bg-red-900/30 text-red-400"
            onClick={disable}
            disabled={busy !== null || auth.mode !== 'token'}
            title={auth.mode !== 'token' ? wt('当前未启用鉴权') : undefined}
          >
            {busy === 'clear' ? wt('关闭中…') : wt('关闭鉴权')}
          </button>
        </div>
        <div className="text-xs text-gray-500">
          {wt('服务端令牌：')}
          {auth.hasToken ? (
            <span className="text-green-400">{wt('已配置（出于安全脱敏显示）')}</span>
          ) : (
            <span className="text-gray-600">{wt('未配置')}</span>
          )}
          {' · '}
          {wt('本机请求令牌：')}
          {localTokenSet ? (
            <span className="text-green-400">{wt('已保存')}</span>
          ) : (
            <span className="text-gray-600">{wt('未保存')}</span>
          )}
        </div>
      </div>
      <Feedback msg={msg} />
    </div>
  );
}

/* ── 沙箱执行 ── */
function SecuritySandbox() {
  useWorkbenchLanguage();
  const [sandbox, setSandbox] = useState<any>({});
  const [config, setConfig] = useState({ mode: 'off', backend: 'docker', workspace: 'none' });
  const [cmd, setCmd] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<'exec' | 'validate' | 'save' | 'destroy' | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<any>('/api/sandbox-enhanced');
      setSandbox(r || {});
      const cfg = r?.config || {};
      setConfig({
        mode: cfg.mode || r?.mode || 'off',
        backend: cfg.backend || 'docker',
        workspace: cfg.workspace || 'none',
      });
    } catch (e) {
      setMsg({ text: wt('加载沙箱状态失败'), ok: false });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const exec = async () => {
    if (!cmd.trim()) return;
    setBusy('exec');
    try {
      const r = await apiFetch<any>('/api/sandbox/execute', {
        method: 'POST',
        body: JSON.stringify({ command: cmd }),
      });
      setResult(r);
    } catch (e) {
      setResult({ success: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const validate = async () => {
    if (!cmd.trim()) return;
    setBusy('validate');
    try {
      const r = await apiFetch<any>('/api/sandbox/validate', {
        method: 'POST',
        body: JSON.stringify({ command: cmd }),
      });
      setResult(r);
    } catch (e) {
      setResult({ valid: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const saveCfg = async () => {
    setBusy('save');
    try {
      // 后端配置走 PUT /sandbox-enhanced（workspace 值映射为 workspaceAccess: none/ro/rw）
      const workspaceAccessMap: Record<string, string> = { none: 'none', read: 'ro', write: 'rw' };
      await apiFetch('/api/sandbox-enhanced', {
        method: 'PUT',
        body: JSON.stringify({
          mode: config.mode,
          backend: config.backend,
          workspaceAccess: workspaceAccessMap[config.workspace] ?? 'none',
        }),
      });
      toast.success(wt('沙箱配置已保存'));
      load();
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  };
  const destroy = async () => {
    const containers: Array<{ name?: string }> = sandbox?.containers || [];
    if (!containers.length) {
      toast.info(wt('当前没有可销毁的沙箱容器'));
      return;
    }
    if (
      !(await showConfirm(wt('确定销毁 {{v0}} 个沙箱容器吗？', { v0: containers.length }), {
        danger: true,
      }))
    )
      return;
    setBusy('destroy');
    try {
      // 后端销毁走 POST /sandbox-enhanced/destroy（body: {containerName}，逐个销毁）
      for (const c of containers) {
        if (!c?.name) continue;
        await apiFetch('/api/sandbox-enhanced/destroy', {
          method: 'POST',
          body: JSON.stringify({ containerName: c.name }),
        });
      }
      toast.success(wt('沙箱容器已销毁'));
      load();
    } catch (e) {
      toast.error(wt('销毁失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const allowed = (sandbox.allowedCommands || []).length;
  const blocked = (sandbox.blockedRules || []).length;
  const sMode = (sandbox.config && sandbox.config.mode) || sandbox.mode || 'off';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-800/50 rounded p-3">
          <div className="text-xs text-gray-500 mb-1">{wt('沙箱模式')}</div>
          <div className="text-lg font-bold text-blue-400">{sMode}</div>
        </div>
        <div className="bg-gray-800/50 rounded p-3">
          <div className="text-xs text-gray-500 mb-1">{wt('允许命令')}</div>
          <div className="text-lg font-bold text-green-400">{allowed}</div>
        </div>
        <div className="bg-gray-800/50 rounded p-3">
          <div className="text-xs text-gray-500 mb-1">{wt('阻止规则')}</div>
          <div className="text-lg font-bold text-red-400">{blocked}</div>
        </div>
      </div>
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="terminal" size={16} /> {wt('命令执行')}
        </h3>
        <textarea
          className="input-field w-full text-sm mb-2"
          rows={2}
          placeholder={wt('输入命令在沙箱中安全执行...')}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="btn-primary text-sm" onClick={exec} disabled={busy === 'exec'}>
            {busy === 'exec' ? wt('执行中…') : wt('安全执行')}
          </button>
          <button
            className="text-sm px-3 py-1 rounded bg-yellow-900/30 text-yellow-400"
            onClick={validate}
            disabled={busy === 'validate'}
          >
            {busy === 'validate' ? wt('验证中…') : wt('验证命令')}
          </button>
        </div>
        {result ? (
          <div className="mt-2 text-xs">
            {result.valid !== undefined ? (
              <div className={result.valid ? 'text-green-400' : 'text-red-400'}>
                {result.valid ? wt('验证通过') : wt('验证失败')}
                {result.reason ? `：${result.reason}` : ''}
              </div>
            ) : null}
            {result.output ? (
              <pre className="bg-gray-900 p-2 rounded mt-1 whitespace-pre-wrap">
                {result.output}
              </pre>
            ) : null}
            {result.error ? <div className="text-red-400 mt-1">{result.error}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="sandbox" size={16} /> {wt('沙箱配置')}
        </h3>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{wt('沙箱模式')}</label>
            <select
              className="input-field text-sm"
              value={config.mode}
              onChange={(e) => setConfig((s) => ({ ...s, mode: e.target.value }))}
            >
              <option value="off">{wt('关闭')}</option>
              <option value="non-main">{wt('非主会话')}</option>
              <option value="all">{wt('全部会话')}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{wt('沙箱后端')}</label>
            <select
              className="input-field text-sm"
              value={config.backend}
              onChange={(e) => setConfig((s) => ({ ...s, backend: e.target.value }))}
            >
              <option value="docker">Docker</option>
              <option value="podman">Podman</option>
              <option value="nsjail">Nsjail</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{wt('工作区访问')}</label>
            <select
              className="input-field text-sm"
              value={config.workspace}
              onChange={(e) => setConfig((s) => ({ ...s, workspace: e.target.value }))}
            >
              <option value="none">{wt('无访问')}</option>
              <option value="read">{wt('只读')}</option>
              <option value="write">{wt('读写')}</option>
            </select>
          </div>
        </div>
        <button className="btn-primary text-sm" onClick={saveCfg} disabled={busy === 'save'}>
          {busy === 'save' ? wt('保存中…') : wt('保存配置')}
        </button>
        <button
          className="text-sm px-3 py-1 rounded bg-red-900/30 text-red-400 ml-2"
          onClick={destroy}
          disabled={busy === 'destroy'}
        >
          {busy === 'destroy' ? wt('销毁中…') : wt('销毁容器')}
        </button>
      </div>
      <Feedback msg={msg} />
    </div>
  );
}

/* ── 设备配对 ── */
function SecurityPairing() {
  useWorkbenchLanguage();
  const [pairingCode, setPairingCode] = useState('');
  const [devices, setDevices] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const loadDevices = useCallback(async () => {
    try {
      // 后端已配对设备走 GET /security/devices（响应：{success, data:{devices}}）
      const r = await apiFetch<any>('/api/security/devices');
      const list = r?.data?.devices ?? r?.devices ?? r;
      setDevices(Array.isArray(list) ? list : []);
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  const generate = async () => {
    setBusy(true);
    try {
      // 后端配对码走 POST /security/pairing（响应：{success, data:{code,...}}）
      const r = await apiFetch<any>('/api/security/pairing', { method: 'POST' });
      setPairingCode(r?.data?.code || r?.data?.pairingCode || r?.code || r?.pairingCode || '');
      toast.success(wt('配对码已生成'));
    } catch (e) {
      toast.error(wt('生成失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!(await showConfirm(wt('确定注销该设备吗？'), { danger: true }))) return;
    try {
      await apiFetch(`/api/security/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast.success(wt('设备已注销'));
      loadDevices();
    } catch (e) {
      toast.error(wt('注销失败'), e instanceof Error ? e.message : undefined);
    }
  };

  return (
    <div className="space-y-3">
      <div className="card">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5">
          <Icon name="remote" size={16} /> {wt('设备配对')}
        </h3>
        <p className="text-xs text-gray-500 mb-3">
          {wt(
            '设备配对(DM Pairing)允许受信任的设备通过6位配对码连接到SkyalyticWing，配对码5分钟内有效。',
          )}
        </p>
        <button className="btn-primary text-sm" onClick={generate} disabled={busy}>
          {busy ? wt('生成中…') : wt('生成配对码')}
        </button>
        {pairingCode ? (
          <div className="bg-gray-900 rounded p-4 text-center mt-3">
            <div className="text-xs text-gray-500 mb-1">{wt('配对码')}</div>
            <div className="text-3xl font-mono font-bold text-green-400 tracking-widest">
              {pairingCode}
            </div>
            <div className="text-xs text-gray-500 mt-1">{wt('5分钟内有效')}</div>
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium flex items-center gap-1.5">
            <Icon name="user" size={16} /> {wt('已配对设备 (')}
            {devices.length})
          </h3>
          <button
            className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-400"
            onClick={loadDevices}
          >
            {wt('刷新')}
          </button>
        </div>
        {devices.length ? (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {devices.map((d, i) => {
              const dId = d.deviceId || d.id || '?';
              const dName = d.name || d.deviceName || wt('未知设备');
              const dIp = d.ip || d.ipAddress || '';
              const dTime = d.pairedAt || d.createdAt || '';
              const dStatus = d.active !== false ? 'active' : 'inactive';
              return (
                <div
                  key={i}
                  className="flex items-center justify-between bg-gray-800/50 rounded p-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-blue-400 truncate">{dName}</div>
                    <div className="text-xs text-gray-500">
                      ID: {String(dId).substring(0, 16)}
                      {dIp ? ` · IP: ${dIp}` : ''}
                      {dTime ? ` · ${new Date(dTime).toLocaleString(workbenchLocale())}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${dStatus === 'active' ? 'bg-green-500' : 'bg-gray-500'}`}
                    />
                    <button
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => revoke(dId)}
                    >
                      {wt('注销')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500">{wt('暂无已配对设备')}</p>
        )}
      </div>
    </div>
  );
}

/* ── 审批审计日志 ── */
function SecurityApprovals() {
  useWorkbenchLanguage();
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch<any>('/api/approvals/history');
      const list = (r?.approvals || r || []).slice().reverse().slice(0, 50);
      setApprovals(list);
    } catch {
      setApprovals([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const clearAll = async () => {
    if (!(await showConfirm(wt('确定清除全部审批记录吗？此操作不可撤销。'), { danger: true })))
      return;
    try {
      // 后端清空审计走 POST /permissions/audit/clear
      await apiFetch('/api/permissions/audit/clear', { method: 'POST' });
      toast.success(wt('已清空审批日志'));
      load();
    } catch (e) {
      toast.error(wt('清除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const delOne = async (id: string) => {
    if (!(await showConfirm(wt('确定删除该条审计记录吗？'), { danger: true }))) return;
    try {
      // 后端单条删除走 POST /permissions/audit/delete（body: {id}）
      await apiFetch('/api/permissions/audit/delete', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      toast.success(wt('已删除'));
      load();
    } catch (e) {
      toast.error(wt('删除失败'), e instanceof Error ? e.message : undefined);
    }
  };

  const labelOf = (ds: string) => {
    const map: Record<string, string> = {
      approved: wt('批准'),
      'allow-once': wt('允许一次'),
      'allow-always': wt('始终允许'),
      denied: wt('拒绝'),
      'deny-always': wt('始终拒绝'),
      timeout: wt('超时'),
    };
    return map[ds] || ds;
  };
  const colorOf = (ds: string) =>
    ds === 'approved' || ds === 'allow-once' || ds === 'allow-always'
      ? 'text-green-400'
      : ds === 'denied' || ds === 'deny-always'
        ? 'text-red-400'
        : ds === 'timeout'
          ? 'text-yellow-400'
          : 'text-gray-400';

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium flex items-center gap-1.5">
          <Icon name="log" size={16} /> {wt('审批记录 (')}
          {approvals.length}
          {wt('条)')}
        </h3>
        <button className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400" onClick={clearAll}>
          {wt('清除全部')}
        </button>
      </div>
      <details className="mb-3 text-xs text-gray-500">
        <summary className="cursor-pointer hover:text-gray-300">
          {wt('25个敏感路径保护说明')}
        </summary>
        <div className="mt-2 bg-gray-900 p-2 rounded text-gray-400">
          /etc, /etc/passwd, /etc/shadow, /etc/sudoers, /root, /root/.ssh, ~/.ssh,
          ~/.ssh/authorized_keys, ~/.aws, ~/.aws/credentials, ~/.config, ~/.config/gcloud, ~/.kube,
          ~/.kube/config, /var/log/auth.log, /proc/self/environ, C:\Windows\System32, C:\Users,
          C:\Users\Administrator, C:\Users\All Users, %APPDATA%, %APPDATA%\Microsoft\Credentials,
          .env, .env.local, .env.production, id_rsa, credentials.json
        </div>
      </details>
      {loading ? (
        <Loading />
      ) : approvals.length ? (
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {approvals.map((a, i) => {
            const ds = a.status || a.decision || '?';
            const reason = a.reason || '';
            const time = a.createdAt || a.ts || a.timestamp || 0;
            return (
              <div
                key={a.id || i}
                className="flex items-center justify-between bg-gray-800/50 rounded p-2"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-blue-400">{a.tool || '?'}</span>
                  {a.cmdName ? (
                    <span className="text-orange-400 font-mono ml-1 text-xs">→ {a.cmdName}</span>
                  ) : null}
                  <span className={`text-xs ml-2 ${colorOf(ds)}`}>{labelOf(ds)}</span>
                  {reason ? (
                    <span className="text-xs text-gray-500 ml-2">
                      {String(reason).substring(0, 40)}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">
                    {time ? new Date(time).toLocaleString(workbenchLocale()) : ''}
                  </span>
                  {a.id ? (
                    <button className="text-xs text-red-400" onClick={() => delOne(a.id)}>
                      ×
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-gray-500">{wt('暂无审批记录')}</p>
      )}
    </div>
  );
}

/* ────────────────────────────── 模型供应商 ────────────────────────────── */

/**
 * 解析 defaultModel 所属供应商 ID。
 * 消费方（ChatInput / 后端 resolveModel）均按"模型 ID"理解 general.defaultModel，
 * 此前此处存"厂商 ID"导致默认模型设置无效（chat 匹配失败回退列表第一个模型）。
 * 兼容读取历史厂商 ID 存储；空串表示未设置。
 */
function defaultModelProviderId(providers: Provider[], defaultModel?: string): string {
  if (!defaultModel) return '';
  const owner = providers.find((p) => (p.models || []).includes(defaultModel));
  if (owner) return owner.id;
  return providers.some((p) => p.id === defaultModel) ? defaultModel : '';
}

function ModelsTab() {
  useWorkbenchLanguage();
  const [providerSearch, setProviderSearch] = useState('');
  const [capabilities, setCapabilities] = useState<CapabilityForm>(emptyCapabilities);
  const capabilitiesFor = (p: Pick<Provider, 'visionModels' | 'imageModels' | 'videoModels' | 'imageProtocol' | 'videoProtocol' | 'imageBaseUrl' | 'videoBaseUrl'>): CapabilityForm => ({
    visionIds: (p.visionModels || []).join(','),
    imageIds: (p.imageModels || []).join(','),
    videoIds: (p.videoModels || []).join(','),
    imageProtocol: p.imageProtocol || 'none',
    videoProtocol: p.videoProtocol || 'none',
    imageBaseUrl: p.imageBaseUrl || '',
    videoBaseUrl: p.videoBaseUrl || '',
  });
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [cfgTab, setCfgTab] = useState<'list' | 'add'>('list');
  const [general, setGeneral] = useState<{
    defaultModel?: string;
    permissionMode?: string;
    maxTokens?: number;
    temperature?: number;
  }>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 添加/编辑表单（对齐旧版"模型详细配置"表单）
  const [form, setForm] = useState({
    editId: '',
    provider: '',
    name: '',
    apiKey: '',
    baseUrl: '',
    modelIds: '',
    maxTokens: 8192,
    temperature: 0.7,
    isDefault: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const list = await apiFetch<any>('/api/providers');
      const raw: Provider[] = Array.isArray(list?.providers) ? list.providers : [];
      setProviders(raw);
      const g = await apiFetch<any>('/api/config/general');
      const gv = g?.value ?? g;
      setGeneral(gv && typeof gv === 'object' ? gv : {});
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(wt('加载模型配置失败'), reason);
      setMsg({ text: wt('加载模型配置失败: ') + reason, ok: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 已配置列表仅按 configured 状态划分：自定义模型（custom）与本地服务（local）
  // 保存配置后同样进入"已配置"（此前被强制排除，导致配置后"消失"在未配置区）
  const configured = providers.filter((p) => p.configured);
  const unconfigured = providers.filter((p) => !p.configured);

  /** 快速选择/预设点击（旧版 selectPreset 改造）：
   *  - 点击实例条目（baseProvider 有值）→ 编辑该实例
   *  - 点击注册表厂商 → 一律"新增"表单（厂商已配置时保存将生成新实例，
   *    支持同厂商多 Key / 多 API 地址；编辑请用卡片上的"编辑"按钮） */
  const selectPreset = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    if (p.baseProvider) {
      editProvider(p);
      return;
    }
    const template = p.preset || p;
    setCapabilities(capabilitiesFor(template));
    setForm({
      editId: '',
      provider: id,
      name: '',
      apiKey: '',
      baseUrl: template.baseUrl || '',
      modelIds: (template.models || []).join(','),
      maxTokens: p.maxTokens || 8192,
      temperature: p.temperature ?? 0.7,
      isDefault: !!template.models.length && defaultModelProviderId(providers, general.defaultModel) === id,
    });
  };

  /** 编辑已有配置（卡片"编辑"按钮）：plain 厂商配置与实例通用 */
  const editProvider = (p: Provider) => {
    setCapabilities(capabilitiesFor(p));
    setForm({
      editId: p.id,
      provider: p.baseProvider || p.id,
      name: p.displayName || p.name || '',
      apiKey: '',
      baseUrl: p.baseUrl || '',
      modelIds: (p.models || []).join(','),
      maxTokens: p.maxTokens || 8192,
      temperature: p.temperature ?? 0.7,
      isDefault: defaultModelProviderId(providers, general.defaultModel) === p.id,
    });
  };

  /** 保存供应商配置（旧版 saveNewModel 改造：PUT /api/providers/:id）；结果 toast 即时弹出。
   *  多实例规则：
   *  - 编辑（editId 非空）→ 更新该条目（plain 厂商或实例）
   *  - 新增 custom → 恒生成新实例 ID custom_<ts>（支持任意多个自定义端点）
   *  - 新增注册表厂商且该厂商未配置 → 存 plain ID（首配保持原行为）
   *  - 新增注册表厂商且已配置 → 生成实例 ID <id>_<ts>（同厂商多 Key / 多 API 地址） */
  const saveProvider = async () => {
    if (!form.provider) {
      toast.warn(wt('请选择提供商'));
      return;
    }
    const baseP = providers.find((p) => p.id === form.provider);
    if (baseP?.catalog?.setup === 'reference') {
      toast.warn(wt('该厂商原生协议尚未适配，请查看官方文档。'));
      return;
    }
    if (!form.baseUrl.trim() || (!form.modelIds.trim() && !capabilities.imageIds.trim() && !capabilities.videoIds.trim())) {
      toast.warn(wt('请填写接口地址和至少一个可用模型。'));
      return;
    }
    if (!form.apiKey && !form.editId && !baseP?.local && baseP?.type !== 'custom') {
      toast.warn(wt('请填写 API Key'));
      return;
    }
    if (!form.apiKey && !form.editId && baseP?.type === 'custom' && !form.baseUrl) {
      toast.warn(wt('自定义模型需填写 API Base URL 或 API Key'));
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      // 目标 ID：编辑用 editId；新增按上述规则生成
      let targetId = form.editId;
      if (!targetId) {
        const already = providers.find((p) => p.id === form.provider)?.configured;
        if (form.provider === 'custom' || already) {
          targetId = `${form.provider}_${Date.now().toString(36)}`;
        } else {
          targetId = form.provider;
        }
      }
      const body: Record<string, unknown> = {
        visionModels: capabilities.visionIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        imageModels: capabilities.imageIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        imageProtocol: capabilities.imageProtocol,
        imageBaseUrl: capabilities.imageBaseUrl,
        videoModels: capabilities.videoIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        videoProtocol: capabilities.videoProtocol,
        videoBaseUrl: capabilities.videoBaseUrl,
        baseUrl: form.baseUrl,
        displayName: form.name,
        models: form.modelIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        maxTokens: Number(form.maxTokens) || 8192,
        temperature: Number(form.temperature) || 0.7,
        // 协议类型与基础厂商：多实例 ID 无法从自身推断（anthropic_2 需显式 type
        // 才能走 Claude 协议；本地实例需 type=local 豁免密钥与 SSRF）
        type: baseP?.type || 'openai',
        baseProvider: form.provider,
      };
      if (form.apiKey) body['apiKey'] = form.apiKey;
      await apiFetch(`/api/providers/${targetId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      // 默认模型存"模型 ID"（ChatInput / 后端 resolveModel 均按模型 ID 消费）
      if (form.isDefault && form.modelIds.trim() && defaultModelProviderId(providers, general.defaultModel) !== targetId) {
        const firstModel =
          form.modelIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)[0] || targetId;
        await apiFetch('/api/config/general', {
          method: 'PUT',
          body: JSON.stringify({ ...general, defaultModel: firstModel }),
        });
      }
      const isNewInstance = !form.editId && targetId !== form.provider;
      toast.success(
        form.editId ? wt('配置已更新') : isNewInstance ? wt('新实例已保存') : wt('配置已保存'),
      );
      setMsg({ text: form.editId ? wt('配置已更新') : wt('配置已保存'), ok: true });
      setCfgTab('list');
      await load();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(wt('保存失败'), reason);
      setMsg({ text: wt('保存失败: ') + reason, ok: false });
    } finally {
      setSaving(false);
    }
  };

  /** 测试连通性（旧版 testProvider）；结果同时以 toast 即时弹出 + 底部 msg 保留 */
  const testProviderConn = async (id: string) => {
    setTesting(id);
    try {
      const d = await apiFetch<any>(`/api/providers/${id}/test`, { method: 'POST' });
      const text =
        (d?.success ? wt('连接成功! ') : wt('连接失败: ')) +
        (d?.latency || d?.message || d?.error || '');
      setMsg({ text, ok: !!d?.success });
      if (d?.success) {
        toast.success(
          wt('连接成功'),
          d?.latency
            ? wt('{{v0}} 延迟 {{v1}}', { v0: d.message || '', v1: d.latency }).trim()
            : d?.message,
        );
      } else {
        toast.error(wt('连接失败'), d?.error || d?.message || wt('未知错误'));
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setMsg({ text: wt('测试失败: ') + reason, ok: false });
      toast.error(wt('测试失败'), reason);
    } finally {
      setTesting(null);
    }
  };

  /** 设为默认模型（旧版 setAsDefault；存模型 ID，取该厂商首个模型）；结果 toast 即时弹出 */
  const setAsDefault = async (id: string) => {
    const firstModel = providers.find((p) => p.id === id)?.models?.[0] || id;
    try {
      await apiFetch('/api/config/general', {
        method: 'PUT',
        body: JSON.stringify({ ...general, defaultModel: firstModel }),
      });
      setGeneral((g) => ({ ...g, defaultModel: firstModel }));
      toast.success(wt('已设为默认模型'));
      setMsg({ text: wt('已设为默认模型'), ok: true });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(wt('设置失败'), reason);
      setMsg({ text: wt('设置失败: ') + reason, ok: false });
    }
  };

  /** 删除供应商（旧版 deleteProvider）；结果 toast 即时弹出 */
  const deleteProvider = async (id: string) => {
    const ok = await showConfirm(wt('确定删除供应商 "{{v0}}" 的配置吗？', { v0: id }));
    if (!ok) return;
    try {
      await apiFetch(`/api/providers/${id}`, { method: 'DELETE' });
      toast.success(wt('已删除'));
      setMsg({ text: wt('已删除'), ok: true });
      await load();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(wt('删除失败'), reason);
      setMsg({ text: wt('删除失败: ') + reason, ok: false });
    }
  };

  /** 保存通用设置（旧版 saveGeneralCfg）；结果 toast 即时弹出 */
  const saveGeneral = async () => {
    setSaving(true);
    try {
      await apiFetch('/api/config/general', {
        method: 'PUT',
        body: JSON.stringify({
          defaultModel: general.defaultModel || '',
          maxTokens: Number(general.maxTokens) || 8192,
          temperature: Number(general.temperature) || 0.7,
        }),
      });
      toast.success(wt('通用设置已保存'));
      setMsg({ text: wt('通用设置已保存'), ok: true });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(wt('保存失败'), reason);
      setMsg({ text: wt('保存失败: ') + reason, ok: false });
    } finally {
      setSaving(false);
    }
  };

  if (loading && providers.length === 0) return <Loading />;

  const isEditing = !!form.editId;

  return (
    <div className="model-settings">

      {/* 子标签：已配置 / 添加新模型（对齐旧版） */}
      <div className="model-config-tabs">
        <button
          className="model-config-tab"
          aria-pressed={cfgTab === 'list'}
          onClick={() => setCfgTab('list')}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="check" size={14} /> {wt('已配置 (')}
            {configured.length})
          </span>
        </button>
        <button
          className="model-config-tab"
          aria-pressed={cfgTab === 'add'}
          onClick={() => {
            setForm({
              editId: '',
              provider: '',
              name: '',
              apiKey: '',
              baseUrl: '',
              modelIds: '',
              maxTokens: 8192,
              temperature: 0.7,
              isDefault: false,
            });
            setCfgTab('add');
          }}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="plus" size={14} /> {wt('添加新模型')}
          </span>
        </button>
      </div>

      {cfgTab === 'list' && (
        <>
          {configured.length === 0 ? (
            <div className="card p-12 text-center">
              <div className="flex justify-center mb-4">
                <Icon name="config" size={56} />
              </div>
              <div className="text-lg font-medium">{wt('暂无已配置模型')}</div>
              <div className="text-sm text-gray-500 mt-2">
                {wt('点击"添加新模型"开始配置你的第一个 AI 模型')}
              </div>
              <button className="btn-primary mt-4" onClick={() => setCfgTab('add')}>
                <span className="inline-flex items-center gap-1">
                  <Icon name="plus" size={14} /> {wt('添加第一个模型')}
                </span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {configured.map((p) => {
                const brand = providerBrand(p.baseProvider || p.id);
                return (
                  <div className="model-card" key={p.id}>
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <ProviderIcon id={p.baseProvider || p.id} size={36} />
                        <div>
                          <div className="font-medium text-sm">{providerName(p)}</div>
                          <span
                            className="provider-badge"
                            style={{ background: brand.bg + '22', color: brand.bg }}
                          >
                            {brand.label}
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        {defaultModelProviderId(providers, general.defaultModel) === p.id ? (
                          <span className="badge badge-green text-xs">{wt('默认')}</span>
                        ) : null}
                        <button
                          className="btn-secondary text-xs py-0.5 px-2"
                          title={wt('测试连接')}
                          disabled={testing === p.id}
                          onClick={() => testProviderConn(p.id)}
                        >
                          {testing === p.id ? wt('测试中…') : wt('测试')}
                        </button>
                        <button
                          className="btn-secondary text-xs py-0.5 px-2"
                          title={wt('编辑配置')}
                          onClick={() => {
                            editProvider(p);
                            setCfgTab('add');
                          }}
                        >
                          {wt('编辑')}
                        </button>
                        <button
                          className="btn-secondary text-xs py-0.5 px-2"
                          title={wt('设为默认模型')}
                          onClick={() => setAsDefault(p.id)}
                        >
                          {wt('默认')}
                        </button>
                        <button
                          className="text-red-400 hover:text-red-300 text-xs px-1"
                          title={wt('删除')}
                          onClick={() => deleteProvider(p.id)}
                        >
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1 text-xs text-gray-400">
                      <div>
                        {wt('模型:')}
                        <code className="text-gray-300">
                          {p.models && p.models[0] ? p.models[0] : '-'}
                        </code>
                        {p.models && p.models.length > 1 ? (
                          <span className="text-gray-500"> +{p.models.length - 1}</span>
                        ) : null}
                      </div>
                      {p.maskedApiKey ? (
                        <div>
                          Key: <code>{p.maskedApiKey}</code>
                        </div>
                      ) : p.local ? (
                        <div className="text-gray-500">{wt('本地服务 · 无需密钥')}</div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {unconfigured.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-gray-400 mb-3">
                {wt('未配置 (')}
                {unconfigured.length})
              </h3>
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                {unconfigured.map((p) => (
                  <div
                    key={p.id}
                    className="card p-2.5 cursor-pointer hover:border-blue-500 transition-colors text-center"
                    onClick={() => {
                      selectPreset(p.id);
                      setCfgTab('add');
                    }}
                  >
                    <div className="flex justify-center">
                      <ProviderIcon id={p.id} size={28} />
                    </div>
                    <div className="text-xs truncate mt-1">{providerName(p)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {cfgTab === 'add' && (
        <div className="model-provider-layout">
          {/* Keep names and state indicators inside each selectable row. */}
          <div className="model-provider-list card p-4 scrollbar-thin">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-1">
              <Icon name="zap" size={14} />
              {wt('快速选择（{{count}} 个提供商）', {
                count: providers.length,
              })}
            </h3>
            <input className="form-input model-provider-search" aria-label={wt('搜索厂商或模型')} placeholder={wt('搜索厂商或模型')} value={providerSearch} onChange={e => setProviderSearch(e.target.value)} />
            <div className="space-y-1">
              {providers
                .filter((p) => [p.id, p.name, providerName(p), ...p.models, ...(p.imageModels || []), ...(p.videoModels || []), ...(p.catalog?.references || []).map(m=>m.id)].join(' ').toLowerCase().includes(providerSearch.trim().toLowerCase()))
                .map((p) => {
                  const done = p.configured;
                  const isInst = !!p.baseProvider;
                  const selected =
                    form.provider === (p.baseProvider || p.id) &&
                    (isInst ? form.editId === p.id : !form.editId || form.editId === p.id);
                  return (
                    <button
                      type="button"
                      key={p.id}
                      className="model-provider-preset"
                      aria-pressed={selected}
                      aria-label={providerName(p)}
                      title={providerName(p)}
                      onClick={() => selectPreset(p.id)}
                    >
                      <ProviderIcon id={p.baseProvider || p.id} size={32} />
                      <span className="model-provider-copy">
                        <span className="model-provider-name">{providerName(p)}</span>
                        <span className="model-provider-detail">
                          {isInst
                            ? wt('已配置实例 · 点击编辑')
                            : done
                              ? wt('已配置')
                              : (p.models?.length || 0) + (p.imageModels?.length || 0) + (p.videoModels?.length || 0)
                                ? wt('{{v0}}个模型', { v0: p.models.length + (p.imageModels?.length || 0) + (p.videoModels?.length || 0) })
                                : p.catalog?.setup === 'reference'
                                  ? wt('目录参考 · 暂未适配')
                                  : p.catalog?.setup === 'deployment'
                                    ? wt('需填写你的部署名称')
                                    : p.catalog?.setup === 'gateway'
                                      ? wt('需填写网关模型 ID')
                                      : p.local || p.catalog?.setup === 'local'
                                        ? wt('需填写已安装的模型 ID')
                                        : wt('手动填写模型 ID')}
                        </span>
                      </span>
                      <span className="model-provider-indicator" aria-hidden="true">
                        <Icon name={selected ? 'check' : isInst ? 'edit' : 'plus'} size={15} />
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
          {/* 右侧：模型详细配置表单 */}
          <div className="model-provider-form card p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-1">
              <Icon name="edit" size={14} /> {isEditing ? wt('编辑模型配置') : wt('模型详细配置')}
            </h3>
            <ProviderTemplateInfo
              catalog={providers.find(p => p.id === form.provider)?.catalog}
              counts={[form.modelIds.split(',').filter(s=>s.trim()).length, capabilities.visionIds.split(',').filter(s=>s.trim()).length, capabilities.imageProtocol === 'none' ? 0 : capabilities.imageIds.split(',').filter(s=>s.trim()).length, capabilities.videoProtocol === 'none' ? 0 : capabilities.videoIds.split(',').filter(s=>s.trim()).length]}
              onApply={() => {
                const preset = providers.find(p => p.id === form.provider)?.preset;
                if (!preset) return;
                setCapabilities(capabilitiesFor(preset));
                setForm(f => ({ ...f, baseUrl: preset.baseUrl || '', modelIds: preset.models.join(','), isDefault: !!preset.models.length && f.isDefault }));
              }}
            />
            {/* Only claim an existing configuration when one actually exists. */}
            {!isEditing &&
            form.provider &&
            configured.some((p) => (p.baseProvider || p.id) === form.provider) ? (
              <div className="text-xs text-blue-400 bg-blue-900/20 border border-blue-800/50 rounded px-2.5 py-1.5 mb-3">
                {wt('该厂商已有配置，本次保存将创建')}
                <b>{wt('新实例')}</b>
                {wt('——可使用不同 API Key / API 地址（编辑已有配置请回到列表点"编辑"）')}
              </div>
            ) : null}
            <div className="space-y-3">
              <div>
                <label className="form-label">{wt('模型显示名')}</label>
                <input
                  className="form-input"
                  placeholder={wt('如 My DeepSeek #2（区分多实例）')}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div>
                <label className="form-label">{wt('提供商')}</label>
                {isEditing ? (
                  <input
                    className="form-input bg-gray-700 cursor-not-allowed"
                    value={providerBrand(form.provider).label}
                    disabled
                  />
                ) : (
                  <select
                    className="form-input"
                    value={form.provider}
                    onChange={(e) => selectPreset(e.target.value)}
                  >
                    <option value="">{wt('-- 选择 --')}</option>
                    {providers
                      .filter((p) => !p.baseProvider)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {providerName(p)}
                        </option>
                      ))}
                  </select>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">
                    API Key{' '}
                    {isEditing ? (
                      <span className="text-xs text-gray-500">{wt('(留空保持不变)')}</span>
                    ) : (
                      <span className="text-red-400">*</span>
                    )}
                  </label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder={isEditing ? wt('留空则不修改') : 'sk-xxxxxxxx'}
                    value={form.apiKey}
                    onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="form-label">API Base URL</label>
                  <input
                    className="form-input"
                    placeholder="https://api.xxx.com/v1"
                    value={form.baseUrl}
                    onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">{wt('模型ID (可填多个,用逗号分隔)')}</label>
                  <textarea
                    className="form-input"
                    placeholder="model-id-1,model-id-2"
                    value={form.modelIds}
                    onChange={(e) => setForm((f) => ({ ...f, modelIds: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="form-label">{wt('最大词数')}</label>
                  <input
                    type="number"
                    className="form-input"
                    value={form.maxTokens}
                    onChange={(e) => setForm((f) => ({ ...f, maxTokens: Number(e.target.value) }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    className="form-input"
                    value={form.temperature}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, temperature: Number(e.target.value) }))
                    }
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer mt-5">
                    <input
                      type="checkbox"
                      disabled={!form.modelIds.trim()}
                      checked={form.isDefault}
                      onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
                    />
                    <span className="text-sm text-gray-300">{wt('设为默认模型')}</span>
                  </label>
                </div>
              </div>
              <ModelCapabilities value={capabilities} onChange={setCapabilities} />
              <button
                onClick={saveProvider}
                className="btn-primary w-full py-2.5 mt-2 text-base font-medium"
                disabled={saving || providers.find(p => p.id === form.provider)?.catalog?.setup === 'reference'}
              >
                <span className="inline-flex items-center gap-1">
                  <Icon name="save" size={14} />{' '}
                  {saving ? wt('保存中…') : isEditing ? wt('更新配置') : wt('保存模型配置')}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通用设置（对齐旧版：权限模式/全局最大词数/全局温度/默认模型） */}
      <div className="card p-5 mt-6">
        <h3 className="font-semibold mb-4 flex items-center gap-2 text-cyan-300">
          <Icon name="settings" size={16} /> {wt('通用设置')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="form-label">{wt('权限模式')}</label>
            <PermissionModePicker />
          </div>
          <div>
            <label className="form-label">{wt('全局最大词数')}</label>
            <input
              type="number"
              className="form-input"
              value={general.maxTokens ?? 8192}
              onChange={(e) => setGeneral((g) => ({ ...g, maxTokens: Number(e.target.value) }))}
            />
          </div>
          <div>
            <label className="form-label">{wt('全局温度')}</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              className="form-input"
              value={general.temperature ?? 0.7}
              onChange={(e) => setGeneral((g) => ({ ...g, temperature: Number(e.target.value) }))}
            />
          </div>
          <div>
            <label className="form-label">
              {wt('默认模型')}{' '}
              <span className="text-xs text-gray-500 font-normal normal-case">
                {wt('(对话时使用)')}
              </span>
            </label>
            <select
              className="form-input"
              value={general.defaultModel || ''}
              onChange={(e) => setGeneral((g) => ({ ...g, defaultModel: e.target.value }))}
            >
              <option value="">
                -- {configured.length === 0 ? wt('暂无已配置模型') : wt('选择')} --
              </option>
              {configured.flatMap((p) =>
                (p.models || []).map((m) => (
                  <option key={`${p.id}:${m}`} value={m}>
                    {m}（{providerName(p)}）
                  </option>
                )),
              )}
            </select>
            {configured.length === 0 ? (
              <p className="text-[11px] text-yellow-600 mt-1">
                {wt('请先在上方添加并配置至少一个AI模型')}
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-4">
          <button onClick={saveGeneral} className="btn-secondary w-full py-2" disabled={saving}>
            {wt('保存通用设置')}
          </button>
        </div>
      </div>
      <Feedback msg={msg} />
    </div>
  );
}

export default SettingsPage;
