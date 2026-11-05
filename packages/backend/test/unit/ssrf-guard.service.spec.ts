import 'reflect-metadata';
import { SsrfGuardService } from '../../src/modules/core/security/ssrf-guard.service.js';
import type { ConfigService } from '../../src/modules/core/config/config.service.js';

// mock DNS 解析，避免测试依赖真实网络
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';

const configMock = {
  get: (_section: string) => ({}),
} as unknown as ConfigService;

const mockedLookup = dnsLookup as unknown as jest.Mock;

describe('SsrfGuardService', () => {
  let service: SsrfGuardService;

  beforeEach(() => {
    mockedLookup.mockReset();
    service = new SsrfGuardService(configMock);
    service.onModuleInit();
  });

  describe('checkUrl - 私有 IP 拒绝', () => {
    it.each([
      '127.0.0.1', // loopback
      '127.1.2.3', // 127/8
      '10.0.0.1', // 10/8
      '10.255.255.255',
      '172.16.0.1', // 172.16/12 起始
      '172.31.255.254', // 172.16/12 结束
      '192.168.1.100', // 192.168/16
      '169.254.1.1', // link-local
      '0.0.0.0', // 本网络
    ])('私有 IP %s 被拒绝', async (ip) => {
      const result = await service.checkUrl(`http://${ip}/`);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/Private IP/i);
    });

    it('云元数据端点 169.254.169.254 被拒绝', async () => {
      const result = await service.checkUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/metadata/i);
    });

    it('IPv4-mapped IPv6 (::ffff:127.0.0.1) 被拒绝', async () => {
      const result = await service.checkUrl('http://[::ffff:127.0.0.1]/');
      // jsdom/undici 无关：URL 解析 hostname 为 [::ffff:127.0.0.1] 时由 DNS 分支或 IP 分支处理
      expect(result.safe).toBe(false);
    });
  });

  describe('checkUrl - 公网通过', () => {
    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34'])('公网 IP %s 通过', async (ip) => {
      const result = await service.checkUrl(`http://${ip}/`);
      expect(result.safe).toBe(true);
      expect(result.reason).toMatch(/Public IP/i);
    });
  });

  describe('checkUrl - 协议检查', () => {
    it.each(['ftp', 'file', 'gopher', 'javascript'])('非 http(s) 协议 %s 被拒绝', async (proto) => {
      const result = await service.checkUrl(`${proto}://example.com/`);
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/protocol/i);
    });

    it('畸形 URL 拒绝', async () => {
      const result = await service.checkUrl('not-a-valid-url');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/Malformed/i);
    });

    it('空 URL 拒绝', async () => {
      const result = await service.checkUrl('');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/Invalid/i);
    });
  });

  describe('checkUrl - 域名 DNS 解析校验', () => {
    it('域名解析到私有 IP 被拒绝（fail-close）', async () => {
      mockedLookup.mockResolvedValue([{ address: '10.0.0.99', family: 4 }]);
      const result = await service.checkUrl('http://internal.corp.local/');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/resolves to private IP/i);
    });

    it('域名解析到云元数据 IP 被拒绝', async () => {
      mockedLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      const result = await service.checkUrl('http://metadata.attacker.com/');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/metadata/i);
    });

    it('域名解析到公网 IP 通过', async () => {
      mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const result = await service.checkUrl('http://example.com/');
      expect(result.safe).toBe(true);
    });

    it('DNS 解析失败被拒绝（fail-close）', async () => {
      mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
      const result = await service.checkUrl('http://nonexistent.invalid/');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/DNS/i);
    });

    it('dangerouslyAllowPrivateNetwork 开关放行私有 IP（危险覆盖）', async () => {
      service.setConfig({ dangerouslyAllowPrivateNetwork: true });
      const result = await service.checkUrl('http://10.0.0.1/');
      expect(result.safe).toBe(true);
      expect(result.reason).toMatch(/dangerous override/i);
      service.setConfig({ dangerouslyAllowPrivateNetwork: false });
    });
  });

  describe('主机名白名单', () => {
    it('通配符子域白名单放行', async () => {
      service.setConfig({ allowedHostnames: ['*.internal.example.com'] });
      const result = await service.checkUrl('http://api.internal.example.com/');
      expect(result.safe).toBe(true);
      expect(result.reason).toMatch(/allowlist/i);
    });

    it('白名单外的域名仍走 DNS 校验', async () => {
      service.setConfig({ allowedHostnames: ['*.internal.example.com'] });
      mockedLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
      const result = await service.checkUrl('http://evil.com/');
      expect(result.safe).toBe(false);
    });
  });

  describe('isPrivateIp', () => {
    it.each(['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'fd00::1', 'fc00::1', '::', '::ffff:127.0.0.1', '::169.254.169.254'])(
      '私有/保留地址: %s',
      (ip) => {
        expect(service.isPrivateIp(ip)).toBe(true);
      },
    );

    it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '2001:db8::1', '2606:4700::1'])(
      '公网地址: %s',
      (ip) => {
        expect(service.isPrivateIp(ip)).toBe(false);
      },
    );

    it('非 IP 输入返回 false', () => {
      expect(service.isPrivateIp('example.com')).toBe(false);
      expect(service.isPrivateIp('')).toBe(false);
    });
  });

  describe('isCloudMetadata', () => {
    it('169.254.169.254 为云元数据端点', () => {
      expect(service.isCloudMetadata('169.254.169.254')).toBe(true);
    });

    it('GCP IPv6 元数据端点', () => {
      expect(service.isCloudMetadata('fd00:ec2::254')).toBe(true);
    });

    it('普通 IP 非元数据端点', () => {
      expect(service.isCloudMetadata('8.8.8.8')).toBe(false);
      expect(service.isCloudMetadata('169.254.1.1')).toBe(false);
    });
  });

  describe('同步 check()', () => {
    it('localhost 被阻断', () => {
      expect(service.check('http://localhost:8080/')).toBe(false);
    });

    it('私有 IP 字面量被阻断', () => {
      expect(service.check('http://192.168.1.1/')).toBe(false);
    });

    it('公网 IP 通过', () => {
      expect(service.check('http://8.8.8.8/')).toBe(true);
    });

    it('非 http(s) 协议拒绝', () => {
      expect(service.check('ftp://example.com/')).toBe(false);
    });

    it('畸形 URL 拒绝', () => {
      expect(service.check('not-a-url')).toBe(false);
    });

    it('普通域名通过同步检查（DNS 留给异步）', () => {
      expect(service.check('http://example.com/some/path')).toBe(true);
    });

    it('Origin 白名单放行', () => {
      service.setConfig({ allowedOrigins: ['http://example.com'] });
      expect(service.check('http://example.com/x')).toBe(true);
      expect(service.check('http://other.com/')).toBe(true); // 普通域名放行
    });

    it('IPv6 字面量：公网通过，私有 IPv6 被同步 check() 拦截（第八轮已修复）', () => {
      expect(service.check('http://[2001:db8::1]/')).toBe(true);
      // 修复前：WHATWG URL 的 hostname 保留 IPv6 方括号（'[fc00::1]'），isIP() 判为非 IP、
      // 前缀检查失效，私有 IPv6 绕过同步 check()。现已剥除方括号后正确拦截。
      expect(service.check('http://[fc00::1]/')).toBe(false);
      expect(service.check('http://[::1]/')).toBe(false);
    });

    it('IPv4-mapped IPv6 十六进制形态（URL 规范化后）被拦截', async () => {
      // WHATWG URL 把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]（十六进制），
      // isPrivateIp 的点分正则匹配不到（M-B17b 修复）
      const r = await service.checkUrl('http://[::ffff:127.0.0.1]/');
      expect(r.safe).toBe(false);
    });

    it('checkAsync 返回布尔值', async () => {
      await expect(service.checkAsync('http://127.0.0.1/')).resolves.toBe(false);
      await expect(service.checkAsync('http://8.8.8.8/')).resolves.toBe(true);
    });
  });

  // =========================================================================
  // 补充：配置加载 / setConfig / getConfig / 白名单管理 / DNS 边界
  // =========================================================================
  describe('配置加载 loadConfigSsrf（onModuleInit）', () => {
    const makeConfig = (ssrf: unknown, throwOnGet = false) =>
      ({
        get: (_section: string) => {
          if (throwOnGet) throw new Error('config unavailable');
          return { ssrf };
        },
      }) as unknown as ConfigService;

    it('从 security.ssrf 段加载完整配置', () => {
      const svc = new SsrfGuardService(makeConfig({
        allowPrivateNetwork: true,
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ['a.example.com', 'b.example.com'],
        allowedOrigins: ['https://origin.example.com'],
      }));
      svc.onModuleInit();
      const cfg = svc.getConfig();
      expect(cfg.allowPrivateNetwork).toBe(true);
      expect(cfg.dangerouslyAllowPrivateNetwork).toBe(false);
      expect(cfg.allowedHostnames).toEqual(['a.example.com', 'b.example.com']);
      expect(cfg.allowedOrigins).toEqual(['https://origin.example.com']);
    });

    it('ssrf 段缺失 / 非对象 / 数组时保持安全默认值', () => {
      for (const bad of [undefined, null, 'str', 42, []]) {
        const svc = new SsrfGuardService(makeConfig(bad));
        expect(() => svc.onModuleInit()).not.toThrow();
        expect(svc.getConfig()).toEqual({
          allowPrivateNetwork: false,
          dangerouslyAllowPrivateNetwork: false,
          allowedHostnames: [],
          allowedOrigins: [],
        });
      }
    });

    it('allowedHostnames/allowedOrigins 仅保留字符串元素（空字符串保留）', () => {
      const svc = new SsrfGuardService(makeConfig({
        allowedHostnames: ['ok.example.com', 42, null],
        allowedOrigins: ['https://ok.example.com', {}, ''],
      }));
      svc.onModuleInit();
      const cfg = svc.getConfig();
      expect(cfg.allowedHostnames).toEqual(['ok.example.com']);
      // 过滤条件仅校验 typeof === 'string'，空字符串会被保留
      expect(cfg.allowedOrigins).toEqual(['https://ok.example.com', '']);
    });

    it('config.get 抛异常时静默保持默认（fail-safe）', () => {
      const svc = new SsrfGuardService(makeConfig(null, true));
      expect(() => svc.onModuleInit()).not.toThrow();
      expect(svc.getConfig().allowedHostnames).toEqual([]);
    });
  });

  describe('setConfig / getConfig', () => {
    it('部分更新：未提供的字段保持不变', () => {
      service.setConfig({ allowPrivateNetwork: true, allowedHostnames: ['x.example.com'] });
      service.setConfig({ allowedOrigins: ['https://y.example.com'] });
      const cfg = service.getConfig();
      expect(cfg.allowPrivateNetwork).toBe(true);
      expect(cfg.allowedHostnames).toEqual(['x.example.com']);
      expect(cfg.allowedOrigins).toEqual(['https://y.example.com']);
    });

    it('getConfig 返回副本，修改不影响内部状态', () => {
      service.setConfig({ allowedHostnames: ['h1.example.com'] });
      const cfg = service.getConfig();
      cfg.allowedHostnames.push('evil.example.com');
      cfg.allowedOrigins.push('https://evil.example.com');
      expect(service.getConfig().allowedHostnames).toEqual(['h1.example.com']);
      expect(service.getConfig().allowedOrigins).toEqual([]);
    });
  });

  describe('Origin 白名单（checkUrl）', () => {
    it('命中 Origin 白名单直接放行', async () => {
      service.setConfig({ allowedOrigins: ['http://example.com'] });
      const result = await service.checkUrl('http://example.com/some/path?q=1');
      expect(result.safe).toBe(true);
      expect(result.reason).toBe('Origin in allowlist');
    });

    it('Origin 不匹配（协议/端口不同）仍走后续校验', async () => {
      service.setConfig({ allowedOrigins: ['https://example.com'] });
      mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const result = await service.checkUrl('http://example.com/');
      expect(result.safe).toBe(true);
      expect(result.reason).not.toContain('allowlist');
    });
  });

  describe('DNS 解析校验（补充）', () => {
    it('解析记录为空数组视为失败（fail-close）', async () => {
      mockedLookup.mockResolvedValue([]);
      const result = await service.checkUrl('http://empty.records.local/');
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/DNS resolution failed/);
    });

    it('域名解析到私有 IP 时危险开关放行（异步分支）', async () => {
      service.setConfig({ dangerouslyAllowPrivateNetwork: true });
      mockedLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const result = await service.checkUrl('http://internal.example.com/');
      expect(result.safe).toBe(true);
      expect(result.reason).toMatch(/dangerous override/i);
      service.setConfig({ dangerouslyAllowPrivateNetwork: false });
    });

    it('内部校验抛异常时 fail-close 返回 URL check error', async () => {
      const spy = jest.spyOn(service, 'isPrivateIp').mockImplementation(() => {
        throw new Error('ip check crashed');
      });
      const result = await service.checkUrl('http://8.8.8.8/');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('URL check error');
      spy.mockRestore();
    });

    it('IPv6 域名解析：公网 IPv6 地址放行', async () => {
      mockedLookup.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);
      const result = await service.checkUrl('http://v6.example.com/');
      expect(result.safe).toBe(true);
      expect(result.reason).toContain('2606:4700:4700::1111');
    });
  });

  describe('白名单管理 addAllowedHostname / addAllowedOrigin', () => {
    it('addAllowedHostname 去重并忽略非法输入', () => {
      service.addAllowedHostname('foo.example.com');
      service.addAllowedHostname('FOO.EXAMPLE.COM'); // 大小写不敏感去重
      service.addAllowedHostname('foo.example.com');
      service.addAllowedHostname('');
      service.addAllowedHostname(null as never);
      expect(service.getConfig().allowedHostnames).toEqual(['foo.example.com']);
      expect(service.isAllowedHostname('foo.EXAMPLE.com')).toBe(true);
    });

    it('addAllowedOrigin 去重并忽略非法输入', () => {
      service.addAllowedOrigin('https://a.example.com');
      service.addAllowedOrigin('https://A.EXAMPLE.COM');
      service.addAllowedOrigin('');
      expect(service.getConfig().allowedOrigins).toEqual(['https://a.example.com']);
    });

    it('isAllowedHostname 空主机名返回 false', () => {
      expect(service.isAllowedHostname('')).toBe(false);
    });
  });

  describe('isCloudMetadata 边界', () => {
    it('非 IP 输入返回 false', () => {
      expect(service.isCloudMetadata('example.com')).toBe(false);
      expect(service.isCloudMetadata('')).toBe(false);
    });

    it('fe80::a9fe:a9fe 前缀（GCP IPv6 元数据）', () => {
      expect(service.isCloudMetadata('fe80::a9fe:a9fe')).toBe(true);
      expect(service.isCloudMetadata('fe80::a9fe:a9ff')).toBe(false);
    });
  });
});
