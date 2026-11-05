import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn, exec } from 'node:child_process';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { PathGuardService, PathMode } from './path-guard.service.js';
import { CommandGuardService, CommandRuleType, UserRole } from './command-guard.service.js';
import { SsrfGuardService, UrlCheckResult } from './ssrf-guard.service.js';

// ===========================================================================
// 类型定义
// ===========================================================================

/** 沙箱类型 */
export type SandboxType = 'docker' | 'ssh' | 'browser' | 'fs';

/** 工具策略 */
export type ToolPolicy = 'allow-read-only' | 'allow-all' | 'deny-all';

/** Docker 沙箱配置 */
export interface DockerSandboxConfig {
  type: 'docker';
  image: string;
  memory: string;
  cpus: number;
  timeout: number;
  network: string;
  workdir: string;
  env: Record<string, string>;
  toolPolicy: ToolPolicy;
}

/** SSH 沙箱配置 */
export interface SshSandboxConfig {
  type: 'ssh';
  host: string;
  port: number;
  username: string;
  privateKey: string | null;
  password: string | null;
  timeout: number;
  workdir: string;
  toolPolicy: ToolPolicy;
}

/** 命令执行结果 */
export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** 浏览器沙箱 */
export interface BrowserSandbox {
  type: 'browser';
  headless: boolean;
  sandbox: boolean;
  disableGpu: boolean;
  noSandbox: boolean;
  userDataDir: string;
  start(): { success: boolean; pid?: number; error?: string };
  stop(): { success: boolean };
  isRunning(): boolean;
  navigate(url: string): Promise<{ success: boolean; url?: string; message?: string; error?: string }>;
}

/** FS 桥接 */
export interface FsBridge {
  type: 'fs';
  sourceDir: string;
  targetDir: string;
  readOnly: boolean;
  sync(filePath: string): { success: boolean; source?: string; target?: string; error?: string };
  syncDir(dirPath?: string): { success: boolean; results?: unknown[]; count?: number; error?: string };
  getSyncedFiles(): Record<string, { syncedAt: number; size: number }>;
}

/** 配对设备信息 */
export interface PairedDevice {
  senderId: string;
  pairedAt: number;
  deviceInfo: {
    senderId: string;
    codeHash: string;
  };
}

/** 配对码 */
interface PairingCodeEntry {
  senderId: string | null;
  channel: string | null;
  createdAt: number;
  expiresAt: number;
}

/** 审批级别 */
export type ApprovalLevel = 'auto' | 'ask' | 'deny';

/** 审批决策 */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

/** 审批条目 */
export interface Approval {
  approvalId: string;
  toolName: string;
  args: unknown;
  sessionId: string;
  level: ApprovalLevel;
  status: string;
  createdAt: number;
}

/** 审计严重级别 */
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 审计发现 */
export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  area: string;
  description: string;
  fixable: boolean;
  fixFn?: () => boolean;
}

/** 危险配置标志 */
export interface DangerousFlag {
  key: string;
  value: unknown;
  severity: AuditSeverity;
  description: string;
}

/** 正则测试结果 */
export interface RegexTestResult {
  match: boolean;
  timedOut: boolean;
  elapsedMs?: number;
  error?: string;
}

/**
 * SecurityManagerService - 安全管理核心（全量移植自 security-manager.cjs）
 *
 * 职责：
 *   1. 门面：聚合 PathGuard / CommandGuard / SsrfGuard 子服务
 *   2. 沙箱执行：Docker / SSH / Browser / FS Bridge
 *   3. DM 配对：设备信任管理
 *   4. 执行审批：工具调用审批流（auto/ask/deny + allow-always）
 *   5. 安全正则：防 ReDoS 编译 + 有界测试
 *   6. 安全审计：文件权限/配置/密钥/网络/命令规则扫描
 *   7. 危险配置标志：扫描 dangerously* 开关
 *   8. 通用输入校验：sanitizeHtml / validateNumeric / validateString
 */
