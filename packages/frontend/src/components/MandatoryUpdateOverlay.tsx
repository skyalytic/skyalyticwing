import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 强制更新遮罩：最低版本要求未满足时阻止继续操作
// 后端 MandatoryUpdateService 周期轮询远端版本清单并维护阻断决策；
// 本组件轮询本地状态端点，blocking=true 时渲染全屏不可关闭遮罩，阻止继续使用旧版。
// 后端不可用/未启用时不渲染，不影响正常使用。
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/services/api-client';
import { Icon } from '@/components/Icon';

/** GET /version/mandatory-status 返回（ApiResponse 已解包 data） */
interface MandatoryState {
  enabled: boolean;
  blocking: boolean;
  checking: boolean;
  currentVersion: string;
  minVersion: string | null;
  latestVersion: string | null;
  title: string | null;
  detail: string | null;
  downloadUrl: string | null;
  lastError: string | null;
}

/** 本地状态轮询间隔（远端清单由后端自行轮询，此处只查本地决策） */
const POLL_MS = 60_000;

export function MandatoryUpdateOverlay() {
  useWorkbenchLanguage();
  const [state, setState] = useState<MandatoryState | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<MandatoryState>('/version/mandatory-status');
      setState(res ?? null);
    } catch {
      // 状态获取失败不遮罩（阻断决策由后端持久，恢复后下轮即同步）
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const recheck = async () => {
    try {
      const res = await apiClient.post<MandatoryState>('/version/mandatory-check', {});
      setState(res ?? null);
    } catch {
      // 忽略，等待下一轮
    }
  };

  if (!state?.blocking) return null;

  const title = state.title || wt('当前版本过低，需要更新后才能继续使用');

  return (
    <div
      className="fixed inset-0 z-[9999] bg-gray-950/95 flex items-center justify-center p-6"
      data-testid="mandatory-update-overlay"
    >
      <div className="card p-6 max-w-md w-full text-center">
        <div className="flex justify-center mb-3">
          <span
            className="flex items-center justify-center rounded-full bg-yellow-900/40 text-yellow-400"
            style={{ width: 56, height: 56 }}
          >
            <Icon name="shield" size={28} />
          </span>
        </div>
        <h2 className="text-lg font-bold text-primary mb-2">{title}</h2>
        {state.detail ? (
          <p className="text-sm text-gray-400 whitespace-pre-wrap mb-3">{state.detail}</p>
        ) : null}
        <div className="text-xs text-gray-500 mb-1">
          {wt('当前版本')}
          <span className="font-mono text-gray-300">v{state.currentVersion}</span>
          {state.minVersion ? (
            <>
              {' '}
              {wt('· 最低要求')}
              <span className="font-mono text-yellow-400">v{state.minVersion}</span>
            </>
          ) : null}
          {state.latestVersion ? (
            <>
              {' '}
              {wt('· 最新版本')}
              <span className="font-mono text-green-400">v{state.latestVersion}</span>
            </>
          ) : null}
        </div>
        {state.lastError ? (
          <div className="text-[11px] text-gray-600 mt-1">
            {wt('上次检查失败：')}
            {state.lastError}
          </div>
        ) : null}
        <div className="flex items-center justify-center gap-2 mt-4">
          {state.downloadUrl ? (
            <button
              className="btn-primary text-sm px-4 py-1.5 inline-flex items-center gap-1.5"
              onClick={() => window.open(state.downloadUrl ?? '', '_blank', 'noopener')}
            >
              <Icon name="download" size={14} /> {wt('获取更新')}
            </button>
          ) : null}
          <button
            className="btn-secondary text-sm px-4 py-1.5 inline-flex items-center gap-1.5"
            onClick={() => void recheck()}
            disabled={state.checking}
          >
            {state.checking ? (
              <span className="animate-spin inline-block w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full" />
            ) : (
              <Icon name="refresh" size={14} />
            )}
            {wt('重新检查')}
          </button>
        </div>
      </div>
    </div>
  );
}
