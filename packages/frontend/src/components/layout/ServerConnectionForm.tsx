import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useState } from 'react';
import { setAuthToken } from '@/services/auth-token';

/** Connect a fresh browser to an already-protected server without changing server credentials. */
export function ServerConnectionForm() {
  useWorkbenchLanguage();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const value = token.trim();
      const response = await fetch('/api/providers', {
        headers: { Authorization: 'Bearer ' + value },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401 || response.status === 403)
        throw new Error(wt('访问令牌不正确或来源未获允许'));
      if (!response.ok) throw new Error(wt('服务连接失败，请检查后端状态'));
      setAuthToken(value);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : wt('连接失败'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={connect}
      className="mt-4 p-4 rounded border border-white/20"
      style={{ pointerEvents: 'auto', background: 'var(--bg-primary)' }}
    >
      <p className="text-sm mb-2">{wt('如果服务已启用鉴权，请输入启动时设置的服务访问令牌。')}</p>
      <label className="block text-sm">
        {wt('服务访问令牌')}
        <input
          type="password"
          aria-label={wt('服务访问令牌')}
          autoComplete="current-password"
          className="block w-full my-2 p-2 rounded border bg-transparent"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <button type="submit" className="px-3 py-1 rounded border" disabled={busy || !token.trim()}>
        {busy ? wt('验证连接…') : wt('连接服务')}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
