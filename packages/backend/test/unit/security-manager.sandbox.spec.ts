import 'reflect-metadata';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import type { BrowserSandbox } from '../../src/modules/core/security/security-manager.service.js';
import type { PathGuardService } from '../../src/modules/core/security/path-guard.service.js';
import type { CommandGuardService } from '../../src/modules/core/security/command-guard.service.js';
import type { SsrfGuardService } from '../../src/modules/core/security/ssrf-guard.service.js';

/**
 * SecurityManagerService 自有逻辑补充测试（沙箱/配对/审批/正则/审计/配置扫描）：
 *   - child_process 全 mock（exec/spawn），不触碰真实 Docker/SSH/SCP/Chrome
 *   - 文件系统使用 SKYALYTICWING_DATA_DIR 临时目录
 */

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  exec: jest.fn(),
  spawn: jest.fn(),
}));

const execMock = childProcess.exec as unknown as jest.Mock;
const spawnMock = childProcess.spawn as unknown as jest.Mock;

/** 构造 fake 子进程（EventEmitter + stdout/stderr 流 + stdin + kill） */
function makeFakeProc(pid = 4242): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: jest.Mock; end: jest.Mock }; kill: jest.Mock; pid: number } {
  const proc = new EventEmitter() as never as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: jest.Mock; end: jest.Mock };
    kill: jest.Mock;
    pid: number;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: jest.fn(), end: jest.fn() };
  proc.kill = jest.fn();
  proc.pid = pid;
  return proc;
}

const makePathGuard = () => ({}) as unknown as jest.Mocked<PathGuardService>;

const makeCommandGuard = () =>
  ({
    listCommandRules: jest.fn().mockReturnValue([]),
    removeCommandRule: jest.fn().mockReturnValue(true),
  }) as unknown as jest.Mocked<CommandGuardService>;

const defaultSsrfConfig = () => ({
  allowPrivateNetwork: false,
  dangerouslyAllowPrivateNetwork: false,
  allowedHostnames: [],
  allowedOrigins: [],
});

const makeSsrfGuard = () =>
  ({
    checkUrl: jest.fn().mockResolvedValue({ safe: true, reason: '' }),
    getConfig: jest.fn().mockReturnValue(defaultSsrfConfig()),
    setConfig: jest.fn(),
  }) as unknown as jest.Mocked<SsrfGuardService>;

const prevDataDir = process.env['SKYALYTICWING_DATA_DIR'];
const savedChromeEnv = {
  x86: process.env['PROGRAMFILES(X86)'],
  pf: process.env['PROGRAMFILES'],
  la: process.env['LOCALAPPDATA'],
};

