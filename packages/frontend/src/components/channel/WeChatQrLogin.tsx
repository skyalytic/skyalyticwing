// 微信/企业微信扫码登录组件（对齐旧版 channel.js startWeixinQR/startWecomQR/CLI 流程）
// 状态流：pending → scanned → confirmed（confirmed 时自动回填凭据）；expired/cancelled 提示刷新
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/services/api-client';

/** 扫码轮询间隔（对齐旧版 3s） */
const POLL_INTERVAL_MS = 3_000;
/** 微信扫码轮询最大次数（后端 iLink 会话 TTL 180s ≈ 60 次） */
const POLL_MAX_TRIES_WEIXIN = 60;
/** 企微扫码轮询最大次数（后端企微会话 TTL 300s ≈ 100 次） */
const POLL_MAX_TRIES_WECOM = 100;
/** CLI 状态轮询间隔（对齐旧版 2s） */
const CLI_POLL_INTERVAL_MS = 2_000;

interface QrResponse {
  qrUrl?: string;
  qrData?: string;
  sessionId: string;
  error?: string;
}

interface PollResponse {
  status: 'pending' | 'scanned' | 'confirmed' | 'cancelled' | 'expired';
  botToken?: string;
  baseUrl?: string;
  botId?: string;
  secret?: string;
}

interface CliInstallResponse {
  success: boolean;
  pid?: number;
  cliId?: string;
  error?: string;
}

interface CliStatusResponse {
  status: string;
  botToken?: string | null;
  botId?: string | null;
  secret?: string | null;
  exitCode?: number;
  output: { type: 'out' | 'err'; text: string; ts: number }[];
  totalLines: number;
}

export interface WeChatQrLoginProps {
  /** weixin = 微信 iLink（/weixin/*）；wecom = 企业微信（/wecom/*） */
  variant: 'weixin' | 'wecom';
  /** 扫码/CLI 成功后回填表单字段（botToken/baseUrl 或 botId/secret） */
  onFill: (values: Record<string, string>) => void;
}

/**
 * 扫码登录区块：二维码展示 + 轮询 + CLI 安装降级路径。
 * 卸载时清理全部轮询定时器，避免定时器泄漏（对齐旧版 _clearAllPollTimers）。
 */
