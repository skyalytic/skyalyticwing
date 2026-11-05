import { Injectable, OnModuleInit } from '@nestjs/common';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';
import { ConfigService } from '../../core/config/config.service.js';

// ============================================================
// 平台标识
// ============================================================

const PLAT = platform();
const IS_WIN = PLAT === 'win32';
const IS_MAC = PLAT === 'darwin';
const IS_LINUX = PLAT === 'linux' || PLAT === 'freebsd';

// ============================================================
// 类型定义
// ============================================================

/** 安装选项 */
export interface InstallOptions {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workingDir?: string;
  autoStart?: boolean;
  displayName?: string;
  description?: string;
}

/** 命令执行结果 */
export interface CmdResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** 安装结果 */
export interface InstallResult {
  success: boolean;
  error?: string;
  path?: string;
  method?: string;
  taskName?: string;
}

/** 通用操作结果 */
export interface OpResult {
  success: boolean;
  error?: string;
  bridgeId?: string;
  path?: string;
}

/** 环境变量操作结果 */
export interface EnvOpResult {
  success: boolean;
  error?: string;
}

/** 守护进程状态（兼容控制器契约并扩展） */
export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptime?: number;
  platform?: string;
  manager?: string;
  installed?: boolean;
  autoStart?: boolean;
  plistPath?: string;
  label?: string;
  servicePath?: string;
  serviceName?: string;
  taskName?: string;
  taskDetails?: string;
  startupFallback?: boolean;
  startupPath?: string;
  systemdStatus?: string;
}

/** 运行时信息 */
export interface RuntimeInfo {
  plistPath?: string;
  label?: string;
  servicePath?: string;
  serviceName?: string;
  taskName?: string;
  dataDir?: string;
  workingDir?: string;
  stdoutLog?: string;
  stderrLog?: string;
  execStart?: string;
  setupScript?: string;
}

/** 诊断检查项 */
export interface DiagCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  message: string;
}

/** 诊断结果 */
export interface DiagnoseResult {
  platform: string;
  checks: DiagCheck[];
  overall: 'pass' | 'warn' | 'fail' | 'unknown';
}

/** 日志条目 */
export interface LogEntry {
  file: string;
  line: string;
}

/** 重启历史条目 */
export interface RestartHistoryEntry {
  timestamp: string;
  event: string;
}

/** 平台守护进程服务契约 */
interface PlatformDaemonService {
  install(options: InstallOptions): InstallResult;
  uninstall(): OpResult;
  start(): OpResult;
  stop(): OpResult;
  restart(): OpResult;
  isInstalled(): boolean;
  isRunning(): boolean;
  getStatus(): DaemonStatus;
  /**
   * 异步状态查询（可选实现）：命令执行不阻塞 Node 事件循环。
   * Windows 实现必须提供——同步 getStatus 的 execFileSync 会冻结整个后端
   * （schtasks/PowerShell 单次 1-3s × 串行 5-8 次），拖垮所有并发请求；
   * mac/linux 命令轻量（launchctl/systemctl 毫秒级），可缺省回退同步版。
   */
  getStatusAsync?(): Promise<DaemonStatus>;
  setAutoStart(enabled: boolean): boolean;
  readRuntime(): RuntimeInfo | null;
  setEnv(key: string, value: string): EnvOpResult;
  getEnv(): Record<string, string>;
  removeEnv(key: string): EnvOpResult;
}

// ============================================================
// 通用工具函数
// ============================================================

/**
 * 执行命令（使用数组参数，不走 shell，避免命令注入）
 * 兼容原 daemon-manager.cjs 的 _run，但改用 execFileSync + args 数组
 */
function runCmd(cmd: string, args: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): CmdResult {
  try {
    const result = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: options?.timeout || 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: { ...process.env, ...(options?.env || {}) },
      windowsHide: true,
    });
    return { success: true, stdout: (result || '').trim(), stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim(),
      ...(e.message ? { error: e.message } : {}),
    };
  }
}

/**
 * 执行命令（异步版）：execFile + 数组参数，不阻塞 Node 事件循环。
 * 与 runCmd 行为一致（timeout/编码/trim），供状态查询等热路径使用——
 * 同步版 execFileSync 在 schtasks/PowerShell 调用期间会冻结整个后端，
 * 导致所有并发请求（技能页/会话页等）排队"加载中"。
 */
const execFileAsync = promisify(execFile);

async function runCmdAsync(cmd: string, args: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string> }): Promise<CmdResult> {
  try {
    const result = await execFileAsync(cmd, args, {
      encoding: 'utf8',
      timeout: options?.timeout || 15000,
      killSignal: 'SIGKILL',
      windowsHide: true,
      cwd: options?.cwd,
      env: { ...process.env, ...(options?.env || {}) },
    });
    return { success: true, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: (e.stdout || '').trim(),
      stderr: (e.stderr || '').trim(),
      ...(e.message ? { error: e.message } : {}),
    };
  }
}