describe('SecurityManagerService 自有逻辑', () => {
  let service: SecurityManagerService;
  let pathGuard: jest.Mocked<PathGuardService>;
  let commandGuard: jest.Mocked<CommandGuardService>;
  let ssrfGuard: jest.Mocked<SsrfGuardService>;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'secmgr-data-'));
    process.env['SKYALYTICWING_DATA_DIR'] = dataDir;
    execMock.mockReset();
    execMock.mockImplementation(
      (_cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
        return null as never;
      },
    );
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeProc());
    pathGuard = makePathGuard();
    commandGuard = makeCommandGuard();
    ssrfGuard = makeSsrfGuard();
    service = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
    service.init();
  });

  afterEach(() => {
    service.onModuleDestroy();
    if (prevDataDir === undefined) delete process.env['SKYALYTICWING_DATA_DIR'];
    else process.env['SKYALYTICWING_DATA_DIR'] = prevDataDir;
    if (savedChromeEnv.x86 === undefined) delete process.env['PROGRAMFILES(X86)'];
    else process.env['PROGRAMFILES(X86)'] = savedChromeEnv.x86;
    if (savedChromeEnv.pf === undefined) delete process.env['PROGRAMFILES'];
    else process.env['PROGRAMFILES'] = savedChromeEnv.pf;
    if (savedChromeEnv.la === undefined) delete process.env['LOCALAPPDATA'];
    else process.env['LOCALAPPDATA'] = savedChromeEnv.la;
  });

  // ------------------------------------------------------------------
  // 生命周期与初始化
  // ------------------------------------------------------------------
  describe('初始化', () => {
    it('init 幂等，onModuleInit 可用', () => {
      expect(() => service.init()).not.toThrow();
      const fresh = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
      expect(() => fresh.onModuleInit()).not.toThrow();
      fresh.onModuleDestroy();
    });

    it('未初始化时安全方法抛异常（fail-close）', () => {
      const fresh = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
      expect(() => fresh.requestApproval('exec', {})).toThrow(/未初始化/);
      expect(() => fresh.listPendingApprovals()).toThrow(/未初始化/);
      expect(() => fresh.getApprovalHistory()).toThrow(/未初始化/);
      expect(() => fresh.generatePairingCode('u')).toThrow(/未初始化/);
      expect(() => fresh.validatePairingCode('123456', 'u')).toThrow(/未初始化/);
      expect(() => fresh.isPaired('u')).toThrow(/未初始化/);
      expect(() => fresh.unpair('u')).toThrow(/未初始化/);
      expect(() => fresh.listPairedDevices()).toThrow(/未初始化/);
      expect(() => fresh.revokeDevice('u')).toThrow(/未初始化/);
      expect(() => fresh.runAudit()).toThrow(/未初始化/);
      expect(() => fresh.getAuditReport()).toThrow(/未初始化/);
      expect(() => fresh.fixFinding('x')).toThrow(/未初始化/);
      expect(() => fresh.fixAllFindings()).toThrow(/未初始化/);
      expect(() => fresh.listFindings()).toThrow(/未初始化/);
    });

    it('数据目录取自 SKYALYTICWING_DATA_DIR/security 并持久化配对设备', () => {
      const { code } = service.generatePairingCode('dev-x');
      expect(service.validatePairingCode(code, 'dev-x')).toBe(true);
      expect(existsSync(join(dataDir, 'security', 'paired-devices.json'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // isDockerAvailable
  // ------------------------------------------------------------------
  describe('isDockerAvailable', () => {
    it('exec 同步抛异常时 fail-close 返回 false（try/catch 分支）', async () => {
      execMock.mockImplementation(() => {
        throw new Error('exec sync throw');
      });
      await expect(service.isDockerAvailable()).resolves.toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Docker 沙箱
  // ------------------------------------------------------------------
  describe('Docker 沙箱', () => {
    it('createDockerSandbox 默认配置与非法环境变量过滤（M-B6）', async () => {
      const sandboxId = service.createDockerSandbox({
        memory: '256m',
        cpus: 0.5,
        env: { GOOD_V: '1', 'bad-name': 'x', '1BAD': 'y' } as Record<string, string>,
        toolPolicy: 'allow-all',
      });
      expect(sandboxId).toMatch(/^docker-/);
      expect(service.getToolPolicy(sandboxId)).toBe('allow-all');

      const p = service.runInDocker('echo hi', { sandboxId });
      const proc = spawnMock.mock.results[spawnMock.mock.results.length - 1].value;
      proc.stdout.emit('data', Buffer.from('ok'));
      proc.emit('close', 0);
      await expect(p).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(spawnMock.mock.calls[0][0]).toBe('docker');
      expect(args).toContain('run');
      expect(args).toContain('--memory=256m');
      expect(args).toContain('--cpus=0.5');
      expect(args).toContain('--network=none');
      expect(args).toContain('--workdir=/workspace');
      expect(args).toContain('GOOD_V="1"');
      expect(args.some((a) => a.includes('bad-name') || a.includes('1BAD'))).toBe(false);
      expect(args.slice(-4)).toEqual(['alpine:latest', 'sh', '-c', 'echo hi']);
    });

    it('默认参数：image=alpine memory=512m toolPolicy=allow-read-only', async () => {
      const sandboxId = service.createDockerSandbox();
      expect(service.getToolPolicy(sandboxId)).toBe('allow-read-only');
      const p = service.runInDocker('ls', { sandboxId });
      const proc = spawnMock.mock.results[0].value;
      proc.emit('close', 1);
      const r = await p;
      expect(r.exitCode).toBe(1);
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain('--memory=512m');
      expect(args).toContain('alpine:latest');
    });

    it('沙箱不存在 / 类型不符 → reject', async () => {
      await expect(service.runInDocker('ls')).rejects.toThrow('Docker sandbox not found or invalid');
      await expect(service.runInDocker('ls', { sandboxId: 'docker-nope' })).rejects.toThrow('Docker sandbox not found');
      const sshId = service.createSshSandbox();
      await expect(service.runInDocker('ls', { sandboxId: sshId })).rejects.toThrow('Docker sandbox not found');
    });

    it('stdout 超过 10MB → kill 并 reject', async () => {
      const sandboxId = service.createDockerSandbox({ timeout: 60000 });
      const p = service.runInDocker('big', { sandboxId });
      const proc = spawnMock.mock.results[0].value;
      proc.stdout.emit('data', Buffer.alloc(11 * 1024 * 1024, 65));
      proc.emit('close', 0);
      await expect(p).rejects.toThrow('exceeded 10MB limit');
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('命令超时 → kill 并 reject', async () => {
      const sandboxId = service.createDockerSandbox({ timeout: 100 });
      let p: Promise<unknown>;
      try {
        jest.useFakeTimers();
        p = service.runInDocker('slow', { sandboxId });
        const proc = spawnMock.mock.results[0].value;
        jest.advanceTimersByTime(150);
        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
        proc.emit('close', null);
        await expect(p).rejects.toThrow('timed out after 100ms');
      } finally {
        jest.useRealTimers();
      }
    });

    it('spawn error 事件 → reject', async () => {
      const sandboxId = service.createDockerSandbox();
      const p = service.runInDocker('x', { sandboxId });
      const proc = spawnMock.mock.results[0].value;
      proc.emit('error', new Error('docker daemon down'));
      await expect(p).rejects.toThrow('docker daemon down');
    });
  });

  // ------------------------------------------------------------------
  // SSH 沙箱
  // ------------------------------------------------------------------
  describe('SSH 沙箱', () => {
    it('createSshSandbox 默认配置，runInSsh 成功并通过 stdin 传递命令（H-B1）', async () => {
      const sandboxId = service.createSshSandbox();
      expect(sandboxId).toMatch(/^ssh-/);
      expect(service.getToolPolicy(sandboxId)).toBe('allow-read-only');

      const p = service.runInSsh('uptime', { sandboxId });
      const proc = spawnMock.mock.results[0].value;
      proc.stdout.emit('data', Buffer.from('up 1 day'));
      proc.stderr.emit('data', Buffer.from('warn'));
      proc.emit('close', 0);
      const r = await p;
      expect(r).toEqual({ exitCode: 0, stdout: 'up 1 day', stderr: 'warn' });
      expect(proc.stdin.write).toHaveBeenCalledWith('uptime\n');
      expect(proc.stdin.end).toHaveBeenCalled();

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(spawnMock.mock.calls[0][0]).toBe('ssh');
      expect(args).toContain('-p');
      expect(args).toContain('22');
      expect(args).toContain('root@localhost');
    });

    it('privateKey 时附加 -i 参数', async () => {
      const sandboxId = service.createSshSandbox({ host: 'h', port: 2222, username: 'ops', privateKey: '/key' });
      const p = service.runInSsh('ls', { sandboxId });
      const proc = spawnMock.mock.results[0].value;
      proc.emit('close', 0);
      await p;
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain('-i');
      expect(args).toContain('/key');
      expect(args).toContain('ops@h');
      expect(args).toContain('-p');
      expect(args).toContain('2222');
    });

    it('沙箱不存在 → reject', async () => {
      await expect(service.runInSsh('ls')).rejects.toThrow('SSH sandbox not found');
      await expect(service.runInSsh('ls', { sandboxId: 'ssh-nope' })).rejects.toThrow('SSH sandbox not found');
    });

    it('命令超时 → reject', async () => {
      const sandboxId = service.createSshSandbox({ timeout: 80 });
      let p: Promise<unknown>;
      try {
        jest.useFakeTimers();
        p = service.runInSsh('sleep', { sandboxId });
        const proc = spawnMock.mock.results[0].value;
        jest.advanceTimersByTime(120);
        await expect(p).rejects.toThrow('SSH command timed out after 80ms');
        // 超时后 close/error 不再二次结算
        proc.emit('close', 0);
        proc.emit('error', new Error('late'));
      } finally {
        jest.useRealTimers();
      }
    });

    it('stdout/stderr 超 10MB → reject', async () => {
      const sid = service.createSshSandbox();
      const p1 = service.runInSsh('big', { sandboxId: sid });
      const proc1 = spawnMock.mock.results[0].value;
      proc1.stdout.emit('data', Buffer.alloc(11 * 1024 * 1024, 66));
      await expect(p1).rejects.toThrow('SSH command output exceeded 10MB limit');

      const p2 = service.runInSsh('bigerr', { sandboxId: sid });
      const proc2 = spawnMock.mock.results[1].value;
      proc2.stderr.emit('data', Buffer.alloc(11 * 1024 * 1024, 67));
      await expect(p2).rejects.toThrow('stderr exceeded 10MB limit');
    });

    it('spawn error 事件 → reject', async () => {
      const sid = service.createSshSandbox();
      const p = service.runInSsh('x', { sandboxId: sid });
      const proc = spawnMock.mock.results[0].value;
      proc.emit('error', new Error('ssh binary missing'));
      await expect(p).rejects.toThrow('ssh binary missing');
    });
  });

  // ------------------------------------------------------------------
  // SCP 上传
  // ------------------------------------------------------------------
  describe('uploadToSsh', () => {
    it('无 SSH 沙箱时 reject', async () => {
      await expect(service.uploadToSsh('/local', '/remote')).rejects.toThrow('No SSH sandbox available');
    });

    it('本地路径含 ":" 拒绝（C-F3 防注入）', async () => {
      service.createSshSandbox();
      await expect(service.uploadToSsh('C:\\evil:path', '/remote')).rejects.toThrow('must not contain ":"');
    });

    it('成功上传 / 失败退出码 / error 事件', async () => {
      const sid = service.createSshSandbox({ port: 2222, privateKey: '/k' });
      expect(sid).toBeTruthy();

      const ok = service.uploadToSsh('/local/f', '/remote/f');
      const proc1 = spawnMock.mock.results[0].value;
      expect(spawnMock.mock.calls[0][0]).toBe('scp');
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toContain('-P');
      expect(args).toContain('2222');
      expect(args).toContain('-i');
      expect(args).toContain('/k');
      expect(args).toContain('root@localhost:/remote/f');
      proc1.emit('close', 0);
      await expect(ok).resolves.toEqual({ success: true });

      const bad = service.uploadToSsh('/local/f', '/remote/f');
      const proc2 = spawnMock.mock.results[1].value;
      proc2.stderr.emit('data', Buffer.from('permission denied'));
      proc2.emit('close', 1);
      await expect(bad).rejects.toThrow(/SCP failed: permission denied/);

      const err = service.uploadToSsh('/local/f', '/remote/f');
      const proc3 = spawnMock.mock.results[2].value;
      proc3.emit('error', new Error('scp missing'));
      await expect(err).rejects.toThrow('scp missing');
    });

    it('stderr 超 10MB → kill 并 reject', async () => {
      service.createSshSandbox();
      const p = service.uploadToSsh('/l', '/r');
      const proc = spawnMock.mock.results[0].value;
      proc.stderr.emit('data', Buffer.alloc(11 * 1024 * 1024, 68));
      proc.emit('close', 0);
      await expect(p).rejects.toThrow('SCP stderr exceeded 10MB limit');
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });

  // ------------------------------------------------------------------
  // 浏览器沙箱
  // ------------------------------------------------------------------
  describe('浏览器沙箱', () => {
    it('createBrowserSandbox 默认 headless，listSandboxBrowsers 可见', () => {
      const sandbox = service.createBrowserSandbox() as BrowserSandbox;
      expect(sandbox.type).toBe('browser');
      expect(sandbox.headless).toBe(true);
      const browsers = service.listSandboxBrowsers();
      expect(browsers).toEqual([{ sandboxId: expect.stringMatching(/^browser-/), headless: true }]);
      const visible = service.createBrowserSandbox({ headless: false }) as BrowserSandbox;
      expect(visible.headless).toBe(false);
    });

    it('找不到 Chrome 时 start 返回错误', function () {
      if (process.platform !== 'win32') this.skip();
      const empty = mkdtempSync(join(tmpdir(), 'nochrome-'));
      process.env['PROGRAMFILES(X86)'] = empty;
      process.env['PROGRAMFILES'] = empty;
      process.env['LOCALAPPDATA'] = empty;
      const sandbox = service.createBrowserSandbox() as BrowserSandbox;
      const r = sandbox.start();
      expect(r.success).toBe(false);
      expect(r.error).toContain('not found');
    });

    it('start 成功记录 pid，stop 后 isRunning=false', function () {
      if (process.platform !== 'win32') this.skip();
      const base = mkdtempSync(join(tmpdir(), 'fakechrome-'));
      const chromeDir = join(base, 'Google', 'Chrome', 'Application');
      mkdirSync(chromeDir, { recursive: true });
      writeFileSync(join(chromeDir, 'chrome.exe'), 'fake');
      process.env['PROGRAMFILES(X86)'] = base;
      process.env['PROGRAMFILES'] = mkdtempSync(join(tmpdir(), 'nochrome-'));
      process.env['LOCALAPPDATA'] = mkdtempSync(join(tmpdir(), 'nochrome-'));

      const sandbox = service.createBrowserSandbox({ proxy: 'http://127.0.0.1:7890' }) as BrowserSandbox;
      const r = sandbox.start();
      expect(r.success).toBe(true);
      expect(r.pid).toBe(4242);
      expect(sandbox.isRunning()).toBe(true);
      const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      expect(String(call[0])).toContain('chrome.exe');
      expect((call[1] as string[])).toContain('--headless');
      expect((call[1] as string[])).toContain('--proxy-server=http://127.0.0.1:7890');

      const proc = spawnMock.mock.results[spawnMock.mock.results.length - 1].value;
      sandbox.stop();
      expect(proc.kill).toHaveBeenCalled();
      expect(sandbox.isRunning()).toBe(false);
    });

    it('stop 未启动的沙箱也返回 success', () => {
      const sandbox = service.createBrowserSandbox() as BrowserSandbox;
      expect(sandbox.stop()).toEqual({ success: true });
      expect(sandbox.isRunning()).toBe(false);
    });

    it('navigate 被 SSRF 拦截 / 通过 / 校验异常', async () => {
      const sandbox = service.createBrowserSandbox() as BrowserSandbox;
      (ssrfGuard.checkUrl as jest.Mock).mockResolvedValue({ safe: false, reason: 'Private IP blocked' });
      const blocked = await sandbox.navigate('http://169.254.169.254/');
      expect(blocked.success).toBe(false);
      expect(blocked.error).toContain('blocked by SSRF');

      (ssrfGuard.checkUrl as jest.Mock).mockResolvedValue({ safe: true, reason: '' });
      const ok = await sandbox.navigate('https://example.com/');
      expect(ok).toEqual({ success: true, url: 'https://example.com/', message: 'Navigation command queued' });

      (ssrfGuard.checkUrl as jest.Mock).mockRejectedValue(new Error('dns boom'));
      const failed = await sandbox.navigate('https://bad.invalid/');
      expect(failed.success).toBe(false);
      expect(failed.error).toContain('URL check failed');
    });
  });

  // ------------------------------------------------------------------
  // 工具策略
  // ------------------------------------------------------------------
  describe('isToolAllowed / getToolPolicy', () => {
    it('无沙箱配置时默认允许', () => {
      expect(service.isToolAllowed('anything')).toBe(true);
    });

    it('危险工具在任何策略下拒绝（大小写不敏感）', () => {
      expect(service.isToolAllowed('exec_cmd', { toolPolicy: 'allow-all' })).toBe(false);
      expect(service.isToolAllowed('Sudo', { toolPolicy: 'allow-all' })).toBe(false);
      expect(service.isToolAllowed('my-eval-tool', { toolPolicy: 'allow-all' })).toBe(false);
      expect(service.isToolAllowed('spawn_worker', { toolPolicy: 'allow-all' })).toBe(false);
    });

    it('allow-read-only：只读工具放行，写工具拒绝', () => {
      expect(service.isToolAllowed('file-read', { toolPolicy: 'allow-read-only' })).toBe(true);
      expect(service.isToolAllowed('web-search', { toolPolicy: 'allow-read-only' })).toBe(true);
      expect(service.isToolAllowed('list-dir', { toolPolicy: 'allow-read-only' })).toBe(true);
      expect(service.isToolAllowed('write-file', { toolPolicy: 'allow-read-only' })).toBe(false);
      expect(service.isToolAllowed('delete-file', { toolPolicy: 'allow-read-only' })).toBe(false);
    });

    it('allow-all 放行非危险工具，deny-all 全拒，未知策略拒绝', () => {
      expect(service.isToolAllowed('write-file', { toolPolicy: 'allow-all' })).toBe(true);
      expect(service.isToolAllowed('read', { toolPolicy: 'deny-all' })).toBe(false);
      expect(service.isToolAllowed('read', { toolPolicy: 'weird' as never })).toBe(false);
    });

    it('getToolPolicy 未知沙箱返回 null', () => {
      expect(service.getToolPolicy('nope')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // FS 桥接
  // ------------------------------------------------------------------
  describe('FS 桥接', () => {
    let sourceDir: string;
    let targetDir: string;

    beforeEach(() => {
      sourceDir = mkdtempSync(join(tmpdir(), 'fsbridge-src-'));
      targetDir = mkdtempSync(join(tmpdir(), 'fsbridge-dst-'));
    });

    it('默认值：sourceDir=cwd，readOnly=true，无 targetDir 时 sync 报错', () => {
      const bridge = service.createFsBridge();
      expect(bridge.type).toBe('fs');
      expect(bridge.sourceDir).toBe(process.cwd());
      expect(bridge.readOnly).toBe(true);
      expect(bridge.sync('a.txt')).toEqual({ success: false, error: 'No target directory configured' });
    });

    it('readOnly=false 显式生效', () => {
      const bridge = service.createFsBridge({ sourceDir, targetDir, readOnly: false });
      expect(bridge.readOnly).toBe(false);
    });

    it('sync 空路径拒绝，路径穿越拒绝（M11）', () => {
      const bridge = service.createFsBridge({ sourceDir, targetDir });
      expect(bridge.sync('')).toEqual({ success: false, error: 'No file path specified' });
      const trav = bridge.sync(join('..', 'escape.txt'));
      expect(trav.success).toBe(false);
      expect(trav.error).toBe('Path traversal detected');
    });

    it('sync 成功复制文件并记录元数据，目标子目录自动创建', () => {
      mkdirSync(join(sourceDir, 'sub'));
      writeFileSync(join(sourceDir, 'sub', 'a.txt'), 'payload');
      const bridge = service.createFsBridge({ sourceDir, targetDir });
      const r = bridge.sync(join('sub', 'a.txt'));
      expect(r.success).toBe(true);
      expect(readFileSync(join(targetDir, 'sub', 'a.txt'), 'utf8')).toBe('payload');
      const synced = bridge.getSyncedFiles();
      expect(synced[join('sub', 'a.txt')]).toMatchObject({ size: 7 });
      // getSyncedFiles 返回副本
      delete synced[join('sub', 'a.txt')];
      expect(bridge.getSyncedFiles()[join('sub', 'a.txt')]).toBeTruthy();
    });

    it('sync 源文件缺失返回错误', () => {
      const bridge = service.createFsBridge({ sourceDir, targetDir });
      const r = bridge.sync('missing.txt');
      expect(r.success).toBe(false);
      expect(typeof r.error).toBe('string');
    });

    it('syncDir 遍历目录复制根级文件', () => {
      writeFileSync(join(sourceDir, 'f1.txt'), '1');
      writeFileSync(join(sourceDir, 'f2.txt'), '2');
      mkdirSync(join(sourceDir, 'nested'));
      const bridge = service.createFsBridge({ sourceDir, targetDir });
      const r = bridge.syncDir('.');
      expect(r.success).toBe(true);
      expect(r.count).toBe(2);
      expect(existsSync(join(targetDir, 'f1.txt'))).toBe(true);
    });

    it('syncDir 路径穿越拒绝，目录不存在报错', () => {
      const bridge = service.createFsBridge({ sourceDir, targetDir });
      const trav = bridge.syncDir(join('..'));
      expect(trav).toEqual({ success: false, error: 'Path traversal detected' });
      const missing = bridge.syncDir('no-such-dir');
      expect(missing.success).toBe(false);
      expect(typeof missing.error).toBe('string');
    });
  });

  describe('resolveSandboxConfigForAgent', () => {
    it('返回默认 docker 沙箱配置', () => {
      expect(service.resolveSandboxConfigForAgent('agent-1')).toEqual({
        agentId: 'agent-1',
        type: 'docker',
        image: 'alpine:latest',
        memory: '256m',
        cpus: 0.5,
        timeout: 15000,
        network: 'none',
        toolPolicy: 'allow-read-only',
      });
    });
  });

  // ------------------------------------------------------------------
  // DM 配对
  // ------------------------------------------------------------------
  describe('DM 配对', () => {
    it('生成 6 位配对码并成功配对（仅存哈希 L-B11）', () => {
      const { code, expiresAt } = service.generatePairingCode('alice');
      expect(code).toMatch(/^\d{6}$/);
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(service.validatePairingCode(code, 'alice')).toBe(true);
      expect(service.isPaired('alice')).toBe(true);
      const devices = service.listPairedDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].deviceInfo.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(devices[0].deviceInfo.codeHash).not.toContain(code);
      // 配对码一次性使用
      expect(service.validatePairingCode(code, 'alice')).toBe(false);
    });

    it('空参数 / 无效码 / 过期码 / senderId 不匹配（H-B5）全部拒绝', () => {
      expect(service.validatePairingCode('', 'x')).toBe(false);
      expect(service.validatePairingCode('123456', '')).toBe(false);
      expect(service.validatePairingCode('000000', 'x')).toBe(false);
      const expired = service.generatePairingCode('bob', { expiresIn: -1000 });
      expect(service.validatePairingCode(expired.code, 'bob')).toBe(false);
      const bound = service.generatePairingCode('carol', { channel: 'dm' });
      expect(service.validatePairingCode(bound.code, 'mallory')).toBe(false);
    });

    it('unpair / revokeDevice', () => {
      const { code } = service.generatePairingCode('dave');
      service.validatePairingCode(code, 'dave');
      expect(service.unpair('dave')).toBe(true);
      expect(service.unpair('dave')).toBe(false);
      const { code: c2 } = service.generatePairingCode('erin');
      service.validatePairingCode(c2, 'erin');
      expect(service.revokeDevice('erin')).toBe(true);
      expect(service.revokeDevice('erin')).toBe(false);
      expect(service.isPaired('erin')).toBe(false);
    });

    it('配对状态跨实例持久化，损坏文件回退默认', () => {
      const { code } = service.generatePairingCode('persistent');
      service.validatePairingCode(code, 'persistent');
      const reborn = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
      reborn.init();
      expect(reborn.isPaired('persistent')).toBe(true);
      reborn.onModuleDestroy();

      writeFileSync(join(dataDir, 'security', 'paired-devices.json'), '{corrupt json');
      const broken = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
      expect(() => broken.init()).not.toThrow();
      expect(broken.isPaired('persistent')).toBe(false);
      broken.onModuleDestroy();
    });
  });

  // ------------------------------------------------------------------
  // 执行审批
  // ------------------------------------------------------------------
  describe('审批级别分类 classifyApprovalLevel', () => {
    it('空工具名拒绝', () => {
      expect(service.classifyApprovalLevel('')).toBe('deny');
    });

    it('只读/状态类工具自动批准', () => {
      expect(service.classifyApprovalLevel('file_read')).toBe('auto');
      expect(service.classifyApprovalLevel('web-search')).toBe('auto');
      expect(service.classifyApprovalLevel('healthcheck')).toBe('auto');
      expect(service.classifyApprovalLevel('status')).toBe('auto');
    });

    it('危险命令始终拒绝（含归一化变体 M-B10）', () => {
      expect(service.classifyApprovalLevel('exec', 'rm -rf /')).toBe('deny');
      expect(service.classifyApprovalLevel('exec', 'rm  -rf   /')).toBe('deny'); // 多空格
      expect(service.classifyApprovalLevel('exec', 'rm -fr /')).toBe('deny'); // flag 颠倒
      expect(service.classifyApprovalLevel('exec', { cmd: 'shutdown now' })).toBe('deny');
      expect(service.classifyApprovalLevel('run', 'dd if=/dev/zero of=/dev/sda')).toBe('deny');
      expect(service.classifyApprovalLevel('mkfs', 'format c:')).toBe('deny');
    });

    it('写操作/网络/包管理类工具需确认', () => {
      expect(service.classifyApprovalLevel('file_write')).toBe('ask');
      expect(service.classifyApprovalLevel('edit')).toBe('ask');
      expect(service.classifyApprovalLevel('shell_exec')).toBe('ask');
      expect(service.classifyApprovalLevel('npm_install')).toBe('ask');
      expect(service.classifyApprovalLevel('docker')).toBe('ask');
      expect(service.classifyApprovalLevel('ssh')).toBe('ask');
      expect(service.classifyApprovalLevel('curl_get')).toBe('ask');
    });

    it('未知工具默认 ask', () => {
      expect(service.classifyApprovalLevel('mystery_tool')).toBe('ask');
    });

    it('minSecurity / maxAsk 级别数值', () => {
      expect(service.minSecurity('auto')).toBe(0);
      expect(service.minSecurity('ask')).toBe(1);
      expect(service.minSecurity('deny')).toBe(2);
      expect(service.maxAsk('auto')).toBe(0);
      expect(service.maxAsk('deny')).toBe(2);
    });
  });

  describe('审批请求与响应', () => {
    it('auto 工具自动批准，deny 工具直接拒绝', () => {
      expect(service.requestApproval('read', { p: 1 })).toMatchObject({
        approvalId: null,
        status: 'auto-approved',
        level: 'auto',
      });
      expect(service.requestApproval('exec', 'rm -rf /')).toMatchObject({
        approvalId: null,
        status: 'denied',
        level: 'deny',
        reason: 'Tool classified as always-deny',
      });
    });

    it('ask 工具进入 pending 并记录历史', () => {
      const r = service.requestApproval('file_write', { path: 'x' }, 'sess-1');
      expect(r.status).toBe('pending');
      expect(r.approvalId).toMatch(/^approval-/);
      expect(r.level).toBe('ask');
      expect(service.listPendingApprovals()).toHaveLength(1);
      expect(service.getApprovalHistory('sess-1')).toHaveLength(1);
      expect(service.getApprovalHistory()).toHaveLength(1);
      expect(service.getApprovalHistory('other')).toEqual([]);
    });

    it('allow-always 后同会话同工具不再提示（H-B6）', () => {
      const r1 = service.requestApproval('file_write', {}, 's9');
      expect(service.respondToApproval(r1.approvalId!, 'allow-always')).toEqual({
        success: true,
        status: 'approved-always',
      });
      const r2 = service.requestApproval('file_write', {}, 's9');
      expect(r2).toMatchObject({
        approvalId: null,
        status: 'auto-approved',
        reason: 'Tool approved as allow-always for this session',
      });
      // 其他会话不受影响
      expect(service.requestApproval('file_write', {}, 's10').status).toBe('pending');
      // deny 级别工具不受 allow-always 影响
      expect(service.requestApproval('exec', 'rm -rf /', 's9').status).toBe('denied');
    });

    it('allow-once 批准一次后从 pending 移除', () => {
      const r = service.requestApproval('file_write', {}, 's');
      expect(service.respondToApproval(r.approvalId!, 'allow-once')).toEqual({
        success: true,
        status: 'approved-once',
      });
      expect(service.listPendingApprovals()).toHaveLength(0);
    });

    it('deny 决策与无效决策', () => {
      const r = service.requestApproval('file_write', {}, 's');
      expect(service.respondToApproval(r.approvalId!, 'deny')).toEqual({ success: true, status: 'denied' });
      expect(service.respondToApproval('approval-none', 'allow-once')).toEqual({
        success: false,
        reason: 'Approval not found',
      });
      const r2 = service.requestApproval('file_write', {}, 's');
      expect(service.respondToApproval(r2.approvalId!, 'maybe' as never)).toEqual({
        success: false,
        reason: 'Invalid decision: maybe',
      });
    });

    it('历史每 session 上限 1000 条（M-B2）', () => {
      for (let i = 0; i < 1005; i++) {
        service.requestApproval('file_write', { i }, 'bulk');
      }
      expect(service.getApprovalHistory('bulk')).toHaveLength(1000);
    });

    it('定时清理过期审批与配对码（M-B1/M-B3）', () => {
      let svc: SecurityManagerService | null = null;
      try {
        jest.useFakeTimers();
        svc = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
        svc.init();
        const r = svc.requestApproval('file_write', {}, 'ttl-sess');
        expect(svc.listPendingApprovals()).toHaveLength(1);
        const pc = svc.generatePairingCode('dev-ttl', { expiresIn: 60 * 1000 });
        // interval 触发点为 5/10/15 分钟；10 分钟时差值恰好等于 TTL（严格大于不成立），
        // 需推进到 15 分钟以上的触发点才会清理过期审批
        jest.advanceTimersByTime(16 * 60 * 1000);
        expect(svc.listPendingApprovals()).toHaveLength(0);
        expect(svc.validatePairingCode(pc.code, 'dev-ttl')).toBe(false);
        expect(r.approvalId).toBeTruthy();
      } finally {
        // 先在 fake timers 下清理 interval，再恢复真实 timers
        svc?.onModuleDestroy();
        jest.useRealTimers();
      }
    });
  });

  // ------------------------------------------------------------------
  // 安全正则
  // ------------------------------------------------------------------
  describe('安全正则 compileSafeRegex', () => {
    it('非法 pattern 抛异常', () => {
      expect(() => service.compileSafeRegex('')).toThrow('Invalid regex pattern');
      expect(() => service.compileSafeRegex(null as never)).toThrow('Invalid regex pattern');
    });

    it('嵌套量词拒绝（ReDoS 防护，第八轮已修复真危险形态）', () => {
      // 经典灾难性回溯形态：被量词修饰的分组内含可变长量词 → 拦截
      expect(() => service.compileSafeRegex('(a+)+')).toThrow(/nested quantifiers/);
      expect(() => service.compileSafeRegex('(a*)*')).toThrow(/nested quantifiers/);
      expect(() => service.compileSafeRegex('(a{2,3})+')).toThrow(/nested quantifiers/);
      expect(() => service.compileSafeRegex('(a?)+')).toThrow(/nested quantifiers/);
      expect(() => service.compileSafeRegex('((a+)b)+')).toThrow(/nested quantifiers/); // 嵌套冒泡
      // 安全形态不误报：分组重复但内容定长 / 量词不在被量词修饰的分组内
      expect(() => service.compileSafeRegex('(ab)+')).not.toThrow();
      expect(() => service.compileSafeRegex('(a|b)+')).not.toThrow();
      expect(() => service.compileSafeRegex('(a+)(b)')).not.toThrow();
      expect(() => service.compileSafeRegex('[a+(]+')).not.toThrow(); // 字符类内字面量
      // 第九轮修复：非捕获/断言/命名分组前缀的 '?' 不是量词，不得误拦
      expect(() => service.compileSafeRegex('(?:abc)?')).not.toThrow();
      expect(() => service.compileSafeRegex('(?:abc)+')).not.toThrow();
      expect(() => service.compileSafeRegex('(?<year>\\d{4})?')).not.toThrow();
      expect(() => service.compileSafeRegex('(?:https?|ftp)://')).not.toThrow();
      // 第九轮修复：长数字量词窗口漏识别（12 字符截断）
      expect(() => service.compileSafeRegex('(\\d{1,999999999999})+')).toThrow(/nested quantifiers/);
      // (a++) 等字面形态本身是 JS 正则语法错误，由 new RegExp 兜底（消息为 Invalid regex）
      expect(() => service.compileSafeRegex('(a++)')).toThrow(/Invalid regex/);
    });

    it('嵌套深度超过 3 拒绝', () => {
      expect(() => service.compileSafeRegex('(((a)))')).not.toThrow();
      expect(() => service.compileSafeRegex('((((a))))')).toThrow(/star height \(4\)/);
    });

    it('模式长度超过 10000 拒绝', () => {
      expect(() => service.compileSafeRegex('a'.repeat(10001))).toThrow(/too long/);
    });

    it('语法错误包装为 Invalid regex pattern', () => {
      expect(() => service.compileSafeRegex('(unclosed')).toThrow(/^Invalid regex pattern:/);
    });

    it('缓存命中返回同一实例（M-B4 LRU）', () => {
      const r1 = service.compileSafeRegex('abc', 'i');
      const r2 = service.compileSafeRegex('abc', 'i');
      expect(r1).toBe(r2);
    });

    it('缓存超过 100 条淘汰最旧', () => {
      const first = service.compileSafeRegex('first-pattern-x');
      for (let i = 0; i < 100; i++) {
        service.compileSafeRegex(`p-${i}-distinct`);
      }
      const again = service.compileSafeRegex('first-pattern-x');
      expect(again).not.toBe(first); // 已被淘汰后重新编译
      expect(again.source).toBe('first-pattern-x');
    });
  });

  describe('testRegexWithBoundedInput', () => {
    it('非 RegExp 对象抛异常，空输入返回未匹配', () => {
      expect(() => service.testRegexWithBoundedInput(null as never, 'x')).toThrow('Invalid regex object');
      expect(service.testRegexWithBoundedInput(/a/, '')).toEqual({ match: false, timedOut: false });
    });

    it('常规匹配返回结果与耗时', () => {
      const r = service.testRegexWithBoundedInput(/hello/, 'say hello world');
      expect(r.match).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(typeof r.elapsedMs).toBe('number');
      expect(service.testRegexWithBoundedInput(/zzz/, 'abc').match).toBe(false);
    });

    it('test 抛异常时返回 error', () => {
      class ThrowingRegex extends RegExp {
        override test(_s: string): boolean {
          throw new Error('regex boom');
        }
      }
      const r = service.testRegexWithBoundedInput(new ThrowingRegex('a') as RegExp, 'abc');
      expect(r.match).toBe(false);
      expect(r.error).toBe('regex boom');
    });

    it('灾难性回溯超时被标记（输入限长 100000）', () => {
      const input = 'a'.repeat(26) + 'c';
      const r = service.testRegexWithBoundedInput(/(a+)+b/, input, 50);
      expect(r.match).toBe(false);
      expect(r.timedOut).toBe(true);
      expect(r.elapsedMs).toBeGreaterThan(50);
    }, 30000);
  });

  // ------------------------------------------------------------------
  // 安全审计
  // ------------------------------------------------------------------
  describe('安全审计', () => {
    it('runAudit 基线：无发现时报告显示 No security findings', () => {
      const findings = service.runAudit();
      expect(Array.isArray(findings)).toBe(true);
      const report = service.getAuditReport();
      expect(report).toContain('=== Security Audit Report ===');
      expect(report).toContain(`Total Findings: ${findings.length}`);
      if (findings.length === 0) expect(report).toContain('No security findings.');
      expect(service.listFindings()).toEqual(findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        area: f.area,
        description: f.description,
        fixable: f.fixable,
      })));
    });

    it('检测环境变量中的密钥（低危）', () => {
      process.env['SKYALYTICWING_TEST_SECRET'] = 'super-secret';
      try {
        const findings = service.runAudit();
        const found = findings.find((f) => f.area === 'api-key-exposure' && f.description.includes('SKYALYTICWING_TEST_SECRET'));
        expect(found).toMatchObject({ severity: 'low', fixable: false });
        const report = service.getAuditReport();
        expect(report).toContain('SKYALYTICWING_TEST_SECRET');
      } finally {
        delete process.env['SKYALYTICWING_TEST_SECRET'];
      }
    });

    it('dangerouslyAllowPrivateNetwork → critical 且可修复', () => {
      (ssrfGuard.getConfig as jest.Mock).mockReturnValue({
        ...defaultSsrfConfig(),
        dangerouslyAllowPrivateNetwork: true,
      });
      const findings = service.runAudit();
      const f = findings.find((x) => x.description.includes('dangerouslyAllowPrivateNetwork'));
      expect(f).toMatchObject({ severity: 'critical', fixable: true });
      const res = service.fixFinding(f!.id);
      expect(res).toEqual({ success: true });
      expect(ssrfGuard.setConfig).toHaveBeenCalledWith({ dangerouslyAllowPrivateNetwork: false });
      expect(service.listFindings().some((x) => x.id === f!.id)).toBe(false);
    });

    it('host 网络沙箱（不可修复）与 allow-all 工具策略（可修复）', () => {
      service.createDockerSandbox({ network: 'host' });
      const sid = service.createDockerSandbox({ toolPolicy: 'allow-all' });
      const findings = service.runAudit();
      const host = findings.find((x) => x.description.includes('host networking'));
      expect(host).toMatchObject({ severity: 'high', fixable: false });
      const policy = findings.find((x) => x.description.includes('allows all tools'));
      expect(policy).toMatchObject({ severity: 'high', fixable: true });
      expect(service.fixFinding(host!.id)).toEqual({ success: false, reason: 'Finding is not auto-fixable' });
      expect(service.fixFinding(policy!.id)).toEqual({ success: true });
      expect(service.getToolPolicy(sid)).toBe('allow-read-only');
    });

    it('通配符 allow 命令规则 → critical 且可修复', () => {
      (commandGuard.listCommandRules as jest.Mock).mockReturnValue([
        { id: 'rule-wild', type: 'allow', command: '*', reason: '' },
      ]);
      const findings = service.runAudit();
      const f = findings.find((x) => x.area === 'command-rules');
      expect(f).toMatchObject({ severity: 'critical', fixable: true });
      expect(service.fixFinding(f!.id)).toEqual({ success: true });
      expect(commandGuard.removeCommandRule).toHaveBeenCalledWith('rule-wild');
    });

    it('fixFinding 异常路径：未找到 / fixFn 返回 false / fixFn 抛异常', () => {
      (commandGuard.listCommandRules as jest.Mock).mockReturnValue([
        { id: 'rule-wild', type: 'allow', command: '*', reason: '' },
      ]);
      expect(service.fixFinding('audit-999')).toEqual({ success: false, reason: 'Finding not found: audit-999' });

      (commandGuard.removeCommandRule as jest.Mock).mockReturnValue(false);
      service.runAudit();
      const f = service.runAudit().find((x) => x.area === 'command-rules');
      expect(service.fixFinding(f!.id)).toEqual({ success: false, reason: 'Fix function returned false' });

      (commandGuard.removeCommandRule as jest.Mock).mockImplementation(() => {
        throw new Error('remove failed');
      });
      service.runAudit();
      const f2 = service.runAudit().find((x) => x.area === 'command-rules');
      expect(service.fixFinding(f2!.id)).toEqual({ success: false, reason: 'Fix failed: remove failed' });
    });

    it('白名单主机/Origin 过多 → medium 发现', () => {
      (ssrfGuard.getConfig as jest.Mock).mockReturnValue({
        ...defaultSsrfConfig(),
        allowedHostnames: Array.from({ length: 12 }, (_, i) => `h${i}.example.com`),
        allowedOrigins: Array.from({ length: 12 }, (_, i) => `https://o${i}.example.com`),
      });
      const findings = service.runAudit();
      expect(findings.find((f) => f.area === 'network-access' && f.description.includes('allowed hostnames'))).toMatchObject({ severity: 'medium' });
      expect(findings.find((f) => f.area === 'network-access' && f.description.includes('allowed origins'))).toMatchObject({ severity: 'medium' });
    });

    it('fixAllFindings 汇总成功与不可修复项', () => {
      (ssrfGuard.getConfig as jest.Mock).mockReturnValue({
        ...defaultSsrfConfig(),
        dangerouslyAllowPrivateNetwork: true,
      });
      service.createDockerSandbox({ network: 'host' });
      service.runAudit();
      const results = service.fixAllFindings();
      expect(results.some((r) => r.success)).toBe(true);
      expect(results.some((r) => !r.success && r.reason === 'Not auto-fixable')).toBe(true);
      // 可修复项已从列表移除
      expect(service.listFindings().some((f) => f.fixable)).toBe(false);
    });

    it('fixAllFindings 中 fixFn 抛异常被捕获', () => {
      (commandGuard.listCommandRules as jest.Mock).mockReturnValue([
        { id: 'rule-wild', type: 'allow', command: '*', reason: '' },
      ]);
      (commandGuard.removeCommandRule as jest.Mock).mockImplementation(() => {
        throw new Error('boom');
      });
      service.runAudit();
      const results = service.fixAllFindings();
      expect(results.some((r) => !r.success && r.reason === 'boom')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 危险配置扫描
  // ------------------------------------------------------------------
  describe('scanConfig 危险配置扫描', () => {
    it('空/非对象配置返回空数组', () => {
      expect(service.scanConfig(null as never)).toEqual([]);
      expect(service.scanConfig('str' as never)).toEqual([]);
      expect(service.getDangerousFlags()).toEqual([]);
    });

    it('识别危险开关键（值为 false 时忽略）', () => {
      const flags = service.scanConfig({
        dangerouslyAllowPrivateNetwork: true,
        dangerouslyDisableSandbox: true,
        dangerouslyAllowHttp: 1,
        dangerouslySkipTlsVerify: 'yes',
        dangerouslyDisableAuth: false,
      });
      const keys = flags.map((f) => f.key);
      expect(keys).toContain('dangerouslyAllowPrivateNetwork');
      expect(keys).toContain('dangerouslyDisableSandbox');
      expect(keys).toContain('dangerouslyAllowHttp');
      expect(keys).toContain('dangerouslySkipTlsVerify');
      expect(keys).not.toContain('dangerouslyDisableAuth');
      expect(flags.find((f) => f.key === 'dangerouslyAllowPrivateNetwork')).toMatchObject({ severity: 'critical' });
      expect(service.getDangerousFlags()).toHaveLength(flags.length);
      // getDangerousFlags 返回副本
      const copy = service.getDangerousFlags();
      copy.pop();
      expect(service.getDangerousFlags()).toHaveLength(flags.length);
    });

    it('递归扫描嵌套对象并去重（C-F2）', () => {
      const flags = service.scanConfig({
        outer: 1,
        db: { dangerouslyExposeEnv: true },
        deep: { deeper: { dangerouslyAllowRoot: true } },
      });
      const keys = flags.map((f) => f.key).sort();
      expect(keys).toEqual(['dangerouslyAllowRoot', 'dangerouslyExposeEnv']);
    });

    it('安全配置无发现', () => {
      expect(service.scanConfig({ port: 3000, nested: { ok: true } })).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // 通用输入校验补充
  // ------------------------------------------------------------------
  describe('validateNumeric 边界补充', () => {
    it('NaN / Infinity 数字拒绝', () => {
      expect(() => service.validateNumeric(NaN, 0, 10)).toThrow(/Invalid numeric value/);
      expect(() => service.validateNumeric(Infinity, 0, 10)).toThrow(/Invalid numeric value/);
      expect(() => service.validateNumeric('Infinity', 0, 10)).toThrow(/Invalid numeric value/);
    });
  });
});
