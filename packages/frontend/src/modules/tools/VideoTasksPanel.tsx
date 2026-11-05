import { Link } from 'react-router-dom';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { apiClient } from '@/services/api-client';
import { authenticatedFetch } from '@/services/authenticated-fetch';

type Job = {
  id: string;
  status: string;
  providerStatus?: string;
  providerTaskId?: string;
  request: { prompt: string; model?: string };
  error?: string;
  pauseReason?: string;
  artifactReady?: boolean;
};
const names: Record<string, string> = {
  get queued() {
    return wt('等待提交');
  },
  get submitting() {
    return wt('正在提交');
  },
  get pending() {
    return wt('供应商排队中');
  },
  get running() {
    return wt('生成中');
  },
  get succeeded() {
    return wt('生成完成');
  },
  get failed() {
    return wt('供应商失败');
  },
  get paused() {
    return wt('已暂停查询');
  },
  get unknown() {
    return wt('结果待核对');
  },
};
export function VideoTasksPanel() {
  useWorkbenchLanguage();
  return <AvailableVideoTasksPanel />;
}

function AvailableVideoTasksPanel() {
  useWorkbenchLanguage();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [cleanup, setCleanup] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const request = ++revision.current;
    try {
      const result = await apiClient.get<Job[]>('/automation/media/video-tasks');
      if (request !== revision.current) return;
      setJobs(Array.isArray(result) ? result : []);
      setError('');
    } catch (e) {
      if (request !== revision.current) return;
      setError(String(e));
    } finally {
      if (request === revision.current) setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { clearInterval(timer); revision.current++; };
  }, [load]);
  const remove = async () => {
    if (cleanup === null) return;
    setCleaning(true);
    revision.current++;
    try {
      await apiClient.delete('/automation/media/video-tasks' + (cleanup ? '/' + cleanup : ''));
      setCleanup(null);
      await load();
    } catch (e) { setError(String(e)); }
    finally { setCleaning(false); }
  };
  const action = async (job: Job, operation: string, providerTaskId?: string) => {
    try {
      await apiClient.post(
        '/automation/media/video-tasks/' + job.id + '/' + operation,
        providerTaskId ? { providerTaskId } : {},
      );
      setError('');
      await load();
    } catch (e) {
      setError(String(e));
    }
  };
  const download = async (job: Job) => {
    try {
      const response = await authenticatedFetch(
        '/api/automation/media/video-tasks/' + job.id + '/artifact',
      );
      if (!response.ok) throw new Error(wt('下载失败'));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = job.id + '.mp4';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section aria-label={wt('视频生成任务')} className="mb-4 p-4 rounded border border-white/10 break-words">
      <h2 className="text-lg font-semibold">{wt('视频生成任务')}</h2>
      <p className="text-sm opacity-70">{wt('直接在对话中描述要生成的视频。系统使用你配置的模型 API；这里查看任务进度与下载结果。')}</p>
      <Link to="/settings?tab=models">{wt('模型配置')}</Link>
      <button className="btn-secondary" style={{ marginLeft: 16 }} disabled={cleaning || !jobs.some(job => ['succeeded', 'failed'].includes(job.status))} onClick={() => setCleanup('')}>{wt('清理已结束记录')}</button>
      <p className="text-xs opacity-70">{wt('清理记录不会删除视频文件，也不会取消正在运行的任务。')}</p>
      {!loaded && <p role="status" className="py-6 opacity-60">{wt('加载中…')}</p>}
      {loaded && !error && !jobs.length && <p className="py-6 opacity-60">{wt('暂无生成任务，返回对话开始创作。')}</p>}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      <ul>
        {jobs.map((job) => (
          <li key={job.id} className="mt-3 border-t border-white/10 pt-2">
            <strong>{names[job.status] || job.status}</strong> · {job.request.prompt.slice(0, 100)}
            <div className="text-xs opacity-70">
              {wt('任务')}
              {job.id}
              {job.providerTaskId ? wt(' · 供应商任务 ') + job.providerTaskId : ''}
            </div>
            {job.error && <p className="text-sm text-amber-400">{job.error}</p>}
            {['queued', 'pending', 'running'].includes(job.status) && (
              <button className="mr-3 underline" onClick={() => void action(job, 'pause')}>
                {wt('暂停查询')}
              </button>
            )}
            {job.status === 'paused' && (
              <button className="mr-3 underline" onClick={() => void action(job, 'resume')}>
                {wt('继续查询')}
              </button>
            )}
            {job.status === 'unknown' && job.providerTaskId && (
              <button className="mr-3 underline" onClick={() => void action(job, 'resume')}>
                {wt('重新查询原任务')}
              </button>
            )}
            {job.status === 'unknown' && !job.providerTaskId && (
              <button
                className="mr-3 underline"
                onClick={() => {
                  const id = window.prompt(
                    wt('请在供应商控制台核对后输入原任务 ID；不会重新生成。'),
                  );
                  if (id) void action(job, 'resume', id);
                }}
              >
                {wt('关联供应商任务')}
              </button>
            )}
            {job.status === 'succeeded' && !job.artifactReady && (
              <button className="mr-3 underline" onClick={() => void action(job, 'resume')}>
                {wt('重试下载')}
              </button>
            )}
            {job.artifactReady && (
              <button className="underline" onClick={() => void download(job)}>
                {wt('下载视频')}
              </button>
            )}
            {['succeeded', 'failed'].includes(job.status) && <button className="btn-secondary" style={{ marginLeft: 12 }} onClick={() => setCleanup(job.id)} disabled={cleaning}>{wt('删除记录')}</button>}
          </li>
        ))}
      </ul>
      <Modal open={cleanup !== null} title={wt('清理生成记录')} onClose={() => { if (!cleaning) setCleanup(null); }} width={440} footer={<><button className="btn-secondary" disabled={cleaning} onClick={() => setCleanup(null)}>{wt('取消')}</button><button className="btn-primary" disabled={cleaning} onClick={() => void remove()}>{wt('确定')}</button></>}>
        {wt('确认清理所选记录？视频文件会保留，正在运行的任务不受影响。')}
      </Modal>
    </section>
  );
}