/** XML 转义 */
function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// H-D2: escape Windows cmd metacharacters with ^ then wrap in double quotes for safe .cmd file embedding.
// Defense-in-depth: the ^ escapes neutralize metacharacters if a quote is stripped; the double-quote
// wrapping neutralizes them when the arg is parsed normally by cmd.exe.
/** 转义 Windows cmd 元字符（H-D2 防注入） */
function escapeCmdArg(arg: string): string {
  let s = String(arg == null ? '' : arg);
  // 用脱字符(^)转义 cmd 元字符
  s = s.replace(/([&|<>()^%!])/g, '^$1');
  // 内部双引号翻倍，整体用双引号包裹
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 检测平台 */
function detectPlatform(): string {
  if (IS_MAC) return 'macos';
  if (IS_LINUX) return 'linux';
  if (IS_WIN) return 'windows';
  return 'unknown';
}

// ============================================================
// macOS launchd 实现
// ============================================================

/**
 * LaunchdService - macOS launchd 守护进程管理
 * 全量移植自 daemon-manager.cjs LaunchdService
 */
export class LaunchdService implements PlatformDaemonService {
  label = 'com.skyalyticwing.gateway';
  plistName = this.label + '.plist';
  plistDir = join(homedir(), 'Library', 'LaunchAgents');
  plistPath = join(this.plistDir, this.plistName);
  logDir: string;
  stdoutLog: string;
  stderrLog: string;
  envFile: string;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private dataDir: string, private logger: LoggerService) {
    this.logDir = join(dataDir, 'logs');
    this.stdoutLog = join(this.logDir, 'gateway-stdout.log');
    this.stderrLog = join(this.logDir, 'gateway-stderr.log');
    this.envFile = join(dataDir, 'gateway.env');
  }

  install(options: InstallOptions): InstallResult {
    const command = options.command || process.execPath;
    const args = options.args || [];
    const env = options.env || {};
    const workingDir = options.workingDir || this.dataDir;
    const autoStart = options.autoStart !== false;

    try {
      if (!existsSync(this.plistDir)) mkdirSync(this.plistDir, { recursive: true });
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });

      const programArguments: string[] = [];
      programArguments.push('      <string>' + escapeXml(command) + '</string>');
      for (const arg of args) {
        programArguments.push('      <string>' + escapeXml(String(arg)) + '</string>');
      }

      const envKeys = Object.keys(env);
      const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        '  <string>' + escapeXml(this.label) + '</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...programArguments,
        '  </array>',
        '  <key>WorkingDirectory</key>',
        '  <string>' + escapeXml(workingDir) + '</string>',
      ];

      if (envKeys.length > 0) {
        plist.push('  <key>EnvironmentVariables</key>', '  <dict>');
        for (const k of envKeys) {
          plist.push('    <key>' + escapeXml(k) + '</key>');
          plist.push('    <string>' + escapeXml(String(env[k])) + '</string>');
        }
        plist.push('  </dict>');
      }

      plist.push(
        '  <key>RunAtLoad</key>',
        '  <' + (autoStart ? 'true' : 'false') + '/>',
        '  <key>KeepAlive</key>',
        '  <true/>',
        '  <key>ProcessType</key>',
        '  <string>Interactive</string>',
        '  <key>ThrottleInterval</key>',
        '  <integer>10</integer>',
        '  <key>ExitTimeOut</key>',
        '  <integer>20</integer>',
        '  <key>StandardOutPath</key>',
        '  <string>' + escapeXml(this.stdoutLog) + '</string>',
        '  <key>StandardErrorPath</key>',
        '  <string>' + escapeXml(this.stderrLog) + '</string>',
        '  <key>SoftResourceLimits</key>',
        '  <dict>',
        '    <key>NumberOfFiles</key>',
        '    <integer>65536</integer>',
        '  </dict>',
        '  <key>Umask</key>',
        '  <integer>63</integer>',
        '</dict>',
        '</plist>',
      );

      writeFileSync(this.plistPath, plist.join('\n'), 'utf8');
      this.logger.info('[daemon] LaunchAgent plist written to ' + this.plistPath);

      this.saveEnvFile(env);

      const loadResult = runCmd('launchctl', ['load', this.plistPath]);
      if (!loadResult.success) {
        this.logger.warn('[daemon] launchctl load failed: ' + loadResult.stderr);
        return { success: false, error: 'launchctl load failed: ' + (loadResult.stderr || loadResult.error) };
      }

      this.logger.info('[daemon] Service installed and loaded');
      return { success: true, path: this.plistPath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('[daemon] Install error: ' + msg);
      return { success: false, error: msg };
    }
  }

  uninstall(): OpResult {
    // H-D4: cancel any pending restart before uninstalling
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      if (this.isInstalled()) {
        runCmd('launchctl', ['unload', this.plistPath]);
      }
      if (existsSync(this.plistPath)) {
        unlinkSync(this.plistPath);
      }
      this.logger.info('[daemon] Service uninstalled');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('[daemon] Uninstall error: ' + msg);
      return { success: false, error: msg };
    }
  }

  start(): OpResult {
    if (!this.isInstalled()) {
      return { success: false, error: 'Service not installed' };
    }
    const r = runCmd('launchctl', ['load', this.plistPath]);
    if (r.success) {
      this.logger.info('[daemon] Service started');
    } else {
      this.logger.warn('[daemon] Start failed: ' + (r.stderr || r.error));
    }
    return r;
  }

  stop(): OpResult {
    // H-D4: cancel any pending restart so we don't auto-restart after an explicit stop
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.isInstalled()) {
      return { success: false, error: 'Service not installed' };
    }
    const r = runCmd('launchctl', ['unload', this.plistPath]);
    if (r.success) {
      this.logger.info('[daemon] Service stopped');
    }
    return r;
  }

  restart(): OpResult {
    const stopResult = this.stop();
    if (!stopResult.success) {
      // stop 失败时不再乐观返回成功，直接透传失败原因
      return {
        success: false,
        error: 'Stop failed: ' + (stopResult.error || 'unknown error'),
      };
    }
    // H-D4: save the timer handle so uninstall/stop can cancel the pending start
    this.restartTimer = setTimeout(() => {
      this.start();
    }, 500);
    return { success: true };
  }

  isInstalled(): boolean {
    return existsSync(this.plistPath);
  }

  isRunning(): boolean {
    const r = runCmd('launchctl', ['list', this.label]);
    if (!r.success) return false;
    return r.stdout.indexOf('PID') >= 0 || r.stdout.indexOf('Running') >= 0;
  }

  getStatus(): DaemonStatus {
    const installed = this.isInstalled();
    const running = installed && this.isRunning();
    const status: DaemonStatus = {
      platform: 'macos',
      manager: 'launchd',
      installed,
      running,
      autoStart: false,
      plistPath: this.plistPath,
      label: this.label,
    };
    if (installed && existsSync(this.plistPath)) {
      try {
        const plistContent = readFileSync(this.plistPath, 'utf8');
        status.autoStart = /<key>RunAtLoad<\/key>\s*<true\/>/.test(plistContent);
      } catch {
        // 忽略
      }
    }
    if (running) {
      const listResult = runCmd('launchctl', ['list', this.label]);
      if (listResult.success) {
        const pidMatch = listResult.stdout.match(/PID\s*=\s*(\d+)/);
        if (pidMatch) status.pid = parseInt(pidMatch[1], 10);
      }
    }
    return status;
  }

  setAutoStart(enabled: boolean): boolean {
    if (!this.isInstalled()) return false;
    try {
      let content = readFileSync(this.plistPath, 'utf8');
      if (enabled) {
        content = content.replace(/<key>RunAtLoad<\/key>\s*<false\/>/, '<key>RunAtLoad</key><true/>');
        if (!/<key>RunAtLoad<\/key>/.test(content)) {
          content = content.replace('</dict>', '<key>RunAtLoad</key><true/></dict>');
        }
      } else {
        content = content.replace(/<key>RunAtLoad<\/key>\s*<true\/>/, '<key>RunAtLoad</key><false/>');
        if (!/<key>RunAtLoad<\/key>/.test(content)) {
          content = content.replace('</dict>', '<key>RunAtLoad</key><false/></dict>');
        }
      }
      writeFileSync(this.plistPath, content, 'utf8');
      runCmd('launchctl', ['unload', this.plistPath]);
      runCmd('launchctl', ['load', this.plistPath]);
      return true;
    } catch {
      return false;
    }
  }

  readRuntime(): RuntimeInfo | null {
    if (!this.isInstalled()) return null;
    try {
      const content = readFileSync(this.plistPath, 'utf8');
      const runtime: RuntimeInfo = { plistPath: this.plistPath, label: this.label };
      const labelMatch = content.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
      if (labelMatch) runtime.label = labelMatch[1];
      const workDirMatch = content.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
      if (workDirMatch) runtime.workingDir = workDirMatch[1];
      const stdoutMatch = content.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/);
      if (stdoutMatch) runtime.stdoutLog = stdoutMatch[1];
      const stderrMatch = content.match(/<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/);
      if (stderrMatch) runtime.stderrLog = stderrMatch[1];
      return runtime;
    } catch {
      return null;
    }
  }

  /** 保存环境变量文件（M-D17: key="value" 格式） */
  private saveEnvFile(env: Record<string, string>): void {
    try {
      const lines: string[] = [];
      const keys = Object.keys(env || {});
      for (const k of keys) {
        lines.push(k + '="' + String(env[k]).replace(/"/g, '\\"') + '"');
      }
      writeFileSync(this.envFile, lines.join('\n'), 'utf8');
    } catch (err) {
      this.logger.warn('[daemon] Failed to save env file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 读取环境变量文件 */
  private readEnvFile(): Record<string, string> {
    try {
      if (!existsSync(this.envFile)) return {};
      const content = readFileSync(this.envFile, 'utf8');
      const env: Record<string, string> = {};
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.indexOf('#') === 0) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        // 不再用 JSON.parse 解析值——改用引号剥离
        if (
          (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
          (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")
        ) {
          val = val.substring(1, val.length - 1).replace(/\\"/g, '"');
        }
        env[key] = val;
      }
      return env;
    } catch {
      return {};
    }
  }

  setEnv(key: string, value: string): EnvOpResult {
    const env = this.readEnvFile();
    env[key] = String(value);
    this.saveEnvFile(env);
    if (this.isInstalled()) {
      this.logger.info('[daemon] Environment variable updated. Reinstall service to apply changes.');
    }
    return { success: true };
  }

  getEnv(): Record<string, string> {
    return this.readEnvFile();
  }

  removeEnv(key: string): EnvOpResult {
    const env = this.readEnvFile();
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      this.saveEnvFile(env);
      return { success: true };
    }
    return { success: false, error: 'Key not found' };
  }
}

// ============================================================
// Linux systemd 实现
// ============================================================

/**
 * SystemdService - Linux systemd 用户级守护进程管理
 * 全量移植自 daemon-manager.cjs SystemdService
 */
export class SystemdService implements PlatformDaemonService {
  serviceName = 'skyalyticwing';
  systemdDir = join(homedir(), '.config', 'systemd', 'user');
  servicePath = join(this.systemdDir, this.serviceName + '.service');
  envFile: string;
  logDir: string;

  constructor(private dataDir: string, private logger: LoggerService) {
    this.envFile = join(this.dataDir, 'gateway.env');
    this.logDir = join(dataDir, 'logs');
  }

  install(options: InstallOptions): InstallResult {
    const name = options.name || 'SkyAlyticWing Gateway';
    const command = options.command || process.execPath;
    const args = options.args || [];
    const env = options.env || {};
    const workingDir = options.workingDir || this.dataDir;
    const autoStart = options.autoStart !== false;
    const description = options.description || name;

    try {
      if (!existsSync(this.systemdDir)) mkdirSync(this.systemdDir, { recursive: true });
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });

      const execStart =
        command +
        (args.length > 0
          ? ' ' +
            args
              .map((a) => (a.indexOf(' ') >= 0 ? '"' + a + '"' : a))
              .join(' ')
          : '');

      const unit = [
        '[Unit]',
        'Description=' + description,
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=' + execStart,
        'WorkingDirectory=' + workingDir,
        'Restart=always',
        'RestartSec=5',
        'StartLimitBurst=5',
        'StartLimitIntervalSec=60',
        'KillMode=control-group',
        'TimeoutStopSec=30',
        'TimeoutStartSec=30',
        'EnvironmentFile=' + this.envFile,
        'StandardOutput=append:' + join(this.logDir, 'gateway-stdout.log'),
        'StandardError=append:' + join(this.logDir, 'gateway-stderr.log'),
        '',
        '[Install]',
        'WantedBy=default.target',
      ];

      this.saveEnvFile(env);
      writeFileSync(this.servicePath, unit.join('\n'), 'utf8');
      this.logger.info('[daemon] systemd unit written to ' + this.servicePath);

      runCmd('systemctl', ['--user', 'daemon-reload']);

      if (autoStart) {
        runCmd('systemctl', ['--user', 'enable', this.serviceName + '.service']);
      }

      this.logger.info('[daemon] Service installed');
      return { success: true, path: this.servicePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('[daemon] Install error: ' + msg);
      return { success: false, error: msg };
    }
  }

  uninstall(): OpResult {
    try {
      if (this.isInstalled()) {
        this.stop();
        runCmd('systemctl', ['--user', 'disable', this.serviceName + '.service']);
      }
      if (existsSync(this.servicePath)) {
        unlinkSync(this.servicePath);
      }
      runCmd('systemctl', ['--user', 'daemon-reload']);
      this.logger.info('[daemon] Service uninstalled');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('[daemon] Uninstall error: ' + msg);
      return { success: false, error: msg };
    }
  }

  start(): OpResult {
    if (!this.isInstalled()) {
      return { success: false, error: 'Service not installed' };
    }
    const r = runCmd('systemctl', ['--user', 'start', this.serviceName + '.service']);
    if (r.success) {
      this.logger.info('[daemon] Service started');
    } else {
      this.logger.warn('[daemon] Start failed: ' + (r.stderr || r.error));
    }
    return r;
  }

  stop(): OpResult {
    if (!this.isInstalled()) {
      return { success: false, error: 'Service not installed' };
    }
    const r = runCmd('systemctl', ['--user', 'stop', this.serviceName + '.service']);
    if (r.success) {
      this.logger.info('[daemon] Service stopped');
    }
    return r;
  }

  restart(): OpResult {
    if (!this.isInstalled()) {
      return { success: false, error: 'Service not installed' };
    }
    const r = runCmd('systemctl', ['--user', 'restart', this.serviceName + '.service']);
    if (r.success) {
      this.logger.info('[daemon] Service restarted');
    }
    return r;
  }

  isInstalled(): boolean {
    return existsSync(this.servicePath);
  }

  isRunning(): boolean {
    const r = runCmd('systemctl', ['--user', 'is-active', this.serviceName + '.service']);
    return r.success && r.stdout.trim() === 'active';
  }

  getStatus(): DaemonStatus {
    const installed = this.isInstalled();
    const running = installed && this.isRunning();
    const status: DaemonStatus = {
      platform: 'linux',
      manager: 'systemd',
      installed,
      running,
      autoStart: false,
      servicePath: this.servicePath,
      serviceName: this.serviceName,
    };
    if (installed) {
      const isEnabled = runCmd('systemctl', ['--user', 'is-enabled', this.serviceName + '.service']);
      status.autoStart = isEnabled.success && isEnabled.stdout.trim() === 'enabled';
    }
    if (installed) {
      const statusResult = runCmd('systemctl', ['--user', 'status', this.serviceName + '.service']);
      if (statusResult.success || statusResult.stdout) {
        const pidMatch = statusResult.stdout.match(/Main PID:\s*(\d+)/);
        if (pidMatch) status.pid = parseInt(pidMatch[1], 10);
        status.systemdStatus = statusResult.stdout.trim();
      }
    }
    return status;
  }

  setAutoStart(enabled: boolean): boolean {
    if (!this.isInstalled()) return false;
    const r = enabled
      ? runCmd('systemctl', ['--user', 'enable', this.serviceName + '.service'])
      : runCmd('systemctl', ['--user', 'disable', this.serviceName + '.service']);
    return r.success;
  }

  readRuntime(): RuntimeInfo | null {
    if (!this.isInstalled()) return null;
    try {
      const content = readFileSync(this.servicePath, 'utf8');
      const runtime: RuntimeInfo = { servicePath: this.servicePath, serviceName: this.serviceName };
      const execMatch = content.match(/ExecStart=(.+)/);
      if (execMatch) runtime.execStart = execMatch[1].trim();
      const workDirMatch = content.match(/WorkingDirectory=(.+)/);
      if (workDirMatch) runtime.workingDir = workDirMatch[1].trim();
      return runtime;
    } catch {
      return null;
    }
  }

  /** 保存环境变量文件 */
  private saveEnvFile(env: Record<string, string>): void {
    try {
      const lines: string[] = [];
      const keys = Object.keys(env || {});
      for (const k of keys) {
        lines.push(k + '="' + String(env[k]).replace(/"/g, '\\"') + '"');
      }
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.envFile, lines.join('\n'), 'utf8');
    } catch (err) {
      this.logger.warn('[daemon] Failed to save env file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 读取环境变量文件 */
  private readEnvFile(): Record<string, string> {
    try {
      if (!existsSync(this.envFile)) return {};
      const content = readFileSync(this.envFile, 'utf8');
      const env: Record<string, string> = {};
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.indexOf('#') === 0) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        if (
          (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
          (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")
        ) {
          val = val.substring(1, val.length - 1);
        }
        env[key] = val;
      }
      return env;
    } catch {
      return {};
    }
  }

  setEnv(key: string, value: string): EnvOpResult {
    const env = this.readEnvFile();
    env[key] = String(value);
    this.saveEnvFile(env);
    if (this.isRunning()) {
      runCmd('systemctl', ['--user', 'restart', this.serviceName + '.service']);
      this.logger.info('[daemon] Service restarted to apply env change');
    }
    return { success: true };
  }

  getEnv(): Record<string, string> {
    return this.readEnvFile();
  }

  removeEnv(key: string): EnvOpResult {
    const env = this.readEnvFile();
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      this.saveEnvFile(env);
      if (this.isRunning()) {
        runCmd('systemctl', ['--user', 'restart', this.serviceName + '.service']);
      }
      return { success: true };
    }
    return { success: false, error: 'Key not found' };
  }
}

// ============================================================
// Windows schtasks 实现
// ============================================================

/**
 * SchtasksService - Windows 计划任务守护进程管理
 * 全量移植自 daemon-manager.cjs SchtasksService
 * IS_WIN 平台守卫：所有 Windows 专用 API 仅在 Windows 上执行
 */
export class SchtasksService implements PlatformDaemonService {
  /** 当前计划任务名（SkyalyticWing 改名后）；历史任务名 SkyAlyticClawGateway /
   *  Skyalyticclaw Gateway 由 cleanupLegacyAutostartEntries 与 uninstall 兜底清理 */
  taskName = 'SkyAlyticWingGateway';
  envFile: string;
  logDir: string;
  startupDir = join(
    homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  startupScript = join(this.startupDir, 'skyalyticwing-gateway.cmd');
  /** H-D5: 降级安装的 VBS 入口（隐藏窗口）；旧 .cmd 入口仅保留路径用于清理遗留 */
  startupVbs = join(this.startupDir, 'skyalyticwing-gateway.vbs');
  /** 上一版（SkyalyticClaw 命名）在 Startup 目录可能遗留的全部入口形态，
   *  供各清理点统一引用（改名 SkyalyticWing 后的升级残留清理） */
  private readonly legacyStartupFiles = [
    join(this.startupDir, 'skyalyticclaw-gateway.cmd'),
    join(this.startupDir, 'skyalyticclaw-gateway.vbs'),
    join(this.startupDir, 'skyalyticclaw-hidden.vbs'),
    join(this.startupDir, 'skyalyticclaw.cmd'),
    join(this.startupDir, 'SkyAlyticClaw.lnk'),
  ];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private dataDir: string,
    private logger: LoggerService,
    private gatewayPort = 19111,
  ) {
    this.envFile = join(dataDir, 'gateway.env');
    this.logDir = join(dataDir, 'logs');
  }

  install(options: InstallOptions): InstallResult {
    const command = options.command || process.execPath;
    const args = options.args || [];
    const env = options.env || {};
    const workingDir = options.workingDir || this.dataDir;
    const autoStart = options.autoStart !== false;
    const description = options.description || options.name || 'SkyAlyticWing Gateway';

    // H-D2: reject workingDir containing double quotes (would break cmd quoting / allow injection in .cmd files)
    if (typeof workingDir === 'string' && workingDir.indexOf('"') >= 0) {
      this.logger.warn('[daemon] Install rejected: workingDir must not contain double quotes');
      return { success: false, error: 'workingDir must not contain double quotes' };
    }

    try {
      if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });

      this.saveEnvFile(env);

      // H-D2: escape the command path's internal quotes, then wrap in double quotes
      let fullCommand = '"' + String(command).replace(/"/g, '""') + '"';
      if (args.length > 0) {
        // H-D2: escape each arg with ^ for cmd metacharacters, then wrap in double quotes
        const escapedArgs = args.map((a) => escapeCmdArg(a));
        fullCommand += ' ' + escapedArgs.join(' ');
      }

      const envSetupScript = join(this.dataDir, 'gateway-setup-env.cmd');
      const envLines: string[] = ['@echo off'];
      const envKeys = Object.keys(env);
      for (const k of envKeys) {
        // H-D2: env values are inside a quoted SET assignment; double internal quotes
        envLines.push('SET "' + k + '=' + String(env[k]).replace(/"/g, '""') + '"');
      }
      envLines.push('cd /d "' + workingDir + '"');
      envLines.push(fullCommand);
      this.writeEnvSetupScriptSafe(envSetupScript, envLines.join('\r\n'));

      // 隐藏启动包装：计划任务改经 wscript+VBS 以 0 号窗口样式运行 cmd，
      // 手动启动/登录自启均不再弹出控制台黑窗（对齐旧版 VBS 隐藏机制）
      const hiddenVbs = join(this.dataDir, 'gateway-hidden.vbs');
      const vbsContent =
        'Set WshShell = CreateObject("WScript.Shell")\r\n' +
        'WshShell.Run """' + envSetupScript + '""", 0, False\r\n';
      writeFileSync(hiddenVbs, vbsContent, 'utf8');

      const xmlTask = [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '  <RegistrationInfo>',
        '    <Description>' + escapeXml(description) + '</Description>',
        '  </RegistrationInfo>',
        '  <Triggers>',
        '    <LogonTrigger>',
        '      <Enabled>true</Enabled>',
        '    </LogonTrigger>',
        '  </Triggers>',
        '  <Principals>',
        '    <Principal id="Author">',
        '      <LogonType>InteractiveToken</LogonType>',
        '      <RunLevel>LeastPrivilege</RunLevel>',
        '    </Principal>',
        '  </Principals>',
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <AllowHardTerminate>true</AllowHardTerminate>',
        '    <StartWhenAvailable>true</StartWhenAvailable>',
        '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
        '    <AllowStartOnDemand>true</AllowStartOnDemand>',
        '    <Enabled>true</Enabled>',
        '    <Hidden>false</Hidden>',
        '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
        '    <WakeToRun>false</WakeToRun>',
        '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
        '    <Priority>7</Priority>',
        '  </Settings>',
        '  <Actions Context="Author">',
        '    <Exec>',
        '      <Command>wscript.exe</Command>',
        '      <Arguments>"' + escapeXml(hiddenVbs) + '"</Arguments>',
        '      <WorkingDirectory>' + escapeXml(workingDir) + '</WorkingDirectory>',
        '    </Exec>',
        '  </Actions>',
        '</Task>',
      ].join('\n');

      const xmlPath = join(this.dataDir, 'gateway-task.xml');
      writeFileSync(xmlPath, xmlTask, 'utf8');

      let createResult = runCmd('schtasks', ['/create', '/tn', this.taskName, '/xml', xmlPath, '/f']);
      if (!createResult.success) {
        // 任务包装 cmd 可能仍在退出中导致 /create 冲突，释放残留锁后重试一次
        this.releaseEnvScriptLock();
        createResult = runCmd('schtasks', ['/create', '/tn', this.taskName, '/xml', xmlPath, '/f']);
      }
      if (!createResult.success) {
        this.logger.warn(
          '[daemon] schtasks create failed, trying Startup folder fallback: ' +
            (createResult.stderr || createResult.error),
        );
        return this.installStartupFallback(envSetupScript);
      }

      try {
        unlinkSync(xmlPath);
      } catch {
        // 忽略
      }

      if (autoStart) {
        runCmd('schtasks', ['/change', '/tn', this.taskName, '/enable']);
      }

      // 自启统一由计划任务 LogonTrigger 托管：清理旧版多重自启遗留（VBS/cmd/lnk）
      this.cleanupLegacyAutostartEntries();

      this.logger.info('[daemon] Service installed via Task Scheduler');
      return { success: true, method: 'schtasks', taskName: this.taskName };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('[daemon] Install error: ' + msg);
      return { success: false, error: msg };
    }
  }

  /**
   * 释放 gateway-setup-env.cmd 文件锁：仅终止持有脚本锁的 cmd.exe 包装进程。
   * 注意不能用 Stop-ScheduledTask——那会连 node 网关一起终止，导致正在处理请求的后端自杀；
   * node 成为孤儿进程继续服务，任务状态自动转为结束，后续 schtasks /create 也不再冲突。
   */
  private releaseEnvScriptLock(): void {
    try {
      const ps =
        'Get-CimInstance Win32_Process -Filter "Name=\'cmd.exe\'" | ' +
        "Where-Object { $_.CommandLine -like '*gateway-setup-env.cmd*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }';
      runCmd('powershell', ['-NoProfile', '-Command', ps]);
    } catch {
      // 忽略
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  /** 写入 gateway-setup-env.cmd；遇 EPERM/EBUSY（脚本正被执行锁定）时先释放锁再重试一次 */
  private writeEnvSetupScriptSafe(path: string, content: string): void {
    try {
      writeFileSync(path, content, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
      this.logger.warn('[daemon] env script locked (' + code + '), releasing lock and retrying');
      this.releaseEnvScriptLock();
      writeFileSync(path, content, 'utf8');
    }
  }

  /** 启动文件夹回退安装
   * 旧实现写入 `start "" /b gateway-setup-env.cmd`——`/b` 只是不开新窗口，
   *  但启动文件夹的 .cmd 父窗口本身可见，node 前台运行导致开机弹出常驻终端。
   *  改为写 VBS 入口（wscript 以 0 号窗口样式运行，完全无窗口），与主路径
   *  gateway-hidden.vbs 的隐藏机制对齐；旧的 .cmd 入口由 cleanupLegacyAutostartEntries 清理。 */
  private installStartupFallback(scriptPath: string): InstallResult {
    try {
      if (!existsSync(this.startupDir)) mkdirSync(this.startupDir, { recursive: true });
      const vbsContent =
        'Set WshShell = CreateObject("WScript.Shell")\r\n' +
        'WshShell.Run """' + scriptPath.replace(/"/g, '""') + '""", 0, False\r\n';
      writeFileSync(this.startupVbs, vbsContent, 'utf8');
      // 清掉旧版本降级写过的可见 .cmd 入口（若存在）——含上一版 claw 命名遗留
      for (const legacy of [this.startupScript, ...this.legacyStartupFiles]) {
        if (existsSync(legacy)) {
          try {
            unlinkSync(legacy);
          } catch {
            // 忽略删除失败（正被执行锁定等），下次 cleanup 再清
          }
        }
      }
      this.logger.info('[daemon] Installed via Startup folder fallback (VBS hidden)');
      return { success: true, method: 'startup', path: this.startupVbs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('[daemon] Startup fallback failed: ' + msg);
      return { success: false, error: 'Both schtasks and Startup folder failed: ' + msg };
    }
  }

  uninstall(): OpResult {
    // H-D4: cancel any pending restart before uninstalling
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName]);
      if (queryResult.success) {
        // 先结束任务再删除：运行中的任务 cmd.exe 持有 gateway-setup-env.cmd 文件锁，
        // 不先 /end 会导致下方 unlink 失败而残留脚本（installed 状态误判）
        runCmd('schtasks', ['/end', '/tn', this.taskName]);
        runCmd('schtasks', ['/delete', '/tn', this.taskName, '/f']);
      }
      // 历史任务名兜底清理（SkyalyticClaw 改名 SkyalyticWing 前的注册残留；
      // 不存在时非零退出属正常，忽略错误）
      for (const legacyTask of ['SkyAlyticClawGateway', 'Skyalyticclaw Gateway']) {
        runCmd('schtasks', ['/delete', '/tn', legacyTask, '/f']);
      }
      if (existsSync(this.startupScript)) {
        unlinkSync(this.startupScript);
      }
      // H-D5: 同步清理降级安装的 VBS 入口
      if (existsSync(this.startupVbs)) {
        try {
          unlinkSync(this.startupVbs);
        } catch {
          // 忽略
        }
      }
      const envSetupScript = join(this.dataDir, 'gateway-setup-env.cmd');
      if (existsSync(envSetupScript)) {
        try {
          unlinkSync(envSetupScript);
        } catch {
          // 文件仍被锁定时释放锁后重试一次，避免残留
          try {
            this.releaseEnvScriptLock();
            unlinkSync(envSetupScript);
          } catch {
            // 忽略
          }
        }
      }
      // 清理旧版遗留自启项（VBS/cmd/lnk + 回退脚本）与隐藏启动包装
      const hiddenVbs = join(this.dataDir, 'gateway-hidden.vbs');
      if (existsSync(hiddenVbs)) {
        try {
          unlinkSync(hiddenVbs);
        } catch {
          // 忽略
        }
      }
      this.cleanupLegacyAutostartEntries();
      this.logger.info('[daemon] Service uninstalled');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('[daemon] Uninstall error: ' + msg);
      return { success: false, error: msg };
    }
  }

  start(): OpResult {
    const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName]);
    if (queryResult.success) {
      // schtasks /run 无法启动已禁用的任务：手动启动视为恢复启用
      if (this.isTaskEnabled() === false) {
        runCmd('schtasks', ['/change', '/tn', this.taskName, '/enable']);
      }
      const r = runCmd('schtasks', ['/run', '/tn', this.taskName]);
      if (r.success) {
        this.logger.info('[daemon] Service started via Task Scheduler');
      }
      return r;
    }
    const envSetupScript = join(this.dataDir, 'gateway-setup-env.cmd');
    if (existsSync(envSetupScript)) {
      try {
        // IS_WIN 平台守卫：cmd.exe 仅在 Windows 上可用
        const child = spawn('cmd.exe', ['/c', envSetupScript], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        this.logger.info('[daemon] Service started via Startup script');
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { success: false, error: 'Service not installed' };
  }

  stop(): OpResult {
    // H-D4: cancel any pending restart so we don't auto-restart after an explicit stop
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName]);
    if (queryResult.success) {
      const r = runCmd('schtasks', ['/end', '/tn', this.taskName]);
      // /end 只终止 cmd 包装进程，node 网关进程会存活并继续占用端口，必须补杀
      this.killGatewayProcess();
      if (r.success) {
        this.logger.info('[daemon] Service stopped via Task Scheduler');
      }
      return r;
    }
    this.logger.info('[daemon] No Task Scheduler task found, attempting process kill');
    return this.killGatewayProcess();
  }

  /** 终止网关进程：优先杀网关端口监听进程（隐藏模式下 CommandLine 不可查），再兜底杀 CommandLine 匹配进程 */
  private killGatewayProcess(): OpResult {
    try {
      // 1) 杀监听网关端口的进程
      const pid = this.findGatewayPid();
      if (pid) {
        const r = runCmd('taskkill', ['/pid', String(pid), '/f']);
        if (r.success) {
          this.logger.info('[daemon] Killed gateway process PID ' + pid + ' (port ' + this.gatewayPort + ')');
        }
      }
      // 2) 兜底：杀 CommandLine 匹配的进程
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*skyalyticwing*' -and $_.CommandLine -like '*main.js*' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }';
      const r2 = runCmd('powershell', ['-NoProfile', '-Command', ps]);
      if (!r2.success) {
        return { success: false, error: r2.stderr || r2.error || 'kill gateway processes failed' };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  restart(): OpResult {
    this.stop();
    // H-D4: save the timer handle so uninstall/stop can cancel the pending start
    this.restartTimer = setTimeout(() => {
      this.start();
    }, 500);
    return { success: true };
  }

  isInstalled(): boolean {
    const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName]);
    if (queryResult.success) return true;
    // H-D5: 降级安装产物为 VBS 入口；.cmd 为旧版可见终端入口（兼容期一并识别）
    return existsSync(this.startupVbs) || existsSync(this.startupScript);
  }

  isRunning(): boolean {
    const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName, '/fo', 'list']);
    if (queryResult.success && queryResult.stdout.indexOf('Running') >= 0) {
      return true;
    }
    // 中文 Windows 的 schtasks 输出为本地化文本（GBK），'Running' 匹配不到，
    // 回退到网关进程探测：存在命令行含 skyalyticwing 的 node.exe 即视为运行中
    return this.isGatewayProcessAlive();
  }

  /**
   * 探测网关进程 PID。
   * 优先：网关端口监听检测（Get-NetTCPConnection 的 OwningProcess）——最可靠，
   * 与启动方式（wscript 隐藏模式下派生进程的 CommandLine 不可查）、系统语言均无关。
   * 兜底：CommandLine 匹配（端口未监听但进程存在时，如启动崩溃前瞬间）。
   */
  private findGatewayPid(): number | null {
    // 端口监听检测
    try {
      const r = runCmd('powershell', ['-NoProfile', '-Command', this.psFindPidByPort()]);
      if (r.success && r.stdout.trim()) {
        const pidNum = parseInt(r.stdout.trim(), 10);
        if (!isNaN(pidNum) && pidNum > 0) return pidNum;
      }
    } catch {
      // 忽略
    }
    // CommandLine 匹配兜底
    try {
      const r = runCmd('powershell', ['-NoProfile', '-Command', this.psFindPidByCmdline()]);
      if (r.success && r.stdout.trim()) {
        const pidNum = parseInt(r.stdout.trim(), 10);
        if (!isNaN(pidNum) && pidNum > 0) return pidNum;
      }
    } catch {
      // 忽略
    }
    return null;
  }

  /** 网关端口监听进程查询命令（同步/异步版共用） */
  private psFindPidByPort(): string {
    return (
      '(Get-NetTCPConnection -LocalPort ' +
      this.gatewayPort +
      ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess'
    );
  }

  /** 网关 CommandLine 匹配进程查询命令（同步/异步版共用） */
  private psFindPidByCmdline(): string {
    return (
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*skyalyticwing*' -and $_.CommandLine -like '*main.js*' } | " +
      'Select-Object -First 1 -ExpandProperty ProcessId'
    );
  }

  /** 探测网关进程是否存活 */
  private isGatewayProcessAlive(): boolean {
    return this.findGatewayPid() !== null;
  }

  /**
   * 读取计划任务启用状态（Get-ScheduledTask 的 Settings.Enabled 与系统语言无关；
   * 不能用 State 判断——已禁用但正在运行的任务 State 仍为 Running）。
   * @returns true=启用 false=禁用 null=任务不存在或读取失败
   */
  private isTaskEnabled(): boolean | null {
    try {
      const r = runCmd('powershell', ['-NoProfile', '-Command', this.psTaskEnabled()]);
      if (!r.success) return null;
      const val = r.stdout.trim().toLowerCase();
      if (val === 'true') return true;
      if (val === 'false') return false;
      return null;
    } catch {
      return null;
    }
  }

  /** Get-ScheduledTask 启用状态查询命令（同步/异步版共用） */
  private psTaskEnabled(): string {
    return (
      "(Get-ScheduledTask -TaskName '" +
      this.taskName.replace(/'/g, "''") +
      "' -ErrorAction SilentlyContinue).Settings.Enabled"
    );
  }

  /** 清理旧版多重自启遗留（Startup 目录 VBS/cmd/lnk + 回退脚本），自启统一由计划任务托管。
   *  历史命名双清单：SkyalyticClaw 改名 SkyalyticWing 前的文件（skyalyticclaw-*）
   *  与新命名重装场景的历史形态（hidden.vbs/.cmd/lnk）都要清；
   *  skyalyticwing-gateway.* 是当前版自启入口（计划任务/降级 VBS），此处不删。 */
  private cleanupLegacyAutostartEntries(): void {
    const entries = [
      // ── 上一版（SkyalyticClaw 命名）安装产物 ──
      ...this.legacyStartupFiles,
      // ── 新命名的历史遗留形态（更早期可见终端/lnk 入口，重装场景） ──
      join(this.startupDir, 'skyalyticwing-hidden.vbs'),
      join(this.startupDir, 'skyalyticwing.cmd'),
      join(this.startupDir, 'SkyAlyticWing.lnk'),
    ];
    for (const p of entries) {
      try {
        if (existsSync(p)) {
          unlinkSync(p);
          this.logger.info('[daemon] Removed legacy autostart entry: ' + p);
        }
      } catch {
        // 忽略
      }
    }
  }

  getStatus(): DaemonStatus {
    const installed = this.isInstalled();
    const running = installed && this.isRunning();
    // autoStart 读取计划任务启用状态（语言无关）；任务不存在时回退到启动脚本存在性
    const taskEnabled = this.isTaskEnabled();
    const autoStart = taskEnabled !== null ? taskEnabled : (existsSync(this.startupVbs) || existsSync(this.startupScript));
    const status: DaemonStatus = {
      platform: 'windows',
      manager: 'schtasks',
      installed,
      running,
      autoStart,
      taskName: this.taskName,
    };
    const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName, '/fo', 'list', '/v']);
    if (queryResult.success) {
      status.taskDetails = queryResult.stdout.trim();
    }
    // PID 从网关进程探测获取（schtasks 本地化输出中提取不可靠）
    if (running) {
      const pid = this.findGatewayPid();
      if (pid) status.pid = pid;
    }
    if (existsSync(this.startupVbs) || existsSync(this.startupScript)) {
      status.startupFallback = true;
      status.startupPath = existsSync(this.startupVbs) ? this.startupVbs : this.startupScript;
    }
    return status;
  }

  /** 网关进程探测（异步版） */
  private async findGatewayPidAsync(): Promise<number | null> {
    const portRes = await runCmdAsync('powershell', ['-NoProfile', '-Command', this.psFindPidByPort()]);
    if (portRes.success && portRes.stdout.trim()) {
      const pidNum = parseInt(portRes.stdout.trim(), 10);
      if (!isNaN(pidNum) && pidNum > 0) return pidNum;
    }
    const cmdlineRes = await runCmdAsync('powershell', ['-NoProfile', '-Command', this.psFindPidByCmdline()]);
    if (cmdlineRes.success && cmdlineRes.stdout.trim()) {
      const pidNum = parseInt(cmdlineRes.stdout.trim(), 10);
      if (!isNaN(pidNum) && pidNum > 0) return pidNum;
    }
    return null;
  }

  /** 任务启用状态（异步版，命令与同步版共用） */
  private async isTaskEnabledAsync(): Promise<boolean | null> {
    const r = await runCmdAsync('powershell', ['-NoProfile', '-Command', this.psTaskEnabled()]);
    if (!r.success) return null;
    const val = r.stdout.trim().toLowerCase();
    if (val === 'true') return true;
    if (val === 'false') return false;
    return null;
  }

  /**
   * 异步状态查询（getStatus 等价实现，命令不阻塞事件循环）。
   *
   * 与同步版差异：schtasks 详情/任务启用状态/安装探测三项相互独立，并行执行，
   * 总耗时≈最慢单命令（约 1-3s）而非串行累加（同步版 5-8 个命令可冻结事件循环 10-20s）。
   * running 判定语义与同步版一致：schtasks 输出含 'Running'（英文系统），
   * 否则回退网关进程探测（中文系统 schtasks 输出为本地化 GBK 文本）。
   */
  async getStatusAsync(): Promise<DaemonStatus> {
    const [taskQuery, taskEnabled, detailResult] = await Promise.all([
      // /query /fo list：一次调用同时回答"任务存在（installed 主证据）"与"Running（英文系统）"
      runCmdAsync('schtasks', ['/query', '/tn', this.taskName, '/fo', 'list']),
      this.isTaskEnabledAsync(),
      // schtasks /v 详情输出较大，仅在任务可能存在时才有价值，但与上两项并行无依赖
      runCmdAsync('schtasks', ['/query', '/tn', this.taskName, '/fo', 'list', '/v']),
    ]);
    const installed = taskQuery.success || existsSync(this.startupVbs) || existsSync(this.startupScript);
    // running：schtasks 'Running' 命中（英文系统）→ 直接成立；
    // 否则回退网关进程探测——探测结果同时充当 running 依据与 PID 来源（只探测一次）
    let running = installed && taskQuery.success && taskQuery.stdout.indexOf('Running') >= 0;
    let pid: number | null = null;
    if (installed && !running) {
      pid = await this.findGatewayPidAsync();
      running = pid !== null;
    }
    const autoStart = taskEnabled !== null ? taskEnabled : existsSync(this.startupVbs) || existsSync(this.startupScript);
    const status: DaemonStatus = {
      platform: 'windows',
      manager: 'schtasks',
      installed,
      running,
      autoStart,
      taskName: this.taskName,
    };
    if (detailResult.success) {
      status.taskDetails = detailResult.stdout.trim();
    }
    if (running && pid === null) {
      pid = await this.findGatewayPidAsync();
    }
    if (pid) status.pid = pid;
    if (existsSync(this.startupVbs) || existsSync(this.startupScript)) {
      status.startupFallback = true;
      status.startupPath = existsSync(this.startupVbs) ? this.startupVbs : this.startupScript;
    }
    return status;
  }

  setAutoStart(enabled: boolean): boolean {
    try {
      const queryResult = runCmd('schtasks', ['/query', '/tn', this.taskName]);
      if (queryResult.success) {
        // 统一机制：启用/禁用计划任务本身（任务已内建 LogonTrigger 登录自启）
        const r = runCmd('schtasks', ['/change', '/tn', this.taskName, enabled ? '/enable' : '/disable']);
        if (!r.success) {
          this.logger.warn('[daemon] setAutoStart failed: ' + (r.stderr || r.error));
          return false;
        }
        return true;
      }
      // 启动文件夹回退模式（无计划任务）：H-D5 改为维护 VBS 隐藏入口。
      // 旧实现创建 SkyAlyticClaw.lnk 直接指向 gateway-setup-env.cmd（可见终端窗口）
      if (enabled) {
        const envSetupScript = join(this.dataDir, 'gateway-setup-env.cmd');
        if (!existsSync(envSetupScript)) {
          this.logger.warn('[daemon] setAutoStart failed: env setup script missing');
          return false;
        }
        const vbsContent =
          'Set WshShell = CreateObject("WScript.Shell")\r\n' +
          'WshShell.Run """' + envSetupScript.replace(/"/g, '""') + '""", 0, False\r\n';
        try {
          writeFileSync(this.startupVbs, vbsContent, 'utf8');
          // 清理旧版遗留入口（可见 .cmd 与 .lnk，含上一版 claw 命名遗留）
          for (const legacy of [this.startupScript, ...this.legacyStartupFiles]) {
            if (existsSync(legacy)) {
              try {
                unlinkSync(legacy);
              } catch {
                // 忽略
              }
            }
          }
          return true;
        } catch (err) {
          this.logger.warn(
            '[daemon] setAutoStart startup-folder fallback failed: ' +
              (err instanceof Error ? err.message : String(err)),
          );
          return false;
        }
      }
      // 禁用：删除 VBS 入口及旧版遗留（含上一版 claw 命名遗留）
      for (const p of [this.startupVbs, this.startupScript, ...this.legacyStartupFiles]) {
        if (existsSync(p)) {
          try {
            unlinkSync(p);
          } catch {
            // 忽略
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  readRuntime(): RuntimeInfo | null {
    const runtime: RuntimeInfo = { taskName: this.taskName, dataDir: this.dataDir };
    const envSetupScript = join(this.dataDir, 'gateway-setup-env.cmd');
    if (existsSync(envSetupScript)) {
      try {
        runtime.setupScript = readFileSync(envSetupScript, 'utf8');
      } catch {
        // 忽略
      }
    }
    return runtime;
  }

  /** 保存环境变量文件 */
  private saveEnvFile(env: Record<string, string>): void {
    try {
      const lines: string[] = [];
      const keys = Object.keys(env || {});
      for (const k of keys) {
        lines.push(k + '=' + String(env[k]));
      }
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.envFile, lines.join('\n'), 'utf8');
    } catch (err) {
      this.logger.warn('[daemon] Failed to save env file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** 读取环境变量文件 */
  private readEnvFile(): Record<string, string> {
    try {
      if (!existsSync(this.envFile)) return {};
      const content = readFileSync(this.envFile, 'utf8');
      const env: Record<string, string> = {};
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.indexOf('#') === 0) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const val = trimmed.substring(eqIdx + 1).trim();
        env[key] = val;
      }
      return env;
    } catch {
      return {};
    }
  }

  setEnv(key: string, value: string): EnvOpResult {
    const env = this.readEnvFile();
    env[key] = String(value);
    this.saveEnvFile(env);
    if (this.isInstalled()) {
      this.logger.info('[daemon] Environment updated. Reinstall service to apply changes.');
    }
    return { success: true };
  }

  getEnv(): Record<string, string> {
    return this.readEnvFile();
  }

  removeEnv(key: string): EnvOpResult {
    const env = this.readEnvFile();
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      this.saveEnvFile(env);
      return { success: true };
    }
    return { success: false, error: 'Key not found' };
  }
}

// ============================================================
// DaemonService 主服务
// ============================================================

/**
 * DaemonService - 守护进程管理服务
 *
 * 职责：
 *   1. 安装/卸载系统级自启动项（三平台：Windows schtasks / macOS launchd / Linux systemd）
 *   2. 启动/停止/重启守护进程
 *   3. 获取运行状态、自启动设置
 *   4. 环境变量管理（setEnv/getEnv/removeEnv）
 *   5. 诊断、日志读取、重启历史
 *
 * 全量移植自 packages/web/daemon-manager.cjs。
 * 所有命令执行使用数组参数（execFileSync + args），避免 shell 注入。
 * Windows 专用 API（schtasks/cmd.exe/tasklist/taskkill）均添加 IS_WIN 平台守卫。
 * H-D1/H-D2/H-D4 安全修复均已保留。
 */
@Injectable()
export class DaemonService implements OnModuleInit {
  private dataDir = '';
  private service: PlatformDaemonService | null = null;
  private readonly serviceCache: Record<string, PlatformDaemonService> = {};
  /** 状态查询短 TTL 缓存（getStatusAsync 专用，动作后失效） */
  private statusCache: DaemonStatus | null = null;
  private statusCacheAt = 0;
  private static readonly STATUS_CACHE_TTL_MS = 3_000;
  /** 缓存代际：动作失效时递增，旧查询结果据此拒绝回写 */
  private statusGeneration = 0;
  /** 在途查询合并句柄（并发击穿防护） */
  private statusInflight: Promise<DaemonStatus> | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.init();
  }

  /**
   * 初始化守护进程服务（兼容原 daemon-manager.init）
   * @param dataDir 数据目录，默认 ~/.skyalyticwing
   */
  init(dataDir?: string): void {
    this.dataDir = dataDir || join(homedir(), '.skyalyticwing');
    this.service = this.getService(this.dataDir);
    this.logger.info('[daemon] DaemonService initialized (platform: ' + detectPlatform() + ', dataDir: ' + this.dataDir + ')');
  }

  /** 平台服务工厂（带缓存） */
  getService(dataDir: string): PlatformDaemonService {
    const cacheKey = detectPlatform() + ':' + dataDir;
    if (this.serviceCache[cacheKey]) return this.serviceCache[cacheKey];

    let service: PlatformDaemonService;
    if (IS_MAC) {
      service = new LaunchdService(dataDir, this.logger);
    } else if (IS_LINUX) {
      service = new SystemdService(dataDir, this.logger);
    } else if (IS_WIN) {
      service = new SchtasksService(dataDir, this.logger, this.resolveGatewayPort());
    } else {
      throw new Error('Unsupported platform: ' + PLAT);
    }

    this.serviceCache[cacheKey] = service;
    return service;
  }

  /** 读取网关端口（config.server.port，默认 19111） */
  private resolveGatewayPort(): number {
    try {
      const server = this.config.get<Record<string, unknown>>('server');
      const p = Number(server?.['port']);
      if (Number.isFinite(p) && p > 0) return p;
    } catch {
      // 配置读取失败回退默认端口
    }
    return 19111;
  }

  /** 检测平台 */
  detectPlatform(): string {
    return detectPlatform();
  }

  // ============================================================
  // 控制器契约方法（抛出异常以匹配控制器）
  // ============================================================

  /**
   * 安装守护进程（危险：创建系统级自启动项）
   * 兼容控制器契约：失败时抛出异常
   * 默认参数对齐旧版 start.cjs daemon_install：守护 node <backend>/dist/main.js
   */
  async install(options?: InstallOptions): Promise<void> {
    const svc = this.ensureService();
    // 编译产物位于 <backend>/dist/modules/channels/daemon/，上溯 3 级即 dist
    const distDir = join(__dirname, '..', '..', '..');
    const defaults: InstallOptions = {
      name: 'skyalyticwing',
      displayName: 'SkyalyticWing Gateway',
      description: 'SkyalyticWing AI助手网关服务',
      command: process.execPath,
      args: [join(distDir, 'main.js')],
      workingDir: join(distDir, '..'),
      autoStart: true,
    };
    const result = svc.install({ ...defaults, ...(options || {}) });
    if (!result.success) {
      throw new Error(result.error || 'Failed to install daemon');
    }
    this.logger.info('[daemon] Daemon installed', { platform: PLAT });
    this.invalidateStatusCache();
  }

  /** 卸载守护进程（危险：移除系统级自启动项） */
  async uninstall(): Promise<void> {
    const svc = this.ensureService();
    const result = svc.uninstall();
    if (!result.success) {
      throw new Error(result.error || 'Failed to uninstall daemon');
    }
    this.logger.info('[daemon] Daemon uninstalled', { platform: PLAT });
    this.invalidateStatusCache();
  }

  /** 启动守护进程（危险） */
  async start(): Promise<void> {
    const svc = this.ensureService();
    const result = svc.start();
    if (!result.success) {
      throw new Error(result.error || 'Failed to start daemon');
    }
    this.logger.info('[daemon] Daemon started', { platform: PLAT });
    this.invalidateStatusCache();
  }

  /** 停止守护进程（危险） */
  async stop(): Promise<void> {
    const svc = this.ensureService();
    const result = svc.stop();
    if (!result.success) {
      throw new Error(result.error || 'Failed to stop daemon');
    }
    this.logger.info('[daemon] Daemon stopped', { platform: PLAT });
    this.invalidateStatusCache();
  }

  /** 获取守护进程状态（同步版：会阻塞事件循环，仅限低频内部调用） */
  getStatus(): DaemonStatus {
    const svc = this.ensureService();
    return svc.getStatus();
  }

  /**
   * 获取守护进程状态（异步版，页面热路径专用）。
   * Windows 走平台 getStatusAsync（不冻结事件循环）；mac/linux 回退同步实现。
   *
   * 并发语义：
   *   - 3s TTL 缓存命中 → 浅拷贝返回（防调用方改写共享缓存对象）
   *   - in-flight 合并：缓存过期的瞬间并发到达的请求共享同一次查询，
   *     避免产生 N×3 个 schtasks/PowerShell 子进程风暴
   *   - generation 校验：install/start/stop 等动作在查询期间完成时递增
   *     generation，动作前的旧查询结果不回写缓存（否则 TTL 内返回旧状态）
   */
  async getStatusAsync(): Promise<DaemonStatus> {
    const now = Date.now();
    if (this.statusCache && now - this.statusCacheAt < DaemonService.STATUS_CACHE_TTL_MS) {
      return { ...this.statusCache };
    }
    if (this.statusInflight) {
      return { ...(await this.statusInflight) };
    }
    const generation = this.statusGeneration;
    this.statusInflight = (async () => {
      const svc = this.ensureService();
      const status =
        typeof svc.getStatusAsync === 'function' ? await svc.getStatusAsync() : svc.getStatus();
      if (generation === this.statusGeneration) {
        this.statusCache = status;
        this.statusCacheAt = Date.now();
      }
      return status;
    })();
    try {
      return { ...(await this.statusInflight) };
    } finally {
      this.statusInflight = null;
    }
  }

  /** 动作完成后失效状态缓存（install/uninstall/start/stop/restart/autostart 调用） */
  private invalidateStatusCache(): void {
    // 递增 generation：使查询期间启动的旧查询结果不再回写缓存
    this.statusGeneration++;
    this.statusCache = null;
    this.statusCacheAt = 0;
  }

  /** 设置自启动（enabled=true 安装，false 卸载） */
  setAutoStart(enabled: boolean): boolean {
    const svc = this.ensureService();
    const result = svc.setAutoStart(enabled);
    this.invalidateStatusCache();
    return result;
  }

  // ============================================================
  // 扩展 API（匹配原 daemon-manager.cjs 完整契约）
  // ============================================================

  /** 重启守护进程 */
  restart(): OpResult {
    const svc = this.ensureService();
    const result = svc.restart();
    this.invalidateStatusCache();
    return result;
  }

  /** 是否已安装 */
  isInstalled(): boolean {
    const svc = this.ensureService();
    return svc.isInstalled();
  }

  /** 是否运行中 */
  isRunning(): boolean {
    const svc = this.ensureService();
    return svc.isRunning();
  }

  /** 读取运行时信息 */
  readRuntime(): RuntimeInfo | null {
    const svc = this.ensureService();
    return svc.readRuntime();
  }

  /** 设置环境变量 */
  setEnv(key: string, value: string): EnvOpResult {
    const svc = this.ensureService();
    return svc.setEnv(key, value);
  }

  /** 获取所有环境变量 */
  getEnv(): Record<string, string> {
    const svc = this.ensureService();
    return svc.getEnv();
  }

  /** 移除环境变量 */
  removeEnv(key: string): EnvOpResult {
    const svc = this.ensureService();
    return svc.removeEnv(key);
  }

  // ============================================================
  // 诊断与日志
  // ============================================================

  /** 诊断守护进程配置 */
  diagnose(dataDir?: string): DiagnoseResult {
    const dir = dataDir || this.dataDir || join(homedir(), '.skyalyticwing');
    const results: DiagnoseResult = {
      platform: detectPlatform(),
      checks: [],
      overall: 'unknown',
    };

    let service: PlatformDaemonService;
    try {
      service = this.getService(dir);
    } catch (err) {
      results.checks.push({
        name: 'service_init',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
      });
      results.overall = 'fail';
      return results;
    }

    results.checks.push({
      name: 'service_init',
      status: 'pass',
      message: 'Service adapter created for ' + detectPlatform(),
    });

    const installed = service.isInstalled();
    results.checks.push({
      name: 'installed',
      status: installed ? 'pass' : 'warn',
      message: installed ? 'Service is installed' : 'Service is not installed',
    });

    if (installed) {
      const running = service.isRunning();
      results.checks.push({
        name: 'running',
        status: running ? 'pass' : 'fail',
        message: running ? 'Service is running' : 'Service is not running',
      });

      const status = service.getStatus();
      results.checks.push({
        name: 'status',
        status: 'info',
        message: 'PID: ' + (status.pid || 'N/A') + ', Manager: ' + (status.manager || 'unknown'),
      });

      const env = service.getEnv();
      const envKeys = Object.keys(env);
      results.checks.push({
        name: 'environment',
        status: envKeys.length > 0 ? 'pass' : 'warn',
        message: envKeys.length + ' environment variable(s) configured: ' + envKeys.join(', '),
      });
    }

    if (!existsSync(dir)) {
      results.checks.push({ name: 'data_dir', status: 'warn', message: 'Data directory does not exist: ' + dir });
    } else {
      results.checks.push({ name: 'data_dir', status: 'pass', message: 'Data directory exists: ' + dir });
    }

    const logDir = join(dir, 'logs');
    if (existsSync(logDir)) {
      results.checks.push({ name: 'log_dir', status: 'pass', message: 'Log directory exists' });
    } else {
      results.checks.push({ name: 'log_dir', status: 'warn', message: 'Log directory does not exist' });
    }

    let failCount = 0;
    let warnCount = 0;
    for (const check of results.checks) {
      if (check.status === 'fail') failCount++;
      if (check.status === 'warn') warnCount++;
    }
    results.overall = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';

    return results;
  }

  /** 获取日志（最近 N 行） */
  getLogs(dataDir?: string, lines = 50): LogEntry[] {
    const dir = dataDir || this.dataDir || join(homedir(), '.skyalyticwing');
    const logDir = join(dir, 'logs');
    const logFiles = ['gateway-stdout.log', 'gateway-stderr.log'];
    const allLogs: LogEntry[] = [];

    for (const logFile of logFiles) {
      const logPath = join(logDir, logFile);
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf8');
          const logLines = content.split('\n').filter((l) => l.trim());
          const startIdx = Math.max(0, logLines.length - lines);
          for (let j = startIdx; j < logLines.length; j++) {
            allLogs.push({ file: logFile, line: logLines[j] });
          }
        } catch (err) {
          allLogs.push({
            file: logFile,
            line: 'ERROR reading log: ' + (err instanceof Error ? err.message : String(err)),
          });
        }
      }
    }

    if (allLogs.length === 0) {
      allLogs.push({ file: 'system', line: 'No log files found' });
    }

    return allLogs.slice(-lines);
  }

  /** 获取重启历史 */
  getRestartHistory(dataDir?: string): RestartHistoryEntry[] {
    const dir = dataDir || this.dataDir || join(homedir(), '.skyalyticwing');
    const logDir = join(dir, 'logs');
    const history: RestartHistoryEntry[] = [];
    const stderrPath = join(logDir, 'gateway-stderr.log');

    if (existsSync(stderrPath)) {
      try {
        const content = readFileSync(stderrPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (
            trimmed.indexOf('Starting') >= 0 ||
            trimmed.indexOf('started') >= 0 ||
            trimmed.indexOf('restart') >= 0
          ) {
            history.push({ timestamp: new Date().toISOString(), event: trimmed.substring(0, 200) });
          }
        }
      } catch (err) {
        history.push({
          timestamp: new Date().toISOString(),
          event: 'Error reading restart history: ' + (err instanceof Error ? err.message : String(err)),
        });
      }
    }

    if (history.length === 0) {
      history.push({ timestamp: new Date().toISOString(), event: 'No restart history found' });
    }

    return history.slice(-20);
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  /** 确保平台服务已初始化 */
  private ensureService(): PlatformDaemonService {
    if (!this.service) {
      this.init();
    }
    return this.service!;
  }
}
