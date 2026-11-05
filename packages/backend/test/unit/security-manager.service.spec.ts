import 'reflect-metadata';
import * as childProcess from 'node:child_process';
import { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import type { PathGuardService } from '../../src/modules/core/security/path-guard.service.js';
import type { CommandGuardService } from '../../src/modules/core/security/command-guard.service.js';
import type { SsrfGuardService } from '../../src/modules/core/security/ssrf-guard.service.js';

/**
 * SecurityManagerService 门面层单元测试（设计点名 P0）：
 *   - mock 三个子 guard（PathGuard / CommandGuard / SsrfGuard）验证 facade 方法透传
 *   - isDockerAvailable 结果缓存（exec 只探测一次）
 *   - sanitize / validate 通用输入校验输出
 *
 * 内建模块导出不可 spyOn（Cannot redefine property），经 jest.mock 工厂替换 exec。
 */
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  exec: jest.fn(),
}));

const execMock = childProcess.exec as unknown as jest.Mock;

const makePathGuard = () =>
  ({
    isPathAllowed: jest.fn().mockReturnValue(true),
    addAllowedPath: jest.fn(),
    removeAllowedPath: jest.fn().mockReturnValue(true),
    listPathPolicies: jest.fn().mockReturnValue([
      { path: '/tmp/a', mode: 'read', addedAt: 1 },
    ]),
  }) as unknown as jest.Mocked<PathGuardService>;

const makeCommandGuard = () =>
  ({
    isCommandAllowed: jest.fn().mockReturnValue(true),
    addCommandRule: jest.fn().mockReturnValue('rule-1'),
    removeCommandRule: jest.fn().mockReturnValue(true),
    listCommandRules: jest.fn().mockReturnValue([
      { id: 'rule-1', type: 'deny', command: 'rm -rf', reason: 'danger' },
    ]),
  }) as unknown as jest.Mocked<CommandGuardService>;

const makeSsrfGuard = () =>
  ({
    checkUrl: jest.fn().mockResolvedValue({ safe: true, reason: '' }),
    check: jest.fn().mockReturnValue(true),
    getConfig: jest.fn().mockReturnValue({
      allowPrivateNetwork: false,
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: [],
      allowedOrigins: [],
    }),
    setConfig: jest.fn(),
  }) as unknown as jest.Mocked<SsrfGuardService>;

function makeService(overrides?: {
  pathGuard?: jest.Mocked<PathGuardService>;
  commandGuard?: jest.Mocked<CommandGuardService>;
  ssrfGuard?: jest.Mocked<SsrfGuardService>;
}): { service: SecurityManagerService; pathGuard: jest.Mocked<PathGuardService>; commandGuard: jest.Mocked<CommandGuardService>; ssrfGuard: jest.Mocked<SsrfGuardService> } {
  const pathGuard = overrides?.pathGuard ?? makePathGuard();
  const commandGuard = overrides?.commandGuard ?? makeCommandGuard();
  const ssrfGuard = overrides?.ssrfGuard ?? makeSsrfGuard();
  const service = new SecurityManagerService(pathGuard, commandGuard, ssrfGuard);
  return { service, pathGuard, commandGuard, ssrfGuard };
}

