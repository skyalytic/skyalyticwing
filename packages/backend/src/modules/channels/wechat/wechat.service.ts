import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../../core/logger/logger.service.js';
import { HttpClientService } from '../../core/http/http-client.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';

// ─── 架构约束：顶层 require 重命名为 dynamicRequire ───────────────────────────

const dynamicRequire: NodeRequire = require;

/** qrcode 模块最小接口（包未内置类型声明，运行时按需加载） */
interface QrCodeModule {
  toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
}

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/** 扫码会话状态 */
interface QrSession {
  createdAt: number;
  /** 微信 iLink 二维码 key 或企业微信 scode */
  qrKey: string;
  /** 企业微信授权 URL（仅 wecom 使用） */
  authUrl?: string;
  status: 'pending' | 'scanned' | 'confirmed' | 'cancelled' | 'expired';
  /** 最近一次轮询到的上游状态（仅日志用途） */
  lastPollStatus?: string;
}

/** CLI 输出行 */
interface CliOutputLine {
  type: 'out' | 'err';
  text: string;
  ts: number;
}

/** CLI 安装进程状态 */
interface CliProcessState {
  output: CliOutputLine[];
  status: 'running' | 'done' | 'error' | 'confirmed';
  botToken: string | null;
  botId: string | null;
  secret: string | null;
  exitCode?: number;
  startedAt: number;
  pid?: number;
}

/** 二维码获取结果 */
export interface QrResult {
  qrUrl?: string;
  qrData?: string;
  sessionId: string;
  error?: string;
}

/** 轮询结果 */
export interface PollResult {
  status: 'pending' | 'scanned' | 'confirmed' | 'cancelled' | 'expired';
  botToken?: string;
  baseUrl?: string;
  botId?: string;
  secret?: string;
}

/** CLI 状态查询结果 */
export interface CliStatusResult {
  status: string;
  botToken?: string | null;
  botId?: string | null;
  secret?: string | null;
  exitCode?: number;
  output: CliOutputLine[];
  totalLines: number;
}

// ─── 常量（对齐旧版 start.cjs） ──────────────────────────────────────────────

/** 微信扫码会话有效期 180s */
const WEIXIN_SESSION_TTL_MS = 180_000;
/** 企业微信扫码会话有效期 300s */
const WECOM_SESSION_TTL_MS = 300_000;
/** 会话/进程清理间隔 300s（对齐旧版 cleanup 定时器） */
const CLEANUP_INTERVAL_MS = 300_000;
/** CLI 进程记录保留时长 300s */
const CLI_PROCESS_TTL_MS = 300_000;
/** iLink API 基地址 */
const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
/** 企业微信 AI 授权基地址 */
const WECOM_BASE = 'https://work.weixin.qq.com';
/** HTTP 请求超时 */
const HTTP_TIMEOUT_MS = 15_000;
/** 微信 CLI 安装命令 */
const WEIXIN_CLI_CMD = 'npx -y @tencent-weixin/openclaw-weixin-cli@latest install';
/** 企业微信 CLI 安装命令 */
const WECOM_CLI_CMD = 'npx -y @wecom/wecom-openclaw-cli install --force';

/** iLink get_bot_qrcode 响应 */
interface IlinkQrResponse {
  ret?: number;
  qrcode?: string;
  qrcode_img_content?: string;
  errmsg?: string;
}

/** iLink get_qrcode_status 响应 */
interface IlinkStatusResponse {
  status?: string;
  bot_token?: string;
  baseurl?: string;
  base_url?: string;
}

/** 企业微信 query_result 响应 */
interface WecomQueryResponse {
  data?: {
    status?: string;
    bot_info?: { botid?: string; secret?: string };
  };
}

/**
 * WechatService - 微信（iLink Bot）/ 企业微信 扫码登录与 CLI 安装服务
 *
 * 全量对齐旧版 start.cjs 的 _weixinSessions / _weixinCliProcesses 状态机：
 *   - 二维码获取：iLink get_bot_qrcode / 企业微信授权页 window.settings 解析
 *   - 扫码轮询：iLink get_qrcode_status / 企业微信 query_result
 *   - CLI 安装：spawn npx 安装命令，流式解析 bot_token / bot_id / secret
 *   - 会话过期与进程清理定时器
 */
