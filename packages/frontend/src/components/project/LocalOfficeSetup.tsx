import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
interface State {
  phase: string;
  message: string;
  running: boolean;
  platform: string;
}
export function LocalOfficeSetup({ onReady }: { onReady: () => void }) {
  useWorkbenchLanguage();
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      apiClient
        .get<State>('/office-engine/local/status')
        .then((s) => {
          if (alive) setState(s);
        })
        .catch(() => {});
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const action = async (name: string, repair = false) => {
    setBusy(true);
    setError('');
    try {
      setState(
        await apiClient.post<State>('/office-engine/local/' + name, {
          origin: window.location.origin,
          repair,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('操作失败'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="wing-office-local-setup"
      style={{
        padding: 16,
        border: '1px solid var(--border-color, #ddd)',
        borderRadius: 10,
        marginBottom: 16,
      }}
    >
      <h4>{wt('在这台电脑安装 Office')}</h4>
      <p>
        {wt(
          '自动准备本地运行环境和编辑引擎，文档通过本机通道保存。首次安装需下载约 1 GB 组件及系统依赖，并预留至少 8 GB 磁盘空间。',
        )}
      </p>
      <p>
        {wt(
          '自动运行环境支持 Windows 11 / Server 2025、macOS 13 及以上。Windows 可能需要开启虚拟化、系统授权及重启；Mac 首次运行可能要求系统确认，Apple 芯片使用 Rosetta。已有容器环境的配置会保留。',
        )}
      </p>
      <p role="status">{state?.message || wt('正在检查本地安装状态')}</p>
      {error && <p role="alert">{error}</p>}
      {state?.phase === 'ready' ? (
        <button type="button" onClick={onReady}>
          {wt('进入完整 Office 编辑器')}
        </button>
      ) : (
        <button
          type="button"
          disabled={busy || state?.running}
          onClick={() => void action('install')}
        >
          {wt('安装 / 继续安装本地 Office')}
        </button>
      )}
      {state?.phase === 'system-setup-required' && state.platform === 'win32' && (
        <button type="button" disabled={busy} onClick={() => void action('enable-windows')}>
          {wt('启用 Windows 运行环境')}
        </button>
      )}
      {state?.phase === 'failed' && state.platform === 'win32' && (
        <details>
          <summary>{wt('回传检查被防火墙阻止？')}</summary>
          <p>
            {wt(
              '允许当前程序在专用网络的本地子网访问本次文件回传端口。需要 Windows 管理员确认，不会关闭防火墙。',
            )}
          </p>
          <button
            type="button"
            disabled={busy || state.running}
            onClick={() => void action('allow-firewall')}
          >
            {wt('允许本地 Office 回传')}
          </button>
        </details>
      )}
      {state?.running && (
        <button type="button" disabled={busy} onClick={() => void action('cancel')}>
          {wt('取消当前安装')}
        </button>
      )}
      {['failed', 'stopped', 'ready'].includes(state?.phase || '') && (
        <details>
          <summary>{wt('维护本地引擎')}</summary>
          <p>{wt('先保存并关闭所有正在编辑的 Office 文件，再重启或停止引擎。')}</p>
          <button
            type="button"
            disabled={busy || state?.running}
            onClick={() => void action('install', true)}
          >
            {wt('修复连接并重启')}
          </button>
          <button
            type="button"
            disabled={busy || state?.running}
            onClick={() => void action('stop')}
          >
            {wt('停止本地引擎')}
          </button>
        </details>
      )}
    </div>
  );
}