describe('SecurityManagerService 门面单元测试', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(
      (_cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
        return null as never;
      },
    );
  });

  describe('facade 方法透传 - PathGuard', () => {
    it('isPathAllowed / addAllowedPath / removeAllowedPath / listPathPolicies 透传子服务', () => {
      const { service, pathGuard } = makeService();

      expect(service.isPathAllowed('/data/x.txt', 'read')).toBe(true);
      expect(pathGuard.isPathAllowed).toHaveBeenCalledWith('/data/x.txt', 'read');

      service.addAllowedPath('/data/new', 'write');
      expect(pathGuard.addAllowedPath).toHaveBeenCalledWith('/data/new', 'write');

      expect(service.removeAllowedPath('/data/old')).toBe(true);
      expect(pathGuard.removeAllowedPath).toHaveBeenCalledWith('/data/old');

      const policies = service.listPathPolicies();
      expect(policies).toEqual([{ path: '/tmp/a', mode: 'read', addedAt: 1 }]);
      expect(pathGuard.listPathPolicies).toHaveBeenCalledTimes(1);
    });
  });

  describe('facade 方法透传 - CommandGuard', () => {
    it('isCommandAllowed / addCommandRule / removeCommandRule / listCommandRules 透传子服务', () => {
      const { service, commandGuard } = makeService();

      expect(service.isCommandAllowed('ls -la', 'user')).toBe(true);
      expect(commandGuard.isCommandAllowed).toHaveBeenCalledWith('ls -la', 'user');

      expect(service.addCommandRule('deny', 'shutdown', '危险')).toBe('rule-1');
      expect(commandGuard.addCommandRule).toHaveBeenCalledWith('deny', 'shutdown', '危险');

      expect(service.removeCommandRule('rule-1')).toBe(true);
      expect(commandGuard.removeCommandRule).toHaveBeenCalledWith('rule-1');

      expect(service.listCommandRules()).toEqual([
        { id: 'rule-1', type: 'deny', command: 'rm -rf', reason: 'danger' },
      ]);
    });
  });

  describe('facade 方法透传 - SsrfGuard', () => {
    it('checkUrl（异步）/ checkUrlSync（同步）透传子服务', async () => {
      const { service, ssrfGuard } = makeService();

      await expect(service.checkUrl('https://example.com')).resolves.toEqual({ safe: true, reason: '' });
      expect(ssrfGuard.checkUrl).toHaveBeenCalledWith('https://example.com');

      expect(service.checkUrlSync('https://example.com')).toBe(true);
      expect(ssrfGuard.check).toHaveBeenCalledWith('https://example.com');
    });

    it('getPathGuard / getCommandGuard / getSsrfGuard 暴露原子服务实例', () => {
      const { service, pathGuard, commandGuard, ssrfGuard } = makeService();
      expect(service.getPathGuard()).toBe(pathGuard);
      expect(service.getCommandGuard()).toBe(commandGuard);
      expect(service.getSsrfGuard()).toBe(ssrfGuard);
    });
  });

  describe('isDockerAvailable 缓存', () => {
    it('首次探测后缓存结果，后续调用不再 exec', async () => {
      const { service } = makeService();

      await expect(service.isDockerAvailable()).resolves.toBe(true);
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toBe('docker info');

      await expect(service.isDockerAvailable()).resolves.toBe(true);
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('exec 返回错误时缓存 false（fail-close）', async () => {
      execMock.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (err: Error | null) => void) => {
          cb(new Error('docker not installed'));
          return null as never;
        },
      );
      const { service } = makeService();

      await expect(service.isDockerAvailable()).resolves.toBe(false);
      expect(execMock).toHaveBeenCalledTimes(1);

      // 缓存 false，第二次不再探测
      await expect(service.isDockerAvailable()).resolves.toBe(false);
      expect(execMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('sanitize / validate 通用输入校验', () => {
    it('sanitizeHtml 转义五种危险字符', () => {
      const { service } = makeService();
      expect(service.sanitizeHtml('<script>alert("x\'y")</script>&')).toBe(
        '&lt;script&gt;alert(&quot;x&#39;y&quot;)&lt;/script&gt;&amp;',
      );
      expect(service.sanitizeHtml('')).toBe('');
    });

    it('validateNumeric 接受 number/string 并限制范围', () => {
      const { service } = makeService();
      expect(service.validateNumeric(42, 0, 100)).toBe(42);
      expect(service.validateNumeric('7', 0, 100)).toBe(7);
      expect(() => service.validateNumeric(101, 0, 100)).toThrow(/exceeds maximum/);
      expect(() => service.validateNumeric(-1, 0, 100)).toThrow(/below minimum/);
      expect(() => service.validateNumeric('NaN', 0, 100)).toThrow(/Invalid numeric value/);
      expect(() => service.validateNumeric(true, 0, 100)).toThrow(/Invalid numeric value/);
    });

    it('validateString 校验类型与最大长度', () => {
      const { service } = makeService();
      expect(service.validateString('abc', 5)).toBe('abc');
      expect(() => service.validateString('abcdef', 5)).toThrow(/exceeds maximum/);
      expect(() => service.validateString(123, 5)).toThrow(/Expected string/);
    });
  });
});