@Injectable()
export class WechatService implements OnModuleInit, OnModuleDestroy {
  /** 扫码会话（weixin 与 wecom 共用，key 为 qrcode / scode） */
  private readonly sessions = new Map<string, QrSession>();
  /** CLI 安装进程：cliId → 状态 */
  private readonly cliProcesses = new Map<string, CliProcessState>();
  /** 运行中的子进程句柄：cliId → ChildProcess */
  private readonly children = new Map<string, ChildProcess>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly qrLib: QrCodeModule | null;

  constructor(
    private readonly logger: LoggerService,
    private readonly http: HttpClientService,
    private readonly security: SecurityManagerService,
  ) {
    let lib: QrCodeModule | null = null;
    try {
      lib = dynamicRequire('qrcode') as QrCodeModule;
    } catch {
      lib = null;
    }
    this.qrLib = lib;
  }

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [cliId, child] of this.children) {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      this.children.delete(cliId);
    }
  }

  // ─── 微信 iLink ────────────────────────────────────────────────────────────

  /**
   * 获取微信登录二维码（对齐旧版 /weixin/qr）。
   * 调用 iLink get_bot_qrcode，成功后生成 dataURL 二维码。
   */
  async getWeixinQr(botType: string): Promise<QrResult> {
    const bt = botType || '3';
    let data: IlinkQrResponse;
    try {
      const resp = await this.http.get<IlinkQrResponse>(
        `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(bt)}`,
        { timeout: HTTP_TIMEOUT_MS, responseType: 'json' },
      );
      data = resp.data;
    } catch (e) {
      return { sessionId: '', error: `iLink API 连接失败: ${errMsg(e)}` };
    }

    if (!data || data.ret !== 0 || !data.qrcode) {
      return {
        sessionId: '',
        error: (data && data.errmsg) || '无法获取二维码',
      };
    }

    const sid = data.qrcode;
    this.sessions.set(sid, {
      createdAt: Date.now(),
      qrKey: data.qrcode,
      status: 'pending',
    });

    const qrContent = data.qrcode_img_content || data.qrcode;
    const dataUrl = await this.renderQrDataUrl(qrContent);
    if (dataUrl) {
      return { qrUrl: dataUrl, sessionId: sid };
    }
    return { qrData: data.qrcode, sessionId: sid };
  }

  /**
   * 轮询微信扫码状态（对齐旧版 /weixin/poll）。
   * 上游异常时返回 pending（对齐旧版容错）。
   */
  async pollWeixin(sessionId: string): Promise<PollResult> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return { status: 'expired' };
    if (Date.now() - sess.createdAt > WEIXIN_SESSION_TTL_MS) {
      return { status: 'expired' };
    }

    let data: IlinkStatusResponse;
    try {
      const resp = await this.http.get<IlinkStatusResponse>(
        `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(sess.qrKey)}`,
        { timeout: HTTP_TIMEOUT_MS, responseType: 'json' },
      );
      data = resp.data;
    } catch {
      return { status: 'pending' };
    }

    const status = data && data.status ? data.status : '';
    if (status === 'confirmed' && data.bot_token) {
      sess.status = 'confirmed';
      return {
        status: 'confirmed',
        botToken: data.bot_token,
        baseUrl: data.baseurl || data.base_url || ILINK_BASE,
      };
    }
    if (status === 'scanned' || status === 'scaning') {
      sess.status = 'scanned';
      return { status: 'scanned' };
    }
    if (status === 'cancelled') {
      sess.status = 'cancelled';
      return { status: 'cancelled' };
    }
    if (status === 'expired') {
      sess.status = 'expired';
      return { status: 'expired' };
    }
    return { status: 'pending' };
  }

  // ─── 企业微信 ─────────────────────────────────────────────────────────────

  /**
   * 获取企业微信授权二维码（对齐旧版 /wecom/qr）。
   * 请求授权页 HTML，解析 window.settings 中的 scode 与 auth_url。
   */
  async getWecomQr(): Promise<QrResult> {
    const state = randomBytes(12).toString('base64url');
    const genUrl = `${WECOM_BASE}/ai/qc/gen?source=skyalyticwing&state=${state}&timestamp=${Date.now()}`;

    let html: string;
    try {
      const resp = await this.http.get<string>(genUrl, {
        timeout: HTTP_TIMEOUT_MS,
        responseType: 'text',
      });
      html = resp.data || '';
    } catch (e) {
      return { sessionId: '', error: `企业微信服务连接失败: ${errMsg(e)}` };
    }

    const settingsMatch =
      html.match(/window\.settings\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i) ||
      html.match(/window\.settings\s*=\s*(\{[\s\S]*?\})\s*\}/);
    if (!settingsMatch) {
      return { sessionId: '', error: '无法解析企业微信授权页面，请检查网络连接' };
    }

    let scode = '';
    let authUrl = '';
    try {
      const settings = JSON.parse(settingsMatch[1]) as { scode?: string; auth_url?: string };
      scode = settings.scode || '';
      authUrl = settings.auth_url || '';
    } catch (e) {
      return { sessionId: '', error: `解析企业微信授权信息失败: ${errMsg(e)}` };
    }
    if (!scode || !authUrl) {
      return { sessionId: '', error: '企业微信授权参数获取失败' };
    }

    this.sessions.set(scode, {
      createdAt: Date.now(),
      qrKey: scode,
      authUrl,
      status: 'pending',
    });

    const dataUrl = await this.renderQrDataUrl(authUrl);
    if (dataUrl) {
      return { qrUrl: dataUrl, sessionId: scode };
    }
    return { qrData: authUrl, sessionId: scode };
  }

  /**
   * 轮询企业微信扫码状态（对齐旧版 /wecom/poll）。
   * 上游异常时返回 pending（对齐旧版容错）。
   */
  async pollWecom(sessionId: string): Promise<PollResult> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return { status: 'expired' };
    if (Date.now() - sess.createdAt > WECOM_SESSION_TTL_MS) {
      return { status: 'expired' };
    }

    let data: WecomQueryResponse;
    try {
      const resp = await this.http.get<WecomQueryResponse>(
        `${WECOM_BASE}/ai/qc/query_result?scode=${encodeURIComponent(sess.qrKey)}`,
        { timeout: HTTP_TIMEOUT_MS, responseType: 'json' },
      );
      data = resp.data;
    } catch {
      return { status: 'pending' };
    }

    const status = (data && data.data && data.data.status) || '';
    const botInfo = (data && data.data && data.data.bot_info) || {};
    if (status !== sess.lastPollStatus) {
      this.logger.debug('WeCom poll status changed', {
        scope: 'wecom',
        from: sess.lastPollStatus || '(none)',
        to: status,
      });
      sess.lastPollStatus = status;
    }

    if (status === 'success' && botInfo.botid) {
      sess.status = 'confirmed';
      return {
        status: 'confirmed',
        botId: botInfo.botid,
        secret: botInfo.secret || '',
      };
    }
    if (status === 'waiting' || status === 'scanning') {
      sess.status = 'scanned';
      return { status: 'scanned' };
    }
    if (status === 'expired' || status === 'timeout') {
      sess.status = 'expired';
      return { status: 'expired' };
    }
    if (status === 'cancelled') {
      sess.status = 'cancelled';
      return { status: 'cancelled' };
    }
    return { status: 'pending' };
  }

  // ─── CLI 安装（weixin / wecom 共用逻辑） ──────────────────────────────────

  /**
   * 启动微信 CLI 安装进程（对齐旧版 /weixin/cli-install）。
   * 命令须通过 SecurityManager.isCommandAllowed 校验。
   */
  startWeixinCli(): { success: boolean; pid?: number; cliId?: string; error?: string } {
    return this.startCliProcess('wxcli', WEIXIN_CLI_CMD);
  }

  /** 启动企业微信 CLI 安装进程（对齐旧版 /wecom/cli-install） */
  startWecomCli(): { success: boolean; pid?: number; cliId?: string; error?: string } {
    return this.startCliProcess('wccli', WECOM_CLI_CMD);
  }

  /** 查询 CLI 安装状态（对齐旧版 /weixin/cli-status、/wecom/cli-status） */
  getCliStatus(cliId: string, since: number): CliStatusResult {
    const proc = this.cliProcesses.get(cliId);
    if (!proc) {
      return { status: 'not_found', output: [], totalLines: 0 };
    }
    const newOutput = proc.output.filter((o) => o.ts > since);
    return {
      status: proc.status,
      botToken: proc.botToken,
      botId: proc.botId,
      secret: proc.secret,
      ...(proc.exitCode !== undefined ? { exitCode: proc.exitCode } : {}),
      output: newOutput.slice(-50),
      totalLines: proc.output.length,
    };
  }

  // ─── 内部辅助 ─────────────────────────────────────────────────────────────

  /** 启动 CLI 进程并挂载输出流解析（bot_token / bot_id / secret） */
  private startCliProcess(
    prefix: string,
    command: string,
  ): { success: boolean; pid?: number; cliId?: string; error?: string } {
    if (!this.security.isCommandAllowed(command)) {
      return { success: false, error: `Command blocked by guard: ${command}` };
    }

    const cliId = `${prefix}-${Date.now()}`;
    const state: CliProcessState = {
      output: [],
      status: 'running',
      botToken: null,
      botId: null,
      secret: null,
      startedAt: Date.now(),
    };
    this.cliProcesses.set(cliId, state);

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArg = process.platform === 'win32' ? '/c' : '-c';
    let child: ChildProcess;
    try {
      child = spawn(shell, [shellArg, command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      });
    } catch (e) {
      state.status = 'error';
      state.output.push({ type: 'err', text: errMsg(e), ts: Date.now() });
      return { success: false, cliId, error: errMsg(e) };
    }

    if (child.pid !== undefined) state.pid = child.pid;
    this.children.set(cliId, child);

    let outBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      outBuf += chunk.toString();
      const lines = outBuf.split('\n');
      outBuf = lines.pop() || '';
      for (const line of lines) {
        this.handleCliLine(cliId, line, 'out');
      }
    });

    let errBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errBuf += chunk.toString();
      const lines = errBuf.split('\n');
      errBuf = lines.pop() || '';
      for (const line of lines) {
        this.handleCliLine(cliId, line, 'err');
      }
    });

    child.on('close', (code) => {
      state.exitCode = code ?? 0;
      if (state.status === 'running') {
        state.status = code === 0 ? 'done' : 'error';
      }
      this.children.delete(cliId);
    });

    child.on('error', (e) => {
      state.status = 'error';
      state.output.push({ type: 'err', text: e.message, ts: Date.now() });
      this.children.delete(cliId);
    });

    this.logger.info('CLI install started', {
      scope: prefix,
      pid: child.pid,
      cliId,
    });
    const pid = child.pid;
    return pid !== undefined ? { success: true, pid, cliId } : { success: true, cliId };
  }

  /** 解析 CLI 输出行：记录日志 + 提取 bot_token / bot_id / secret */
  private handleCliLine(cliId: string, line: string, type: 'out' | 'err'): void {
    const state = this.cliProcesses.get(cliId);
    if (!state) return;
    const text = line.trim();
    if (text) {
      state.output.push({ type, text, ts: Date.now() });
    }

    const tokenMatch = text.match(/bot[_-]?token[:\s=]+([a-zA-Z0-9_\-@:.]+)/i);
    if (tokenMatch) {
      state.botToken = tokenMatch[1];
      state.status = 'confirmed';
    }
    const botIdMatch = text.match(/bot[_-]?id[:\s=]+([a-zA-Z0-9_\-@:.]+)/i);
    if (botIdMatch) {
      state.botId = botIdMatch[1];
    }
    const secretMatch = text.match(/secret[:\s=]+([a-zA-Z0-9_\-@:.]+)/i);
    if (secretMatch) {
      state.secret = secretMatch[1];
    }
    if (state.botId && state.secret) {
      state.status = 'confirmed';
    }
  }

  /** 渲染二维码 dataURL（qrcode 模块不可用时返回 null，对齐旧版降级） */
  private async renderQrDataUrl(content: string): Promise<string | null> {
    if (!this.qrLib || !content) return null;
    try {
      return await this.qrLib.toDataURL(content, { width: 256, margin: 2 });
    } catch {
      return null;
    }
  }

  /** 定期清理过期会话与已结束的 CLI 进程记录（对齐旧版 cleanup 定时器） */
  private cleanup(): void {
    const now = Date.now();
    for (const [sid, sess] of this.sessions) {
      if (now - sess.createdAt > CLEANUP_INTERVAL_MS) {
        this.sessions.delete(sid);
      }
    }
    for (const [cliId, proc] of this.cliProcesses) {
      if (now - proc.startedAt > CLI_PROCESS_TTL_MS) {
        this.cliProcesses.delete(cliId);
      }
    }
  }
}

/** 错误信息提取 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
