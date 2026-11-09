import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '@/services/api-client';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';

export function TaskCenterLink() {
  useWorkbenchLanguage();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await apiClient.get<{ count: number }>('/scheduler/attention');
        if (live) setCount(data.count);
      } catch {
        /* Keep the last confirmed count while reconnecting. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <Link className="btn-secondary text-sm py-1 px-2" to="/tasks">
      {wt('任务中心')}
      {count > 0 && <span className="ml-1 font-semibold">{count}</span>}
    </Link>
  );
}
