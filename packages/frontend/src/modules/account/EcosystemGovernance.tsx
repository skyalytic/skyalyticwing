import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useState } from 'react';
import { authenticatedFetch } from '@/services/authenticated-fetch';
type Policy = {
  revision: number;
  allowedIds: string[];
  deniedPermissions: string[];
  requireApproval: boolean;
};
export function EcosystemGovernance() {
  useWorkbenchLanguage();
  const [policy, setPolicy] = useState<Policy | null>(null),
    [ids, setIds] = useState(''),
    [permissions, setPermissions] = useState(''),
    [item, setItem] = useState(''),
    [message, setMessage] = useState('');
  async function request(path: string, body?: unknown) {
    const r = await authenticatedFetch(
      '/api/ecosystem/' + path,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
    );
    const raw = await r.json();
    if (!r.ok || raw.success === false) throw new Error(raw.message || raw.error || wt('操作失败'));
    return raw.data ?? raw;
  }
  async function load() {
    try {
      const value = await request('policy');
      setPolicy(value.policy);
      setIds(value.policy.allowedIds.join('\n'));
      setPermissions(value.policy.deniedPermissions.join('\n'));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : wt('读取失败'));
    }
  }
  async function save() {
    if (!policy) return;
    try {
      await request('policy', {
        ...policy,
        allowedIds: ids
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        deniedPermissions: permissions
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setMessage(wt('策略已保存，适用于此本地/企业实例的新安装与授权'));
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : wt('保存失败'));
    }
  }
  return (
    <details
      className="sky-panel"
      onToggle={(e) => {
        if (e.currentTarget.open && !policy) void load();
      }}
    >
      <summary>{wt('管理员生态治理')}</summary>
      <p>{wt('策略与审批保存在当前实例。账号模式下仅管理员可修改。')}</p>
      {policy && (
        <>
          <label>
            <input
              type="checkbox"
              checked={policy.requireApproval}
              onChange={(e) => setPolicy({ ...policy, requireApproval: e.target.checked })}
            />{' '}
            {wt('安装每个新版本前需要管理员批准')}
          </label>
          <label style={{ display: 'block' }}>
            {wt('允许的资源 ID（每行一个，留空允许全部）')}
            <textarea value={ids} onChange={(e) => setIds(e.target.value)} />
          </label>
          <label style={{ display: 'block' }}>
            {wt('禁止的权限描述（与资源声明完全匹配，每行一个）')}
            <textarea value={permissions} onChange={(e) => setPermissions(e.target.value)} />
          </label>
          <button onClick={() => void save()}>{wt('保存策略')}</button>
          <div>
            <input
              placeholder={wt('待批准的资源 ID')}
              value={item}
              onChange={(e) => setItem(e.target.value)}
            />
            <button
              disabled={!item.trim()}
              onClick={() => {
                void request(encodeURIComponent(item.trim()) + '/approve', {})
                  .then(() => setMessage(wt('官网签名已校验，此版本已批准')))
                  .catch((e) => setMessage(e.message));
              }}
            >
              {wt('批准官网当前版本')}
            </button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
