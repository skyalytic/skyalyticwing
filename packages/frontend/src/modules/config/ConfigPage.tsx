import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 配置页面
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { TextArea } from '@/components/ui/TextArea';
import { Badge } from '@/components/ui/Badge';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { toast } from '@/components/ui/Toast';
import { prettyJson } from '@/utils/format';

interface DaemonStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
}

export function ConfigPage() {
  useWorkbenchLanguage();
  const { t } = useTranslation();
  const [configText, setConfigText] = useState('');
  const [section, setSection] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await apiClient.get<Record<string, unknown>>('/config');
      setConfigText(prettyJson(JSON.stringify(cfg)));
    } catch (e) {
      toast.error(wt('加载配置失败'), e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDaemon = useCallback(async () => {
    try {
      const s = await apiClient.get<DaemonStatus>('/daemon/status');
      setDaemon(s);
    } catch {
      setDaemon(null);
    }
  }, []);

  useEffect(() => {
    load();
    loadDaemon();
  }, [load, loadDaemon]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const parsed = JSON.parse(configText);
      const path = section ? `/config/${section}` : '/config';
      await apiClient.put(path, parsed);
      toast.success(wt('配置已保存'));
    } catch (e) {
      toast.error(wt('保存失败'), e instanceof Error ? e.message : wt('JSON 格式错误'));
    } finally {
      setSaving(false);
    }
  }, [configText, section]);

  const installDaemon = useCallback(async () => {
    try {
      await apiClient.post('/daemon/install', {});
      toast.success(wt('守护进程安装请求已发送'));
      loadDaemon();
    } catch (e) {
      toast.error(wt('安装失败'), e instanceof Error ? e.message : undefined);
    }
  }, [loadDaemon]);

  const startDaemon = useCallback(async () => {
    try {
      await apiClient.post('/daemon/start', {});
      toast.success(wt('守护进程启动请求已发送'));
      loadDaemon();
    } catch (e) {
      toast.error(wt('启动失败'), e instanceof Error ? e.message : undefined);
    }
  }, [loadDaemon]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{t('views.configManage')}</div>
          <div className="page-subtitle">{t('views.editConfigJson')}</div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={load}>
            {t('common.reload')}
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-header">
          <div className="card-title">{wt('守护进程')}</div>
        </div>
        {daemon ? (
          <div className="flex items-center justify-between">
            <div className="flex gap-2 items-center">
              <Badge variant={daemon.installed ? 'success' : 'default'}>
                {daemon.installed ? wt('已安装') : wt('未安装')}
              </Badge>
              <Badge variant={daemon.running ? 'success' : 'danger'}>
                {daemon.running ? wt('运行中') : wt('已停止')}
              </Badge>
              {daemon.pid ? <span className="text-muted">PID {daemon.pid}</span> : null}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={installDaemon}>
                {wt('安装')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={startDaemon}
                disabled={!daemon.installed}
              >
                {wt('启动')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-muted">{wt('无法获取守护进程状态')}</div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">{wt('配置内容')}</div>
          <Input
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder={wt('分区名（可选，如 security）')}
            style={{ width: 260 }}
          />
        </div>
        {loading ? (
          <SpinnerWrap label={wt('加载中…')} />
        ) : (
          <TextArea
            rows={24}
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            className="text-mono"
          />
        )}
      </div>
    </div>
  );
}
