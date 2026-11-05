import { workbenchLocale } from '@/i18n/workbench-text';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { authenticatedFetch } from '@/services/authenticated-fetch';
// 守护进程页面（对齐旧版 daemon.js renderDaemonView）：
// 4 统计卡（服务状态三态/安装状态/自动启动/平台）+ 按钮分支（未安装→安装服务；
// 已安装→启动/停止+重启+卸载+自动启停）+ 运行时细节（PID/启动时间/内存）+ 服务日志 + 服务信息
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { showConfirm } from '../../components/modals/ConfirmDialog';
import { toast } from '../../components/ui/Toast';

interface DaemonStatus {
  running?: boolean;
  installed?: boolean;
  autoStart?: boolean;
  pid?: number;
  startTime?: number | string;
  memoryMB?: number;
  platform?: string;
}

interface DaemonLog {
  timestamp?: number | string;
  level?: string;
  message?: string;
  msg?: string;
  file?: string;
  line?: string;
}

function formatTime(ts?: number | string): string {
  if (!ts) return '-';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(workbenchLocale());
  } catch {
    return String(ts);
  }
}

function logLevelClass(level?: string): string {
  if (level === 'ERROR') return 'text-red-400';
  if (level === 'WARN') return 'text-yellow-400';
  return 'text-gray-400';
}

/** 平台标识（旧版 platformLabel） */
function platformLabel(platform?: string): string {
  const p = (platform || navigator.platform || 'unknown').toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac') || p.includes('darwin')) return 'macOS';
  if (p.includes('linux')) return 'Linux';
  return `Other (${platform || 'unknown'})`;
}