export function WeChatQrLogin({ variant, onFill }: WeChatQrLoginProps) {
  const { t } = useTranslation();
  const prefix = variant === 'weixin' ? '/weixin' : '/wecom';
  const isWeixin = variant === 'weixin';
  const pollMaxTries = isWeixin ? POLL_MAX_TRIES_WEIXIN : POLL_MAX_TRIES_WECOM;

  const [qrUrl, setQrUrl] = useState('');
  const [qrData, setQrData] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [cliStatus, setCliStatus] = useState('');
  const [cliOutput, setCliOutput] = useState('');
  const [cliBusy, setCliBusy] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cliTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 组件卸载后拒绝继续轮询 */
  const disposed = useRef(false);
  const flowId = useRef(0);
  const fillRef = useRef(onFill);
  fillRef.current = onFill;

  const stopTimers = useCallback(() => {
    flowId.current++;
    if (!disposed.current) {
      setLoading(false);
      setCliBusy(false);
    }
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (cliTimer.current) {
      clearInterval(cliTimer.current);
      cliTimer.current = null;
    }
  }, []);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      stopTimers();
    };
  }, [stopTimers]);

  /** 轮询扫码状态：pending → scanned → confirmed（回填凭据并停止） */
  const startPolling = useCallback(
    (sessionId: string) => {
      if (!sessionId) return;
      if (pollTimer.current) clearInterval(pollTimer.current);
      const flow = flowId.current;
      let inFlight = false;
      let tries = 0;
      pollTimer.current = setInterval(async () => {
        if (disposed.current || flow !== flowId.current || inFlight) return;
        tries++;
        if (tries > pollMaxTries) {
          stopTimers();
          setStatus(t('channels.qrTimeout'));
          return;
        }
        inFlight = true;
        try {
          const r = await apiClient.get<PollResponse>(
            `${prefix}/poll?sessionId=${encodeURIComponent(sessionId)}`,
          );
          if (disposed.current || flow !== flowId.current) return;
          if (r.status === 'scanned') {
            setStatus(t('channels.pollScanned'));
          } else if (r.status === 'confirmed') {
            stopTimers();
            if (isWeixin && r.botToken) {
              fillRef.current({ botToken: r.botToken, ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}) });
            } else if (r.botId) {
              fillRef.current({ botId: r.botId, secret: r.secret ?? '' });
            }
            setStatus(t('channels.loginSuccess'));
          } else if (r.status === 'expired') {
            stopTimers();
            setStatus(t('channels.qrExpired'));
          } else if (r.status === 'cancelled') {
            stopTimers();
            setStatus(t('channels.loginCancelled'));
          }
        } catch {
          /* 轮询失败静默，下次重试 */
        } finally { inFlight = false; }
      }, POLL_INTERVAL_MS);
    },
    [prefix, isWeixin, pollMaxTries, stopTimers, t],
  );

  /** 获取二维码并开始轮询（对齐旧版 startWeixinQR/startWecomQR） */
  const fetchQr = useCallback(async () => {
    stopTimers();
    const flow = flowId.current;
    setLoading(true);
    setStatus(t('channels.generatingQr'));
    setQrUrl('');
    setQrData('');
    try {
      // 后端 qr 端点从 @Query('bot_type') 读取，须以 URL query 传参（对齐 wechat.controller）
      const r = isWeixin
        ? await apiClient.post<QrResponse>('/weixin/qr?bot_type=3')
        : await apiClient.post<QrResponse>('/wecom/qr');
      if (disposed.current || flow !== flowId.current) return;
      if (r.qrUrl) {
        setQrUrl(r.qrUrl);
        setStatus(
          t('channels.scanPrompt', { app: isWeixin ? t('channels.wechat') : t('channels.wecom') }),
        );
        startPolling(r.sessionId);
      } else if (r.qrData) {
        setQrData(r.qrData);
        setStatus(t('channels.gotQrData'));
        startPolling(r.sessionId);
      } else {
        setStatus(`❌ ${r.error || t('channels.qrUnavailable')}`);
      }
    } catch (e) {
      if (!disposed.current && flow === flowId.current) {
        setStatus(`❌ ${t('channels.networkError')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (!disposed.current && flow === flowId.current) setLoading(false);
    }
  }, [isWeixin, startPolling, stopTimers, t]);

  /** CLI 安装降级路径（对齐旧版 startWeixinCLI）：增量拉取输出并提取凭据 */
  const startCli = useCallback(async () => {
    stopTimers();
    const flow = flowId.current;
    setCliBusy(true);
    setCliOutput('');
    setCliStatus(t('channels.cliStarting'));
    try {
      // 这些端点返回含 success 字段的裸对象，须 raw 避免被 ApiResponse 解包
      const r = await apiClient.post<CliInstallResponse>(`${prefix}/cli-install`, {}, { raw: true });
      if (disposed.current || flow !== flowId.current) return;
      if (!r.success || !r.cliId) {
        setCliStatus(`❌ ${t('channels.cliStartFailed')}: ${r.error || t('channels.unknownError')}`);
        return;
      }
      setCliStatus(`${t('channels.cliStarted')} (PID: ${r.pid ?? '-'})`);
      const cliId = r.cliId;
      let lastTs = 0;
      let inFlight = false;
      cliTimer.current = setInterval(async () => {
        if (disposed.current || flow !== flowId.current || inFlight) return;
        inFlight = true;
        try {
          const sr = await apiClient.get<CliStatusResponse>(
            `${prefix}/cli-status?cliId=${encodeURIComponent(cliId)}&since=${lastTs}`,
          );
          if (disposed.current || flow !== flowId.current) return;
          if (sr.output && sr.output.length > 0) {
            setCliOutput((prev) => prev + sr.output.map((o) => `${o.text}\n`).join(''));
            lastTs = sr.output[sr.output.length - 1].ts;
          }
          if (sr.botToken) {
            stopTimers();
            fillRef.current({ botToken: sr.botToken });
            setCliStatus(t('channels.loginSuccessToken'));
          } else if (sr.botId && sr.secret) {
            stopTimers();
            fillRef.current({ botId: sr.botId, secret: sr.secret });
            setCliStatus(t('channels.loginSuccess'));
          } else if (sr.status === 'done') {
            stopTimers();
            setCliStatus(t('channels.cliDone'));
          } else if (sr.status === 'error') {
            stopTimers();
            setCliStatus(`❌ ${t('channels.cliFailed', { code: sr.exitCode ?? '?' })}`);
          } else if (sr.status === 'not_found') {
            stopTimers();
            setCliStatus(`❌ ${t('channels.cliNotFound')}`);
          }
        } catch {
          /* 轮询失败静默，下次重试 */
        } finally { inFlight = false; }
      }, CLI_POLL_INTERVAL_MS);
    } catch (e) {
      if (!disposed.current && flow === flowId.current) {
        setCliStatus(`❌ ${t('channels.cliStartFailed')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (!disposed.current && flow === flowId.current) setCliBusy(false);
    }
  }, [prefix, stopTimers, t]);

  return (
    <div className="border-t border-gray-700 pt-3 mt-3" data-testid="wechat-qr-login">
      <div className="flex items-center gap-2 mb-2">
        <button className="btn-primary text-xs" onClick={fetchQr} disabled={loading}>
          {loading
            ? t('channels.generating')
            : qrUrl || qrData
              ? t('channels.refreshQr')
              : t('channels.qrLogin')}
        </button>
        <button className="btn-secondary text-xs" onClick={startCli} disabled={cliBusy}>
          {t('channels.cliInstall')}
        </button>
      </div>
      {status ? (
        <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }} data-testid="qr-status">
          {status}
        </div>
      ) : null}
      {qrUrl ? (
        <img
          src={qrUrl}
          alt={t('channels.qrAlt')}
          style={{ width: 220, height: 220, borderRadius: 8 }}
        />
      ) : qrData ? (
        <div
          className="text-xs break-all p-2 rounded"
          style={{ background: 'var(--bg-soft)', maxWidth: 320, color: 'var(--text-muted)' }}
        >
          {qrData.slice(0, 200)}
        </div>
      ) : null}
      {cliStatus ? (
        <div className="text-xs mt-2" data-testid="cli-status">
          {cliStatus}
        </div>
      ) : null}
      {cliOutput ? (
        <pre
          className="text-xs mt-1 p-2 rounded overflow-auto"
          style={{ background: 'var(--bg-soft)', maxHeight: 140, whiteSpace: 'pre-wrap' }}
        >
          {cliOutput}
        </pre>
      ) : null}
    </div>
  );
}