@Injectable()
export class SecurityManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityManagerService.name);

  // ---- 内部状态 ----

  /** 安全数据目录 */
  private dataDir: string;

  /** 是否已初始化 */
  private initialized = false;

  /** DM 配对状态 */
  private pairedDevices: Record<string, { pairedAt: number; deviceInfo: { senderId: string; codeHash: string } }> = {};
  private pairingCodes: Record<string, PairingCodeEntry> = {};

  /** 执行审批状态 */
  private pendingApprovals: Record<string, Approval> = {};
  private approvalHistory: Record<string, Approval[]> = {};
  private alwaysApprovedTools: Record<string, Record<string, boolean>> = {};

  /** 审批 TTL 与历史限制 */
  private readonly APPROVAL_TTL_MS = 10 * 60 * 1000;
  private readonly APPROVAL_HISTORY_MAX_PER_SESSION = 1000;

  /** 清理定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;

  /** 沙箱状态 */
  private sandboxes: Record<string, DockerSandboxConfig | SshSandboxConfig | BrowserSandbox> = {};
  private dockerAvailable: boolean | null = null;
  private fsBridges: Record<string, FsBridge> = {};

  /** 安全正则缓存 */
  private compiledRegexCache: Record<string, RegExp> = {};
  private readonly REGEX_CACHE_MAX = 100;
  private regexCacheKeys: string[] = [];

  /** 危险配置标志 */
  private dangerousFlags: DangerousFlag[] = [];

  /** 安全审计状态 */
  private auditFindings: AuditFinding[] = [];
  private auditCounter = 0;

  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly commandGuard: CommandGuardService,
    private readonly ssrfGuard: SsrfGuardService,
  ) {
    this.dataDir = this.resolveDataDir();
  }

  onModuleInit(): void {
    this.init();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** 解析安全数据目录 */
  private resolveDataDir(): string {
    const envDir = process.env['SKYALYTICWING_DATA_DIR'];
    if (envDir) return join(envDir, 'security');
    return join(homedir(), '.skyalyticwing', 'security');
  }

  /** 初始化（幂等） */
  init(): void {
    if (this.initialized) {
      this.logger.log('init() 已初始化，跳过（幂等）');
      return;
    }

    this.ensureDir(this.dataDir);

    // 加载持久化状态
    this.loadPairedDevices();

    // 标记已初始化
    this.initialized = true;

    // 启动定时清理
    this.startCleanupTimer();

    this.logger.log(`SecurityManager 已初始化 (dataDir: ${this.dataDir})`);
  }

  /** 确保已初始化 */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SecurityManager 未初始化，请等待 OnModuleInit 完成');
    }
  }

  // ===========================================================================
  // 门面方法 - 委托给子服务
  // ===========================================================================

  /** 路径是否在允许范围内 */
  isPathAllowed(filePath: string, mode?: PathMode): boolean {
    return this.pathGuard.isPathAllowed(filePath, mode);
  }

  /** 添加允许路径 */
  addAllowedPath(filePath: string, mode?: PathMode): void {
    this.pathGuard.addAllowedPath(filePath, mode);
  }

  /** 移除允许路径 */
  removeAllowedPath(filePath: string): boolean {
    return this.pathGuard.removeAllowedPath(filePath);
  }

  /** 列出路径策略 */
  listPathPolicies() {
    return this.pathGuard.listPathPolicies();
  }

  /** 命令是否被允许 */
  isCommandAllowed(command: string, role?: UserRole): boolean {
    return this.commandGuard.isCommandAllowed(command, role);
  }

  /** 添加命令规则 */
  addCommandRule(type: CommandRuleType, command: string, reason?: string): string {
    return this.commandGuard.addCommandRule(type, command, reason);
  }

  /** 移除命令规则 */
  removeCommandRule(ruleId: string): boolean {
    return this.commandGuard.removeCommandRule(ruleId);
  }

  /** 列出命令规则 */
  listCommandRules() {
    return this.commandGuard.listCommandRules();
  }

  /** SSRF 校验（异步，含 DNS 解析，返回详细结果） */
  async checkUrl(url: string): Promise<UrlCheckResult> {
    return this.ssrfGuard.checkUrl(url);
  }

  /** SSRF 校验（同步，仅主机名文本判别，fail-close） */
  checkUrlSync(url: string): boolean {
    return this.ssrfGuard.check(url);
  }

  /** 暴露子服务供高级调用方使用 */
  getPathGuard(): PathGuardService { return this.pathGuard; }
  getCommandGuard(): CommandGuardService { return this.commandGuard; }
  getSsrfGuard(): SsrfGuardService { return this.ssrfGuard; }

  // ===========================================================================
  // 2. 沙箱执行（全量移植自 .cjs 第2节）
  // ===========================================================================

  /** 检查 Docker 是否可用 */
  isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return Promise.resolve(this.dockerAvailable);
    return new Promise<boolean>((resolve) => {
      try {
        exec('docker info', { timeout: 5000 }, (err) => {
          this.dockerAvailable = !err;
          resolve(this.dockerAvailable);
        });
      } catch {
        this.dockerAvailable = false;
        resolve(false);
      }
    });
  }

  /**
   * 创建 Docker 沙箱
   * M-B6 修复：校验环境变量名仅允许 POSIX 标识符，防止注入 docker -e 参数
   */
  createDockerSandbox(config?: {
    image?: string; memory?: string; cpus?: number; timeout?: number;
    network?: string; workdir?: string; env?: Record<string, string>; toolPolicy?: ToolPolicy;
  }): string {
    const sandboxId = `docker-${this.generateId()}`;
    const envNameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const rawEnv = (config && config.env) || {};
    const safeEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (envNameRe.test(k)) {
        safeEnv[k] = v;
      } else {
        this.logger.warn(`拒绝无效 Docker 环境变量名: ${k}`);
      }
    }
    const sandboxConfig: DockerSandboxConfig = {
      type: 'docker',
      image: (config && config.image) || 'alpine:latest',
      memory: (config && config.memory) || '512m',
      cpus: (config && config.cpus) || 1,
      timeout: (config && config.timeout) || 30000,
      network: (config && config.network) || 'none',
      workdir: (config && config.workdir) || '/workspace',
      env: safeEnv,
      toolPolicy: (config && config.toolPolicy) || 'allow-read-only',
    };
    this.sandboxes[sandboxId] = sandboxConfig;
    this.logger.log(`创建 Docker 沙箱: ${sandboxId}`);
    return sandboxId;
  }

  /** 在 Docker 沙箱中执行命令 */
  runInDocker(command: string, options?: { sandboxId?: string }): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const sandboxId = options && options.sandboxId;
      const config = sandboxId ? this.sandboxes[sandboxId] as DockerSandboxConfig : null;

      if (!config || config.type !== 'docker') {
        return reject(new Error('Docker sandbox not found or invalid'));
      }

      const dockerArgs = [
        'run', '--rm',
        `--memory=${config.memory}`,
        `--cpus=${config.cpus}`,
        `--network=${config.network}`,
        `--workdir=${config.workdir}`,
      ];

      for (const [k, v] of Object.entries(config.env)) {
        const envVal = String(v).replace(/"/g, '\\"');
        dockerArgs.push('-e', `${k}="${envVal}"`);
      }

      dockerArgs.push(config.image, 'sh', '-c', command);

      const timeout = config.timeout;
      let killed = false;
      const proc = spawn('docker', dockerArgs, { timeout });

      let stdout = '';
      let stderr = '';
      let outputTooLarge = false;
      const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

      proc.stdout.on('data', (data: Buffer) => {
        if (outputTooLarge) return;
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          outputTooLarge = true;
          try { proc.kill('SIGKILL'); } catch {}
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        if (outputTooLarge) return;
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          outputTooLarge = true;
          try { proc.kill('SIGKILL'); } catch {}
        }
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (outputTooLarge) {
          reject(new Error('Docker command output exceeded 10MB limit'));
        } else if (killed) {
          reject(new Error(`Docker command timed out after ${timeout}ms`));
        } else {
          resolve({ exitCode: code, stdout, stderr });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** 创建 SSH 沙箱 */
  createSshSandbox(config?: {
    host?: string; port?: number; username?: string; privateKey?: string | null;
    password?: string | null; timeout?: number; workdir?: string; toolPolicy?: ToolPolicy;
  }): string {
    const sandboxId = `ssh-${this.generateId()}`;
    const sandboxConfig: SshSandboxConfig = {
      type: 'ssh',
      host: (config && config.host) || 'localhost',
      port: (config && config.port) || 22,
      username: (config && config.username) || 'root',
      privateKey: (config && config.privateKey) || null,
      password: (config && config.password) || null,
      timeout: (config && config.timeout) || 30000,
      workdir: (config && config.workdir) || '/tmp/workspace',
      toolPolicy: (config && config.toolPolicy) || 'allow-read-only',
    };
    this.sandboxes[sandboxId] = sandboxConfig;
    this.logger.log(`创建 SSH 沙箱: ${sandboxId}`);
    return sandboxId;
  }

  /** 在 SSH 沙箱中执行命令 */
  runInSsh(command: string, options?: { sandboxId?: string }): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const sandboxId = options && options.sandboxId;
      const config = sandboxId ? this.sandboxes[sandboxId] as SshSandboxConfig : null;

      if (!config || config.type !== 'ssh') {
        return reject(new Error('SSH sandbox not found or invalid'));
      }

      const sshArgs = [
        '-p', String(config.port),
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${join(this.dataDir || homedir(), '.ssh', 'known_hosts')}`,
      ];

      if (config.privateKey) {
        sshArgs.push('-i', config.privateKey);
      }

      // H-B1 修复：通过 stdin 传递命令，避免本地 shell 解析与 argv 引号问题
      sshArgs.push(`${config.username}@${config.host}`);

      const proc = spawn('ssh', sshArgs, { timeout: config.timeout });

      let stdout = '';
      let stderr = '';
      let sshTimedOut = false;
      let sshOutputTooLarge = false;
      const SSH_MAX_OUTPUT = 10 * 1024 * 1024;

      const sshTimer = setTimeout(() => {
        sshTimedOut = true;
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`SSH command timed out after ${config.timeout}ms`));
      }, config.timeout);

      proc.stdout.on('data', (data: Buffer) => {
        if (sshOutputTooLarge) return;
        stdout += data.toString();
        if (stdout.length > SSH_MAX_OUTPUT) {
          sshOutputTooLarge = true;
          try { proc.kill('SIGKILL'); } catch {}
          reject(new Error('SSH command output exceeded 10MB limit'));
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        if (sshOutputTooLarge) return;
        stderr += data.toString();
        if (stderr.length > SSH_MAX_OUTPUT) {
          sshOutputTooLarge = true;
          try { proc.kill('SIGKILL'); } catch {}
          reject(new Error('SSH command stderr exceeded 10MB limit'));
        }
      });

      proc.on('close', (code) => {
        if (sshTimedOut || sshOutputTooLarge) return;
        clearTimeout(sshTimer);
        resolve({ exitCode: code, stdout, stderr });
      });

      proc.on('error', (err) => {
        if (sshTimedOut) return;
        clearTimeout(sshTimer);
        reject(err);
      });

      // 通过 stdin 发送命令，远程 shell 直接执行
      proc.stdin.write(command + '\n');
      proc.stdin.end();
    });
  }

  /**
   * 通过 SCP 上传文件到 SSH 沙箱
   * C-F3 修复：拒绝包含 ':' 的本地路径，防止 SCP 路径注入
   */
  uploadToSsh(localPath: string, remotePath: string): Promise<{ success: boolean }> {
    return new Promise<{ success: boolean }>((resolve, reject) => {
      let sshSandboxId: string | null = null;
      for (const [sid, cfg] of Object.entries(this.sandboxes)) {
        if ((cfg as SshSandboxConfig).type === 'ssh') {
          sshSandboxId = sid;
          break;
        }
      }

      if (!sshSandboxId) {
        return reject(new Error('No SSH sandbox available'));
      }

      const config = this.sandboxes[sshSandboxId] as SshSandboxConfig;
      const scpArgs = [
        '-P', String(config.port),
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', `UserKnownHostsFile=${join(this.dataDir || homedir(), '.ssh', 'known_hosts')}`,
      ];

      if (config.privateKey) {
        scpArgs.push('-i', config.privateKey);
      }

      // C-F3: 拒绝含 ':' 的本地路径
      if (typeof localPath !== 'string' || localPath.indexOf(':') !== -1) {
        return reject(new Error('Invalid local path for SCP: path must not contain ":"'));
      }

      scpArgs.push(localPath, `${config.username}@${config.host}:${remotePath}`);

      const proc = spawn('scp', scpArgs, { timeout: config.timeout });

      let stderr = '';
      let scpOutputTooLarge = false;
      proc.stderr.on('data', (data: Buffer) => {
        if (scpOutputTooLarge) return;
        stderr += data.toString();
        if (stderr.length > 10485760) {
          scpOutputTooLarge = true;
          try { proc.kill('SIGKILL'); } catch {}
        }
      });

      proc.on('close', (code) => {
        if (scpOutputTooLarge) {
          reject(new Error('SCP stderr exceeded 10MB limit'));
        } else if (code === 0) {
          resolve({ success: true });
        } else {
          reject(new Error(`SCP failed: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * 创建浏览器沙箱
   * M-B12 修复：未初始化时返回错误对象而非崩溃
   */
  createBrowserSandbox(options?: {
    headless?: boolean; proxy?: string;
  }): BrowserSandbox | { error: string; sandboxId: null } {
    const opts = options || {};
    if (!this.dataDir) {
      this.logger.warn('createBrowserSandbox 在 init() 之前调用');
      return {
        error: 'SecurityManager not initialized. Call init() before creating a browser sandbox.',
        sandboxId: null,
      };
    }

    const self = this;
    const sandbox: BrowserSandbox = {
      type: 'browser',
      headless: opts.headless !== false,
      sandbox: true,
      disableGpu: true,
      noSandbox: false,
      userDataDir: join(this.dataDir, 'browser-sandbox-profile'),
      start(): { success: boolean; pid?: number; error?: string } {
        const chromePath = self.findChromePath();
        if (!chromePath) {
          return { success: false, error: 'Chrome/Chromium not found for browser sandbox' };
        }
        const args = ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
          '--remote-debugging-port=0', `--user-data-dir=${sandbox.userDataDir}`];
        if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
        try {
          const proc = spawn(chromePath, args, { stdio: 'pipe', windowsHide: true });
          (sandbox as any)._process = proc;
          (sandbox as any)._running = true;
          proc.on('close', () => { (sandbox as any)._running = false; });
          return { success: true, ...(proc.pid !== undefined ? { pid: proc.pid } : {}) };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      stop() {
        const proc = (sandbox as any)._process;
        if (proc) {
          try { proc.kill(); } catch {}
          (sandbox as any)._running = false;
        }
        return { success: true };
      },
      isRunning() {
        return (sandbox as any)._running || false;
      },
      async navigate(url: string) {
        try {
          const result = await self.checkUrl(url);
          if (!result || !result.safe) {
            return {
              success: false,
              error: `URL blocked by SSRF protection: ${url}${result && result.reason ? ` (${result.reason})` : ''}`,
            };
          }
          return { success: true, url, message: 'Navigation command queued' };
        } catch {
          return { success: false, error: `URL check failed: ${url}` };
        }
      },
    };

    const sandboxId = `browser-${this.generateId()}`;
    this.sandboxes[sandboxId] = sandbox;
    this.logger.log(`创建浏览器沙箱: ${sandboxId}`);
    return sandbox;
  }

  /** 查找 Chrome/Chromium 可执行文件路径 */
  private findChromePath(): string | null {
    let candidates: string[] = [];
    if (process.platform === 'win32') {
      candidates = [
        join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ];
    } else if (process.platform === 'darwin') {
      candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    } else {
      candidates = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
    }
    for (const c of candidates) {
      try { if (existsSync(c)) return c; } catch {}
    }
    return null;
  }

  /** 列出浏览器沙箱 */
  listSandboxBrowsers(): Array<{ sandboxId: string; headless: boolean }> {
    const browsers: Array<{ sandboxId: string; headless: boolean }> = [];
    for (const [sandboxId, config] of Object.entries(this.sandboxes)) {
      if ((config as any).type === 'browser') {
        browsers.push({
          sandboxId,
          headless: (config as BrowserSandbox).headless,
        });
      }
    }
    return browsers;
  }

  /**
   * 检查工具是否在沙箱中被允许
   * 工具分类：只读工具 / 写入工具 / 危险工具
   */
  isToolAllowed(toolName: string, sandboxConfig?: { toolPolicy?: ToolPolicy }): boolean {
    if (!sandboxConfig) return true;

    const policy = sandboxConfig.toolPolicy || 'allow-read-only';

    // 只读工具 - 始终允许
    const readOnlyTools = [
      'read', 'search', 'list', 'stat', 'head',
      'grep', 'find', 'cat', 'ls', 'pwd',
      'web-search', 'web-fetch', 'web-scrape',
    ];

    // 危险工具 - 沙箱中始终拒绝
    const dangerousTools = [
      'exec', 'shell', 'spawn', 'fork',
      'eval', 'function', 'sudo', 'su',
    ];

    const lowerTool = toolName.toLowerCase();

    // 检查危险工具
    for (const dt of dangerousTools) {
      if (lowerTool.indexOf(dt) !== -1) return false;
    }

    if (policy === 'allow-all') return true;
    if (policy === 'allow-read-only') {
      for (const rot of readOnlyTools) {
        if (lowerTool.indexOf(rot) !== -1) return true;
      }
      return false;
    }
    if (policy === 'deny-all') return false;

    return false;
  }

  /** 获取沙箱的工具策略 */
  getToolPolicy(sandboxId: string): ToolPolicy | null {
    const config = this.sandboxes[sandboxId] as (DockerSandboxConfig | SshSandboxConfig) | undefined;
    if (!config) return null;
    return (config as DockerSandboxConfig).toolPolicy || 'allow-read-only';
  }

  /**
   * 创建 FS 桥接（文件系统同步桥）
   * M11 修复：使用路径感知的包含检查替代 String.startsWith
   */
  createFsBridge(options?: {
    sourceDir?: string; targetDir?: string; readOnly?: boolean;
  }): FsBridge {
    const opts = options || {};
    const self = this;
    const bridge: FsBridge = {
      type: 'fs',
      sourceDir: opts.sourceDir || process.cwd(),
      targetDir: opts.targetDir || '',
      readOnly: opts.readOnly !== false,
      sync(filePath: string) {
        if (!filePath) return { success: false, error: 'No file path specified' };
        const srcPath = resolve(bridge.sourceDir, filePath);
        if (!bridge.targetDir) return { success: false, error: 'No target directory configured' };
        const dstPath = resolve(bridge.targetDir, filePath);
        if (!self.isSubPath(resolve(bridge.sourceDir), srcPath)) {
          return { success: false, error: 'Path traversal detected' };
        }
        try {
          if (!existsSync(dirname(dstPath))) {
            mkdirSync(dirname(dstPath), { recursive: true });
          }
          copyFileSync(srcPath, dstPath);
          (bridge as any)._syncedFiles[filePath] = { syncedAt: Date.now(), size: statSync(srcPath).size };
          return { success: true, source: srcPath, target: dstPath };
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      syncDir(dirPath?: string) {
        if (!dirPath) dirPath = '.';
        const fullDir = resolve(bridge.sourceDir, dirPath);
        if (!self.isSubPath(resolve(bridge.sourceDir), fullDir)) {
          return { success: false, error: 'Path traversal detected' };
        }
        const results: unknown[] = [];
        try {
          const entries = readdirSync(fullDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile()) {
              const relPath = relative(bridge.sourceDir, join(fullDir, entry.name));
              results.push(bridge.sync(relPath));
            }
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
        return { success: true, results, count: results.length };
      },
      getSyncedFiles() {
        return Object.assign({}, (bridge as any)._syncedFiles);
      },
    };
    (bridge as any)._syncedFiles = {};

    const bridgeId = `fs-${this.generateId()}`;
    this.fsBridges[bridgeId] = bridge;
    this.logger.log(`创建 FS 桥接: ${bridge.sourceDir} -> ${bridge.targetDir || '(none)'}`);
    return bridge;
  }

  /** 为 agent 解析默认沙箱配置 */
  resolveSandboxConfigForAgent(agentId: string): {
    agentId: string; type: string; image: string; memory: string;
    cpus: number; timeout: number; network: string; toolPolicy: ToolPolicy;
  } {
    return {
      agentId,
      type: 'docker',
      image: 'alpine:latest',
      memory: '256m',
      cpus: 0.5,
      timeout: 15000,
      network: 'none',
      toolPolicy: 'allow-read-only',
    };
  }

  // ===========================================================================
  // 3. DM 配对（全量移植自 .cjs 第3节）
  // ===========================================================================

  /**
   * 生成配对码
   * H-B4 修复：使用 crypto.randomInt 替代 Math.random，确保密码学安全
   */
  generatePairingCode(senderId: string, options?: {
    expiresIn?: number; channel?: string;
  }): { code: string; expiresAt: number } {
    this.ensureInitialized();
    const opts = options || {};

    // 生成 6 位配对码
    const code = String(randomInt(100000, 1000000));
    const expiresIn = opts.expiresIn || (5 * 60 * 1000);

    this.pairingCodes[code] = {
      senderId: senderId || null,
      channel: opts.channel || null,
      createdAt: Date.now(),
      expiresAt: Date.now() + expiresIn,
    };

    this.logger.log(`生成配对码: ${code}`);
    return { code, expiresAt: this.pairingCodes[code].expiresAt };
  }

  /**
   * 验证配对码
   * H-B5 修复：配对码绑定 senderId，不同 senderId 使用同一码会被拒绝
   * L-B11 修复：不存储配对码明文，仅存哈希（sha256 + senderId 加盐）
   */
  validatePairingCode(code: string, senderId: string): boolean {
    this.ensureInitialized();

    if (!code || !senderId) return false;

    const entry = this.pairingCodes[code];
    if (!entry) {
      this.logger.warn(`无效配对码: ${code}`);
      return false;
    }

    // 检查过期
    if (Date.now() > entry.expiresAt) {
      delete this.pairingCodes[code];
      this.logger.warn(`配对码已过期: ${code}`);
      return false;
    }

    // H-B5: 配对码绑定 senderId
    if (entry.senderId && entry.senderId !== senderId) {
      this.logger.warn(`配对码 senderId 不匹配: ${code}`);
      return false;
    }

    // 关联 sender 并批准
    entry.senderId = senderId;
    this.pairedDevices[senderId] = {
      pairedAt: Date.now(),
      deviceInfo: {
        senderId,
        // L-B11: 仅存哈希，加盐 senderId 防止彩虹表
        codeHash: createHash('sha256').update(senderId + ':' + code).digest('hex'),
      },
    };

    // 清理已使用的配对码
    delete this.pairingCodes[code];

    // 持久化
    this.persistPairedDevices();

    this.logger.log(`设备已配对: ${senderId}`);
    return true;
  }

  /** 检查设备是否已配对 */
  isPaired(senderId: string): boolean {
    this.ensureInitialized();
    return !!this.pairedDevices[senderId];
  }

  /** 解除配对 */
  unpair(senderId: string): boolean {
    this.ensureInitialized();
    if (this.pairedDevices[senderId]) {
      delete this.pairedDevices[senderId];
      this.persistPairedDevices();
      this.logger.log(`设备已解除配对: ${senderId}`);
      return true;
    }
    return false;
  }

  /** 列出所有已配对设备 */
  listPairedDevices(): PairedDevice[] {
    this.ensureInitialized();
    const devices: PairedDevice[] = [];
    for (const [senderId, device] of Object.entries(this.pairedDevices)) {
      devices.push({
        senderId,
        pairedAt: device.pairedAt,
        deviceInfo: device.deviceInfo,
      });
    }
    return devices;
  }

  /** 注销设备 */
  revokeDevice(senderId: string): boolean {
    this.ensureInitialized();
    if (!this.pairedDevices[senderId]) return false;
    delete this.pairedDevices[senderId];
    this.persistPairedDevices();
    return true;
  }

  private persistPairedDevices(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'paired-devices.json');
    this.saveJson(filePath, this.pairedDevices);
  }

  private loadPairedDevices(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'paired-devices.json');
    this.pairedDevices = this.loadJson(filePath, {});
  }

  // ===========================================================================
  // 4. 执行审批（全量移植自 .cjs 第4节）
  // ===========================================================================

  /**
   * 分类审批级别
   * 返回 'auto'（自动批准）/ 'ask'（需确认）/ 'deny'（始终拒绝）
   *
   * M-B10 修复：命令字符串空格归一化 + flag 顺序归一化
   * 防止 `rm -rf  /`（双空格）、`rm -fr /`（颠倒 flag）等变体绕过黑名单
   */
  classifyApprovalLevel(toolName: string, args?: unknown): ApprovalLevel {
    if (!toolName) return 'deny';

    const lower = toolName.toLowerCase();

    // 自动批准：只读工具、安全搜索工具
    const autoApproveTools = [
      'read', 'search', 'list', 'stat', 'head',
      'grep', 'find', 'cat', 'ls', 'pwd',
      'web-search', 'web-fetch', 'web-scrape',
      'healthcheck', 'status', 'info', 'version',
    ];

    for (const t of autoApproveTools) {
      if (lower.indexOf(t) !== -1) return 'auto';
    }

    // 始终拒绝：危险命令
    const denyPatterns = [
      'rm -rf /', 'rm -rf /*', 'format', 'mkfs',
      'dd if=', ':(){:|:&};:', 'fork bomb',
      'del /s /q c:', 'rd /s /q c:',
      'shutdown', 'reboot', 'halt', 'poweroff',
      'chmod -r 777 /', 'chown -r',
    ];

    let argsStr = '';
    if (args) {
      try {
        argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      } catch {
        argsStr = String(args);
      }
    }

    // M-B10: 空格归一化 + rm flag 顺序归一化
    const combinedRaw = lower + ' ' + argsStr.toLowerCase();
    let combined = combinedRaw.replace(/\s+/g, ' ');
    combined = combined
      .replace(/\brm\s+-([a-z]*?)r([a-z]*?)\s+\//g, 'rm -rf /')
      .replace(/\brm\s+-([a-z]*?)f([a-z]*?)\s+\//g, 'rm -rf /');
    const denyNorm = denyPatterns.map((p) => p.toLowerCase().replace(/\s+/g, ' '));

    for (const d of denyNorm) {
      if (combined.indexOf(d) !== -1) return 'deny';
    }

    // 需确认：文件写入、shell 执行、网络请求
    const askTools = [
      'write', 'edit', 'create', 'delete', 'remove',
      'mkdir', 'rmdir', 'mv', 'cp', 'chmod',
      'exec', 'shell', 'spawn', 'run', 'execute',
      'post', 'put', 'patch', 'delete',
      'install', 'uninstall', 'npm', 'pip', 'apt',
      'docker', 'ssh', 'scp', 'curl', 'wget',
    ];

    for (const t of askTools) {
      if (lower.indexOf(t) !== -1) return 'ask';
    }

    // 默认：未知工具需确认
    return 'ask';
  }

  /** 审批级别数值（用于比较） */
  minSecurity(level: ApprovalLevel): number {
    const levels: Record<ApprovalLevel, number> = { auto: 0, ask: 1, deny: 2 };
    return levels[level] !== undefined ? levels[level] : 1;
  }

  /** 审批级别数值（用于比较） */
  maxAsk(level: ApprovalLevel): number {
    const levels: Record<ApprovalLevel, number> = { auto: 0, ask: 1, deny: 2 };
    return levels[level] !== undefined ? levels[level] : 1;
  }

  /**
   * 请求审批
   * H-B6 修复：尊重会话内 allow-always 决策，不重复提示
   */
  requestApproval(toolName: string, args: unknown, sessionId?: string): {
    approvalId: string | null; status: string; level: ApprovalLevel; toolName: string; reason?: string;
  } {
    this.ensureInitialized();

    const level = this.classifyApprovalLevel(toolName, args);
    const sessionKey = sessionId || 'default';

    // H-B6: 检查会话内 allow-always 决策
    if (level !== 'deny' &&
        this.alwaysApprovedTools[sessionKey] &&
        this.alwaysApprovedTools[sessionKey][toolName]) {
      return {
        approvalId: null,
        status: 'auto-approved',
        level,
        toolName,
        reason: 'Tool approved as allow-always for this session',
      };
    }

    // 自动批准
    if (level === 'auto') {
      return { approvalId: null, status: 'auto-approved', level, toolName };
    }

    // 始终拒绝
    if (level === 'deny') {
      return {
        approvalId: null,
        status: 'denied',
        level,
        toolName,
        reason: 'Tool classified as always-deny',
      };
    }

    // 需要审批
    const approvalId = `approval-${this.generateId()}`;
    const approval: Approval = {
      approvalId,
      toolName,
      args,
      sessionId: sessionId || 'default',
      level,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.pendingApprovals[approvalId] = approval;

    // 记录历史
    const sid = sessionId || 'default';
    if (!this.approvalHistory[sid]) {
      this.approvalHistory[sid] = [];
    }
    this.approvalHistory[sid].push(approval);
    // M-B2: 限制每 session 历史最大 1000 条
    if (this.approvalHistory[sid].length > this.APPROVAL_HISTORY_MAX_PER_SESSION) {
      this.approvalHistory[sid] = this.approvalHistory[sid].slice(-this.APPROVAL_HISTORY_MAX_PER_SESSION);
    }

    this.logger.log(`审批请求: ${toolName} (${approvalId})`);

    return { approvalId, status: 'pending', level, toolName };
  }

  /** 响应审批 */
  respondToApproval(approvalId: string, decision: ApprovalDecision): {
    success: boolean; status?: string; reason?: string;
  } {
    this.ensureInitialized();

    const approval = this.pendingApprovals[approvalId];
    if (!approval) {
      this.logger.warn(`审批不存在: ${approvalId}`);
      return { success: false, reason: 'Approval not found' };
    }

    if (decision === 'allow-once') {
      approval.status = 'approved-once';
      delete this.pendingApprovals[approvalId];
      this.logger.log(`审批允许一次: ${approvalId}`);
      return { success: true, status: 'approved-once' };
    }

    if (decision === 'allow-always') {
      approval.status = 'approved-always';
      delete this.pendingApprovals[approvalId];

      // H-B6: 记录 allow-always 决策，后续同工具/会话跳过提示
      const alwaysSessionKey = approval.sessionId || 'default';
      if (!this.alwaysApprovedTools[alwaysSessionKey]) {
        this.alwaysApprovedTools[alwaysSessionKey] = {};
      }
      this.alwaysApprovedTools[alwaysSessionKey][approval.toolName] = true;

      this.logger.log(`审批始终允许: ${approvalId} 工具: ${approval.toolName}`);
      return { success: true, status: 'approved-always' };
    }

    if (decision === 'deny') {
      approval.status = 'denied';
      delete this.pendingApprovals[approvalId];
      this.logger.log(`审批已拒绝: ${approvalId}`);
      return { success: true, status: 'denied' };
    }

    return { success: false, reason: `Invalid decision: ${decision}` };
  }

  /** 列出待处理审批 */
  listPendingApprovals(): Approval[] {
    this.ensureInitialized();
    return Object.values(this.pendingApprovals);
  }

  /** 获取审批历史 */
  getApprovalHistory(sessionId?: string): Approval[] {
    this.ensureInitialized();
    if (!sessionId) {
      // 返回所有历史
      const all: Approval[] = [];
      for (const history of Object.values(this.approvalHistory)) {
        all.push(...history);
      }
      return all;
    }
    return this.approvalHistory[sessionId] || [];
  }

  // ===========================================================================
  // 6. 安全正则（全量移植自 .cjs 第6节）
  // ===========================================================================

  /**
   * 检测量词嵌套深度
   * L-B3 修复：原名 _calculateStarHeight，实际计算非捕获分组嵌套深度
   */
  private calculateQuantifierNestingDepth(pattern: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === '(' && i + 1 < pattern.length && pattern[i + 1] !== '?') {
        currentDepth++;
        if (currentDepth > maxDepth) maxDepth = currentDepth;
      } else if (pattern[i] === ')') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  /**
   * 检测嵌套量词（可能导致灾难性回溯）
   *
   * 危险形态 = "被量词修饰的分组，其内（含子分组）含可变长度量词"：
   *   (a+)+ / (a*)* / (a{2,3})+ / ((a+)b)+ / (a?)+ 等。
   * 轻量解析器逐字符扫描（处理转义、字符类 [...] 内的字面量、嵌套冒泡），
   * 替代旧版只匹配非法形态（(a++) 等本身是 JS 语法错误）的正则方案。
   */
  private detectNestedQuantifiers(pattern: string): boolean {
    /** 每层开着的分组是否（自身或子分组内）含可变长量词 */
    const groups: boolean[] = [];
    let inClass = false;
    let escaped = false;
    let dangerous = false;

    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i] as string;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (inClass) {
        if (ch === ']') inClass = false;
        continue; // 字符类内的 ()+*{ 均为字面量
      }
      if (ch === '[') { inClass = true; continue; }
      if (ch === '(') {
        groups.push(false);
        // 非捕获/断言/命名分组前缀（(?: (?= (?! (?<= (?<! (?<name>）中的 '?'
        // 不是量词——跳过避免误标记（否则 (?:abc)? / (?<y>\d{4})? 等安全形态被误拦）
        if (pattern[i + 1] === '?') {
          i++; // 消费 '?'
          if (pattern[i + 1] === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!') {
            // 命名分组 (?<name>：跳过组名直到 '>'（组名是标识符，无量词）
            const gt = pattern.indexOf('>', i + 2);
            if (gt > i) i = gt;
          }
        }
        continue;
      }
      if (ch === ')') {
        const has = groups.pop() ?? false;
        const next = pattern[i + 1] ?? '';
        const quantified = next === '+' || next === '*' || next === '{' || next === '?';
        // 量词修饰的分组且分组内含（可变长）量词 → 嵌套量词
        if (quantified && has) dangerous = true;
        // 子分组含量词 → 冒泡给父分组（父分组再被量词修饰同样危险，如 ((a+)b)+）
        if (has && groups.length > 0) groups[groups.length - 1] = true;
        continue;
      }
      // 可变长量词：+、*、?（0/1 长度可变）、{n,m}/{n,}（含逗号才算；{n} 定长安全）
      // 注意：{n,m} 检测不能截短窗口——长数字（如 {1,999999999999}）会漏识别
      const isCountedQuantifier =
        ch === '{' && /\{\d+,\d*\}/.test(pattern.slice(i));
      if (ch === '+' || ch === '*' || ch === '?' || isCountedQuantifier) {
        if (groups.length > 0) groups[groups.length - 1] = true;
        if (isCountedQuantifier) {
          const closeIdx = pattern.indexOf('}', i);
          if (closeIdx > i) i = closeIdx;
        }
        // 跳过量词的惰性/占有修饰符（+?、*?、++）
        if (pattern[i + 1] === '?' || pattern[i + 1] === '+') i++;
        continue;
      }
    }
    return dangerous;
  }

  /**
   * 编译安全正则表达式
   * 防护：
   *   - 嵌套量词检测（ReDoS 防护）
   *   - 嵌套深度限制（≤3）
   *   - 模式长度限制（≤10000 字符）
   *   - LRU 缓存（最大 100 条，M-B4 修复）
   */
  compileSafeRegex(pattern: string, flags?: string): RegExp {
    if (!pattern || typeof pattern !== 'string') {
      throw new Error('Invalid regex pattern');
    }

    // 检查缓存
    const cacheKey = pattern + '||' + (flags || '');
    if (this.compiledRegexCache[cacheKey]) {
      // M-B4: 命中缓存时把 key 移到队尾（模拟 LRU）
      const hitIdx = this.regexCacheKeys.indexOf(cacheKey);
      if (hitIdx >= 0) {
        this.regexCacheKeys.splice(hitIdx, 1);
        this.regexCacheKeys.push(cacheKey);
      }
      return this.compiledRegexCache[cacheKey];
    }

    // 检测嵌套量词
    if (this.detectNestedQuantifiers(pattern)) {
      throw new Error(`Potentially dangerous regex: nested quantifiers detected in pattern: ${pattern}`);
    }

    // 检查嵌套深度
    const starHeight = this.calculateQuantifierNestingDepth(pattern);
    if (starHeight > 3) {
      throw new Error(`Potentially dangerous regex: star height (${starHeight}) exceeds safe limit (3) in pattern: ${pattern}`);
    }

    // 检查模式长度
    if (pattern.length > 10000) {
      throw new Error(`Regex pattern too long: ${pattern.length} characters (max 10000)`);
    }

    try {
      const regex = new RegExp(pattern, flags || '');
      // M-B4: 缓存大小限制 100，超过时淘汰最旧
      this.compiledRegexCache[cacheKey] = regex;
      this.regexCacheKeys.push(cacheKey);
      while (this.regexCacheKeys.length > this.REGEX_CACHE_MAX) {
        const oldKey = this.regexCacheKeys.shift()!;
        delete this.compiledRegexCache[oldKey];
      }
      return regex;
    } catch (err) {
      throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 使用有界输入测试正则
   * M-B5: JS 正则执行不可中断，maxTime 仅能事后判断超时
   * 依赖 compileSafeRegex 在编译期拦截 + 输入长度上限 100000
   */
  testRegexWithBoundedInput(regex: RegExp, input: string, maxTimeMs?: number): RegexTestResult {
    if (!regex || !(regex instanceof RegExp)) {
      throw new Error('Invalid regex object');
    }

    const maxTime = maxTimeMs || 50;
    if (!input || typeof input !== 'string') {
      return { match: false, timedOut: false };
    }

    // 限制输入长度
    let boundedInput = input;
    if (input.length > 100000) {
      boundedInput = input.substring(0, 100000);
    }

    const start = Date.now();
    let timedOut = false;
    let match = false;

    try {
      match = regex.test(boundedInput);
    } catch (err) {
      return { match: false, timedOut: false, error: err instanceof Error ? err.message : String(err) };
    }

    const elapsed = Date.now() - start;
    if (elapsed > maxTime) {
      timedOut = true;
      this.logger.warn(`正则测试超时 ${elapsed}ms (限制: ${maxTime}ms)`);
    }

    return { match, timedOut, elapsedMs: elapsed };
  }

  // ===========================================================================
  // 7. 安全审计（全量移植自 .cjs 第7节）
  // ===========================================================================

  /** 审计文件权限 */
  private auditFilePermissions(): AuditFinding[] {
    const findings: AuditFinding[] = [];

    // L-B4: Unix 权限模型在 Windows 上无意义，跳过
    if (process.platform === 'win32') {
      this.logger.debug('Windows 平台跳过文件权限审计（POSIX mode bits 不适用）');
      return findings;
    }

    try {
      // 检查数据目录权限
      if (this.dataDir && existsSync(this.dataDir)) {
        const stat = statSync(this.dataDir);
        const mode = (stat.mode & parseInt('777', 8)).toString(8);
        if (mode !== '700' && mode !== '750' && mode !== '600') {
          findings.push({
            id: `audit-${++this.auditCounter}`,
            severity: 'medium',
            area: 'file-permissions',
            description: `Data directory has overly permissive permissions: ${mode}`,
            fixable: true,
            fixFn: () => {
              try {
                chmodSync(this.dataDir, 0o700);
                return true;
              } catch (e) {
                this.logger.error(`修复数据目录权限失败: ${e instanceof Error ? e.message : String(e)}`);
                return false;
              }
            },
          });
        }
      }

      // 检查工作区中的敏感文件
      const workspaceDir = process.cwd();
      if (workspaceDir && existsSync(workspaceDir)) {
        const sensitiveFiles = ['.env', '.env.local', '.env.production', 'credentials.json', 'service-account.json'];
        for (const sf of sensitiveFiles) {
          const filePath = join(workspaceDir, sf);
          if (existsSync(filePath)) {
            findings.push({
              id: `audit-${++this.auditCounter}`,
              severity: 'high',
              area: 'file-permissions',
              description: `Sensitive file found in workspace: ${sf}`,
              fixable: false,
            });
          }
        }
      }
    } catch (err) {
      this.logger.error(`文件权限审计错误: ${err instanceof Error ? err.message : String(err)}`);
    }

    return findings;
  }

  /** 审计配置安全性 */
  private auditConfigSafety(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const ssrfConfig = this.ssrfGuard.getConfig();

    // 检查 SSRF 配置
    if (ssrfConfig.dangerouslyAllowPrivateNetwork) {
      findings.push({
        id: `audit-${++this.auditCounter}`,
        severity: 'critical',
        area: 'config-safety',
        description: 'dangerouslyAllowPrivateNetwork is enabled - SSRF protection is weakened',
        fixable: true,
        fixFn: () => {
          this.ssrfGuard.setConfig({ dangerouslyAllowPrivateNetwork: false });
          this.logger.log('已修复: 禁用 dangerouslyAllowPrivateNetwork');
          return true;
        },
      });
    }

    // 检查沙箱配置
    for (const [sandboxId, config] of Object.entries(this.sandboxes)) {
      const cfg = config as DockerSandboxConfig;
      if (cfg.network === 'host') {
        findings.push({
          id: `audit-${++this.auditCounter}`,
          severity: 'high',
          area: 'config-safety',
          description: `Sandbox ${sandboxId} uses host networking`,
          fixable: false,
        });
      }
      if (cfg.toolPolicy === 'allow-all') {
        findings.push({
          id: `audit-${++this.auditCounter}`,
          severity: 'high',
          area: 'config-safety',
          description: `Sandbox ${sandboxId} allows all tools`,
          fixable: true,
          fixFn: () => {
            (this.sandboxes[sandboxId] as DockerSandboxConfig).toolPolicy = 'allow-read-only';
            return true;
          },
        });
      }
    }

    return findings;
  }

  /** 审计 API 密钥暴露 */
  private auditApiKeyExposure(): AuditFinding[] {
    const findings: AuditFinding[] = [];

    try {
      const envKeys = Object.keys(process.env);
      const keyPatterns = [
        /API_KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i,
        /PRIVATE_KEY/i, /ACCESS_KEY/i, /AUTH/i,
      ];

      for (const envKey of envKeys) {
        for (const pattern of keyPatterns) {
          if (pattern.test(envKey)) {
            const value = process.env[envKey];
            if (value && value.length > 0 && value !== '' && value !== 'undefined') {
              findings.push({
                id: `audit-${++this.auditCounter}`,
                severity: 'low',
                area: 'api-key-exposure',
                description: `Potential secret in environment variable: ${envKey}`,
                fixable: false,
              });
            }
            break;
          }
        }
      }
    } catch (err) {
      this.logger.error(`API 密钥暴露审计错误: ${err instanceof Error ? err.message : String(err)}`);
    }

    return findings;
  }

  /** 审计网络访问 */
  private auditNetworkAccess(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const ssrfConfig = this.ssrfGuard.getConfig();

    if (ssrfConfig.allowedHostnames.length > 10) {
      findings.push({
        id: `audit-${++this.auditCounter}`,
        severity: 'medium',
        area: 'network-access',
        description: `Large number of allowed hostnames (${ssrfConfig.allowedHostnames.length}) - consider reducing`,
        fixable: false,
      });
    }

    if (ssrfConfig.allowedOrigins.length > 10) {
      findings.push({
        id: `audit-${++this.auditCounter}`,
        severity: 'medium',
        area: 'network-access',
        description: `Large number of allowed origins (${ssrfConfig.allowedOrigins.length}) - consider reducing`,
        fixable: false,
      });
    }

    return findings;
  }

  /** 审计命令规则 */
  private auditCommandRules(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const rules = this.commandGuard.listCommandRules();

    for (const rule of rules) {
      if (rule.type === 'allow' && rule.command === '*') {
        findings.push({
          id: `audit-${++this.auditCounter}`,
          severity: 'critical',
          area: 'command-rules',
          description: 'Wildcard allow rule detected - all commands are allowed',
          fixable: true,
          fixFn: () => {
            return this.commandGuard.removeCommandRule(rule.id);
          },
        });
      }
    }

    return findings;
  }

  /** 运行完整安全审计 */
  runAudit(): AuditFinding[] {
    this.ensureInitialized();

    this.auditFindings = [];

    const filePermFindings = this.auditFilePermissions();
    const configFindings = this.auditConfigSafety();
    const apiKeyFindings = this.auditApiKeyExposure();
    const networkFindings = this.auditNetworkAccess();
    const commandFindings = this.auditCommandRules();

    this.auditFindings = [
      ...filePermFindings,
      ...configFindings,
      ...apiKeyFindings,
      ...networkFindings,
      ...commandFindings,
    ];

    this.logger.log(`安全审计完成: ${this.auditFindings.length} 项发现`);
    return this.auditFindings;
  }

  /** 获取审计报告（文本格式） */
  getAuditReport(): string {
    this.ensureInitialized();

    const severityCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of this.auditFindings) {
      if (severityCounts[f.severity] !== undefined) severityCounts[f.severity]++;
    }

    let report = '';
    report += '=== Security Audit Report ===\n';
    report += `Generated: ${new Date().toISOString()}\n`;
    report += `Total Findings: ${this.auditFindings.length}\n`;
    report += `  Critical: ${severityCounts['critical']}\n`;
    report += `  High: ${severityCounts['high']}\n`;
    report += `  Medium: ${severityCounts['medium']}\n`;
    report += `  Low: ${severityCounts['low']}\n`;
    report += '\n';

    if (this.auditFindings.length === 0) {
      report += 'No security findings.\n';
    } else {
      for (const f of this.auditFindings) {
        report += `[${f.severity.toUpperCase()}] ${f.area}: ${f.description}`;
        report += f.fixable ? ' (fixable)' : '';
        report += '\n';
      }
    }

    report += '\n=== End of Report ===\n';
    return report;
  }

  /** 修复单个审计发现 */
  fixFinding(findingId: string): { success: boolean; reason?: string } {
    this.ensureInitialized();

    for (let i = 0; i < this.auditFindings.length; i++) {
      if (this.auditFindings[i].id === findingId) {
        const finding = this.auditFindings[i];
        if (!finding.fixable) {
          return { success: false, reason: 'Finding is not auto-fixable' };
        }
        try {
          const result = finding.fixFn ? finding.fixFn() : false;
          if (result) {
            this.auditFindings.splice(i, 1);
            this.logger.log(`已修复发现: ${findingId}`);
            return { success: true };
          }
          return { success: false, reason: 'Fix function returned false' };
        } catch (err) {
          return { success: false, reason: `Fix failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    }

    return { success: false, reason: `Finding not found: ${findingId}` };
  }

  /** 修复所有可修复的审计发现 */
  fixAllFindings(): Array<{ id: string; success: boolean; reason?: string }> {
    this.ensureInitialized();
    const results: Array<{ id: string; success: boolean; reason?: string }> = [];
    for (let i = this.auditFindings.length - 1; i >= 0; i--) {
      const f = this.auditFindings[i];
      if (f.fixable) {
        try {
          const r = f.fixFn ? f.fixFn() : false;
          if (r) {
            results.push({ id: f.id, success: true });
            this.auditFindings.splice(i, 1);
          } else {
            results.push({ id: f.id, success: false, reason: 'Fix function returned false' });
          }
        } catch (err) {
          results.push({ id: f.id, success: false, reason: err instanceof Error ? err.message : String(err) });
        }
      } else {
        results.push({ id: f.id, success: false, reason: 'Not auto-fixable' });
      }
    }
    return results;
  }

  /** 列出审计发现（不含 fixFn） */
  listFindings(): Array<Omit<AuditFinding, 'fixFn'>> {
    this.ensureInitialized();
    return this.auditFindings.map((f) => ({
      id: f.id,
      severity: f.severity,
      area: f.area,
      description: f.description,
      fixable: f.fixable,
    }));
  }

  // ===========================================================================
  // 9. 危险配置标志（全量移植自 .cjs 第9节）
  // ===========================================================================

  /**
   * 扫描配置中的危险标志
   * C-F2 修复：使用局部数组收集结果，递归调用不会覆盖外层结果
   */
  scanConfig(config: Record<string, unknown>): DangerousFlag[] {
    const flags: DangerousFlag[] = [];

    if (!config || typeof config !== 'object') {
      this.dangerousFlags = flags;
      return flags;
    }

    const dangerousKeys: Array<{ key: string; severity: AuditSeverity; description: string }> = [
      { key: 'dangerouslyAllowPrivateNetwork', severity: 'critical', description: 'Allows SSRF attacks by permitting private network access' },
      { key: 'dangerouslyDisableSandbox', severity: 'critical', description: 'Disables sandbox isolation for code execution' },
      { key: 'dangerouslyAllowAllHosts', severity: 'critical', description: 'Allows connections to any hostname without restrictions' },
      { key: 'dangerouslyDisableAuth', severity: 'critical', description: 'Disables authentication' },
      { key: 'dangerouslyAllowAllCommands', severity: 'high', description: 'Allows all commands without restrictions' },
      { key: 'dangerouslyDisablePathRestrictions', severity: 'high', description: 'Disables file system path restrictions' },
      { key: 'dangerouslyDisableApprovalFlow', severity: 'high', description: 'Disables approval flow for dangerous operations' },
      { key: 'dangerouslyEnableEval', severity: 'high', description: 'Enables eval() which can lead to code injection' },
      { key: 'dangerouslyAllowHttp', severity: 'medium', description: 'Allows HTTP (non-HTTPS) connections' },
      { key: 'dangerouslySkipTlsVerify', severity: 'high', description: 'Skips TLS certificate verification' },
      { key: 'dangerouslyExposeEnv', severity: 'medium', description: 'Exposes environment variables to sandboxed code' },
      { key: 'dangerouslyAllowRoot', severity: 'high', description: 'Allows running commands as root' },
    ];

    for (const dk of dangerousKeys) {
      const val = (config as Record<string, unknown>)[dk.key];
      if (val !== undefined && val !== false) {
        flags.push({
          key: dk.key,
          value: val,
          severity: dk.severity,
          description: dk.description,
        });
      }
    }

    // 深度扫描嵌套对象（C-F2 修复：递归收集到局部数组，外层合并）
    for (const val of Object.values(config)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const nestedFlags = this.scanConfig(val as Record<string, unknown>);
        for (const nf of nestedFlags) {
          // 去重
          if (!flags.some((f) => f.key === nf.key)) {
            flags.push(nf);
          }
        }
      }
    }

    if (flags.length > 0) {
      this.logger.log(`配置扫描发现 ${flags.length} 个危险标志`);
    }

    this.dangerousFlags = flags;
    return flags;
  }

  /** 获取最近的危险标志扫描结果 */
  getDangerousFlags(): DangerousFlag[] {
    return this.dangerousFlags.slice();
  }

  // ===========================================================================
  // 通用输入校验（保留原有功能）
  // ===========================================================================

  /** HTML 转义防 XSS */
  sanitizeHtml(input: string): string {
    if (!input) return '';
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 数值验证：将 unknown 安全转为 number 并限制在 [min, max] 范围内 */
  validateNumeric(value: unknown, min: number, max: number): number {
    let num: number;
    if (typeof value === 'number') {
      if (isNaN(value) || !isFinite(value)) {
        throw new Error(`Invalid numeric value: ${String(value)}`);
      }
      num = value;
    } else if (typeof value === 'string') {
      num = Number(value);
      if (isNaN(num) || !isFinite(num)) {
        throw new Error(`Invalid numeric value: ${value}`);
      }
    } else {
      throw new Error(`Invalid numeric value: ${String(value)}`);
    }
    if (num < min) throw new Error(`Value ${num} is below minimum ${min}`);
    if (num > max) throw new Error(`Value ${num} exceeds maximum ${max}`);
    return num;
  }

  /** 字符串验证：确保 value 为字符串并限制最大长度 */
  validateString(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') {
      throw new Error(`Expected string, got ${typeof value}`);
    }
    if (maxLength > 0 && value.length > maxLength) {
      throw new Error(`String length ${value.length} exceeds maximum ${maxLength}`);
    }
    return value;
  }

  // ===========================================================================
  // 定时清理（M-B1/M-B3 修复）
  // ===========================================================================

  /** 启动定时清理过期审批与配对码（每5分钟） */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      try {
        const now = Date.now();
        // 清理过期审批
        for (const [approvalId, a] of Object.entries(this.pendingApprovals)) {
          if (a && a.createdAt && now - a.createdAt > this.APPROVAL_TTL_MS) {
            this.logger.log(`清理: 移除过期审批 ${approvalId}`);
            delete this.pendingApprovals[approvalId];
          }
        }
        // 清理过期配对码
        for (const [code, entry] of Object.entries(this.pairingCodes)) {
          if (entry && entry.expiresAt && now > entry.expiresAt) {
            this.logger.log('清理: 移除过期配对码');
            delete this.pairingCodes[code];
          }
        }
      } catch (e) {
        this.logger.error(`清理定时器错误: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 5 * 60 * 1000);
    // unref 让定时器不阻止进程退出
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  // ===========================================================================
  // 通用辅助方法
  // ===========================================================================

  /** 生成唯一 ID（M-D13: 使用 crypto.randomBytes 避免碰撞） */
  private generateId(): string {
    return Date.now().toString(36) + '-' + randomBytes(4).toString('hex');
  }

  /**
   * 判断 childPath 是否在 parentPath 之下
   * M9 修复：Windows 下大小写归一化
   */
  private isSubPath(parentPath: string, childPath: string): boolean {
    let parent = parentPath;
    let child = childPath;
    if (platform() === 'win32') {
      parent = String(parent).toLowerCase();
      child = String(child).toLowerCase();
    }
    const rel = relative(parent, child);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }

  private ensureDir(dirPath: string): void {
    try {
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    } catch (err) {
      this.logger.error(`创建目录失败 ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadJson<T>(filePath: string, defaultValue: T): T {
    try {
      if (existsSync(filePath)) {
        const data = readFileSync(filePath, 'utf8');
        return JSON.parse(data) as T;
      }
    } catch (err) {
      this.logger.error(`加载文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return defaultValue;
  }

  /** 原子写入 JSON 文件（M-B14 修复） */
  private saveJson(filePath: string, data: unknown): void {
    try {
      this.ensureDir(dirname(filePath));
      const content = JSON.stringify(data, null, 2);
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpPath, content, 'utf8');
      try {
        renameSync(tmpPath, filePath);
      } catch {
        try { unlinkSync(filePath); } catch {}
        renameSync(tmpPath, filePath);
      }
    } catch (err) {
      this.logger.error(`保存文件失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