export function DaemonPage({ embedded = false }: { embedded?: boolean }) {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [status, setStatus] = useState<DaemonStatus>({});
  const [logs, setLogs] = useState<DaemonLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = async () => {
    // 取消上一次未完成请求（快速切换页面时不留挂起连接），12s 超时兜底
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const timeout = setTimeout(() => ac.abort(), 12_000);
    setLoading(true);
    setError(null);
    try {
      // GET /daemon/status 返回 {success, data:{running, installed, pid, ...}}，需解包
      const res = await authenticatedFetch('/api/daemon/status', { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = json?.data ?? json;
      setStatus(d?.status ?? d ?? {});

      // 日志走 GET /daemon/manager/logs（响应 {ok, logs}，非 ApiResponse 包装）
      try {
        const logRes = await authenticatedFetch('/api/daemon/manager/logs?lines=100', {
          signal: ac.signal,
        });
        if (logRes.ok) {
          const logJson = await logRes.json();
          const list = logJson?.logs ?? logJson?.data?.logs;
          if (Array.isArray(list)) setLogs(list);
        }
      } catch {
        /* 日志加载失败不影响状态展示 */
      }
    } catch (e) {
      if (ac.signal.aborted) return; // 已被新请求/卸载取代，不更新状态
      setError(e instanceof Error ? e.message : wt('加载状态失败'));
    } finally {
      clearTimeout(timeout);
      if (!ac.signal.aborted && abortRef.current === ac) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 组件卸载时中断在途请求，避免挂起连接占用浏览器并发额度
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  /** 通用动作：POST 端点 → 解析 {success, error} → toast + 刷新 */
  const callAction = async (path: string, label: string, body?: unknown) => {
    setBusy(true);
    try {
      const res = await authenticatedFetch(path, {
        method: 'POST',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      toast.success(wt('{{v0}}成功', { v0: label }));
      await load();
    } catch (e) {
      toast.error(wt('{{v0}}失败', { v0: label }), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  /** 卸载（危险操作，确认弹窗，对齐旧版 uninstallDaemon） */
  const uninstall = async () => {
    if (!(await showConfirm(wt('确定要卸载系统服务吗？')))) return;
    await callAction('/api/daemon/uninstall', wt('卸载'));
  };

  // 旧版语义：installed 默认 false（未安装时 UI 只显示"安装服务"）
  const isRunning = !!status.running;
  const isInstalled = !!status.installed;
  const autoStart = !!status.autoStart;

  return (
    <div className={embedded ? 'min-w-0' : 'p-6 overflow-y-auto h-full'}>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Icon name="daemon" size={20} /> {wt('系统服务')}
        </h2>
        <button className="btn-secondary text-sm" onClick={load}>
          <span className="inline-flex items-center gap-1">
            <Icon name="refresh" size={14} /> {wt('刷新状态')}
          </span>
        </button>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-gray-400">
          <span className="spinner inline-block" />
          <p className="mt-2 text-sm">{wt('加载中…')}</p>
        </div>
      ) : error ? (
        <div className="card p-8 text-center text-red-400">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Icon name="alert" size={20} />
            <span>{wt('加载失败')}</span>
          </div>
          <p className="text-sm text-gray-500">{error}</p>
          <button className="btn-secondary text-sm mt-3" onClick={load}>
            {wt('重试')}
          </button>
        </div>
      ) : (
        <>
          {/* 4 统计卡（旧版：服务状态三态/安装状态/自动启动/平台） */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-gray-800/50 rounded p-3">
              <div className="text-xs text-gray-500 mb-1">{wt('服务状态')}</div>
              <div
                className={
                  'text-lg font-bold ' +
                  (isRunning ? 'text-green-400' : isInstalled ? 'text-yellow-400' : 'text-gray-400')
                }
              >
                {isRunning ? wt('运行中') : isInstalled ? wt('已停止') : wt('未安装')}
              </div>
            </div>
            <div className="bg-gray-800/50 rounded p-3">
              <div className="text-xs text-gray-500 mb-1">{wt('安装状态')}</div>
              <div
                className={`text-lg font-bold ${isInstalled ? 'text-green-400' : 'text-red-400'}`}
              >
                {isInstalled ? wt('已安装') : wt('未安装')}
              </div>
            </div>
            <div className="bg-gray-800/50 rounded p-3">
              <div className="text-xs text-gray-500 mb-1">{wt('自动启动')}</div>
              <div
                className={`text-lg font-bold ${autoStart ? 'text-green-400' : 'text-gray-400'}`}
              >
                {autoStart ? wt('已启用') : wt('已禁用')}
              </div>
            </div>
            <div className="bg-gray-800/50 rounded p-3">
              <div className="text-xs text-gray-500 mb-1">{wt('平台')}</div>
              <div className="text-lg font-bold text-blue-400">
                {platformLabel(status.platform)}
              </div>
            </div>
          </div>

          {/* 运行时细节（PID/启动时间/内存，运行中显示） */}
          {isRunning ? (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-gray-800/50 rounded p-3">
                <div className="text-xs text-gray-500 mb-1">PID</div>
                <div className="text-lg font-bold text-blue-400 font-mono">{status.pid || '-'}</div>
              </div>
              <div className="bg-gray-800/50 rounded p-3">
                <div className="text-xs text-gray-500 mb-1">{wt('启动时间')}</div>
                <div className="text-sm font-bold text-primary">{formatTime(status.startTime)}</div>
              </div>
              <div className="bg-gray-800/50 rounded p-3">
                <div className="text-xs text-gray-500 mb-1">{wt('内存占用')}</div>
                <div className="text-lg font-bold text-purple-400">
                  {status.memoryMB ? status.memoryMB.toFixed(1) + ' MB' : '-'}
                </div>
              </div>
            </div>
          ) : null}

          {/* 按钮组（旧版分支：未安装→安装服务；已安装→启停/卸载/自启） */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {isInstalled ? (
              <>
                <button
                  className={
                    isRunning
                      ? 'text-sm px-3 py-1.5 rounded bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/60'
                      : 'text-sm px-3 py-1.5 rounded bg-green-900/30 text-green-400 hover:bg-green-900/60'
                  }
                  onClick={() =>
                    callAction(
                      isRunning ? '/api/daemon/stop' : '/api/daemon/start',
                      isRunning ? wt('停止服务') : wt('启动服务'),
                    )
                  }
                  disabled={busy}
                >
                  {isRunning ? wt('停止服务') : wt('启动服务')}
                </button>
                <button
                  className="text-sm px-3 py-1.5 rounded bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/60"
                  onClick={() => callAction('/api/daemon/restart', wt('重启'))}
                  disabled={busy}
                >
                  {wt('重启')}
                </button>
                <button
                  className="text-sm px-3 py-1.5 rounded bg-red-900/30 text-red-400 hover:bg-red-900/60"
                  onClick={() => void uninstall()}
                  disabled={busy}
                >
                  {wt('卸载服务')}
                </button>
                <button
                  className={
                    autoStart
                      ? 'text-sm px-3 py-1.5 rounded bg-yellow-900/30 text-yellow-400 hover:bg-yellow-900/60'
                      : 'text-sm px-3 py-1.5 rounded bg-green-900/30 text-green-400 hover:bg-green-900/60'
                  }
                  onClick={() =>
                    callAction('/api/daemon/autostart', wt('设置自动启动'), { enabled: !autoStart })
                  }
                  disabled={busy}
                >
                  {autoStart ? wt('禁用自动启动') : wt('启用自动启动')}
                </button>
              </>
            ) : (
              <button
                className="btn-primary text-sm"
                onClick={() => callAction('/api/daemon/install', wt('安装服务'))}
                disabled={busy}
              >
                <span className="inline-flex items-center gap-1">
                  <Icon name="plus" size={14} /> {wt('安装服务')}
                </span>
              </button>
            )}
          </div>

          {/* 服务日志 */}
          <div className="card p-4 mb-4">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-1">
              <Icon name="log" size={16} /> {wt('服务日志')}
            </h3>
            <div
              ref={logRef}
              className="bg-gray-900 rounded p-3 max-h-96 overflow-y-auto font-mono text-xs scrollbar-thin"
            >
              {logs.length === 0 ? (
                <div className="text-gray-600">{wt('暂无日志')}</div>
              ) : (
                logs.slice(-100).map((l, i) => {
                  const level = l.level || 'INFO';
                  return (
                    <div key={`${l.timestamp}-${i}`} className={logLevelClass(level)}>
                      <span className="text-gray-600">
                        {l.timestamp ? formatTime(l.timestamp) : ''}
                      </span>{' '}
                      [{l.file || level}] {l.message || l.msg || (l.line === 'No log files found' ? wt('暂无日志') : l.line) || ''}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 服务信息（旧版说明卡） */}
          <div className="card p-4">
            <h3 className="text-sm font-medium mb-2">{wt('服务信息')}</h3>
            <div className="text-xs text-gray-400 space-y-1">
              <p>{wt('系统服务(Daemon)允许 SkyalyticWing 作为后台守护进程运行，开机自动启动。')}</p>
              <p>
                {wt('当前平台:')}
                <span className="text-primary">{platformLabel(status.platform)}</span>
              </p>
              <p>{wt('安装后服务将注册为系统服务，支持自动重启和日志记录。')}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
