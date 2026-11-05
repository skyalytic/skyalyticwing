import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import { ConfigService } from '../config/config.service.js';

/** URL 检查结果 */
export interface UrlCheckResult {
  safe: boolean;
  reason: string;
}

/** SSRF 配置 */
export interface SsrfConfig {
  allowPrivateNetwork: boolean;
  dangerouslyAllowPrivateNetwork: boolean;
  allowedHostnames: string[];
  allowedOrigins: string[];
}

/**
 * SsrfGuardService - SSRF 防护（全量移植自 security-manager.cjs 第1节）
 *
 * 防护能力：
 *   1. 协议白名单（仅 http/https）
 *   2. 主机名白名单（支持通配符子域 *.example.com）
 *   3. Origin 白名单
 *   4. 私有 IP 段阻断：
 *      - IPv4: 10/8, 172.16-31, 192.168/16, 127/8, 169.254/16, 0/8, 224-239（组播）, 255.255.255.255（广播）
 *      - IPv6: fc00::/7（ULA）, fe80::/10（链路本地）, ::1（环回）, ::（未指定）
 *      - IPv4-mapped IPv6: ::ffff:x.x.x.x → 归一化为 IPv4 后判断
 *      - IPv4-compat: ::x.x.x.x → 归一化为 IPv4 后判断
 *   5. 云元数据端点阻断：
 *      - AWS/GCP/Azure: 169.254.169.254
 *      - GCP IPv6: fd00:ec2::254, fe80::a9fe:a9fe
 *   6. DNS 解析校验：域名解析后检查 IP 是否为内网/元数据
 *   7. 危险覆盖开关：dangerouslyAllowPrivateNetwork
 *
 * 安全特性：
 *   - M-B17: IPv4-mapped IPv6 地址归一化后再判断
 *   - L-B1: 完善 IPv6 loopback 检测（::1, ::ffff:127.0.0.1）
 *   - L-B2: 0.0.0.0/8 整个段屏蔽
 *   - H-B8: fe80::/10 完整覆盖 fe80::-febf::
 *   - M-B15: 仅校验目标 hostname/IP，不预判重定向（由 HTTP 客户端层每跳校验）
 */
@Injectable()
export class SsrfGuardService implements OnModuleInit {
  private readonly logger = new Logger(SsrfGuardService.name);

  /** SSRF 配置 */
  private ssrfConfig: SsrfConfig = {
    allowPrivateNetwork: false,
    dangerouslyAllowPrivateNetwork: false,
    allowedHostnames: [],
    allowedOrigins: [],
  };

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.loadConfigSsrf();
  }

  /**
   * 从 ConfigService 读取 SSRF 配置（security.ssrf 段）
   * 全量对应 .cjs init(options) 中 opts.ssrf 的初始化逻辑：
   *   - allowPrivateNetwork / dangerouslyAllowPrivateNetwork 缺省为 false
   *   - allowedHostnames / allowedOrigins 仅当为数组时覆盖
   * 配置段缺失时不影响初始化，保持安全默认值。
   */
  private loadConfigSsrf(): void {
    try {
      const security = this.config.get<Record<string, unknown>>('security');
      const ssrf = security['ssrf'];
      if (!ssrf || typeof ssrf !== 'object' || Array.isArray(ssrf)) return;
      const s = ssrf as Record<string, unknown>;
      const patch: Partial<SsrfConfig> = {
        allowPrivateNetwork: !!s['allowPrivateNetwork'],
        dangerouslyAllowPrivateNetwork: !!s['dangerouslyAllowPrivateNetwork'],
      };
      if (Array.isArray(s['allowedHostnames'])) {
        patch.allowedHostnames = (s['allowedHostnames'] as unknown[]).filter(
          (h): h is string => typeof h === 'string',
        );
      }
      if (Array.isArray(s['allowedOrigins'])) {
        patch.allowedOrigins = (s['allowedOrigins'] as unknown[]).filter(
          (o): o is string => typeof o === 'string',
        );
      }
      this.setConfig(patch);
      this.logger.log('已从配置加载 SSRF 配置');
    } catch {
      // security 段缺失或读取失败时不影响初始化，保持安全默认值
    }
  }

  /** 设置 SSRF 配置 */
  setConfig(config: Partial<SsrfConfig>): void {
    if (config.allowPrivateNetwork !== undefined) {
      this.ssrfConfig.allowPrivateNetwork = config.allowPrivateNetwork;
    }
    if (config.dangerouslyAllowPrivateNetwork !== undefined) {
      this.ssrfConfig.dangerouslyAllowPrivateNetwork = config.dangerouslyAllowPrivateNetwork;
    }
    if (Array.isArray(config.allowedHostnames)) {
      this.ssrfConfig.allowedHostnames = config.allowedHostnames.slice();
    }
    if (Array.isArray(config.allowedOrigins)) {
      this.ssrfConfig.allowedOrigins = config.allowedOrigins.slice();
    }
  }

  /** 获取当前 SSRF 配置（副本） */
  getConfig(): SsrfConfig {
    return {
      allowPrivateNetwork: this.ssrfConfig.allowPrivateNetwork,
      dangerouslyAllowPrivateNetwork: this.ssrfConfig.dangerouslyAllowPrivateNetwork,
      allowedHostnames: [...this.ssrfConfig.allowedHostnames],
      allowedOrigins: [...this.ssrfConfig.allowedOrigins],
    };
  }

  // ===========================================================================
  // SSRF 核心校验
  // ===========================================================================

  /**
   * 异步 URL 校验（主方法，全量移植自 .cjs checkUrl）
   *
   * 校验流程：
   *   1. URL 格式与协议校验（仅 http/https）
   *   2. 主机名白名单检查（含通配符子域）
   *   3. Origin 白名单检查
   *   4. 若主机名为 IP 字面量：直接检查私有/元数据
   *   5. 若主机名为域名：DNS 解析后检查 IP
   *   6. 私有 IP 由 dangerouslyAllowPrivateNetwork 决定是否放行
   *
   * @returns { safe: boolean, reason: string }
   */
  async checkUrl(url: string): Promise<UrlCheckResult> {
    try {
      // M-B15: 仅校验目标 hostname/IP，不预判重定向
      // 完整 SSRF 防护需 HTTP 客户端层在每跳重定向后再次调用 checkUrl
      if (!url || typeof url !== 'string') {
        return { safe: false, reason: 'Invalid URL' };
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (e) {
        return { safe: false, reason: `Malformed URL: ${e instanceof Error ? e.message : String(e)}` };
      }

      // 仅允许 http/https 协议
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
      }

      // 剥除 IPv6 字面量方括号（[fc00::1] → fc00::1），否则 isIP/前缀检查失效
      const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
      if (!hostname) {
        return { safe: false, reason: 'Missing hostname' };
      }

      // 先检查主机名白名单
      if (this.isAllowedHostname(hostname)) {
        return { safe: true, reason: 'Hostname in allowlist' };
      }

      // 检查 Origin 白名单
      const origin = parsed.origin;
      for (const allowed of this.ssrfConfig.allowedOrigins) {
        if (allowed.toLowerCase() === origin.toLowerCase()) {
          return { safe: true, reason: 'Origin in allowlist' };
        }
      }

      // 检查主机名是否为直接 IP
      if (isIP(hostname)) {
        if (this.isCloudMetadata(hostname)) {
          return { safe: false, reason: 'Cloud metadata endpoint blocked' };
        }
        if (this.isPrivateIp(hostname)) {
          if (this.ssrfConfig.dangerouslyAllowPrivateNetwork) {
            this.logger.warn(`允许私有网络访问: ${hostname}`);
            return { safe: true, reason: 'Private IP allowed by dangerous override' };
          }
          return { safe: false, reason: `Private IP address blocked: ${hostname}` };
        }
        return { safe: true, reason: 'Public IP address' };
      }

      // DNS 解析检查：解析域名后检查 IP
      let address: string;
      try {
        address = await this.resolveHostname(hostname);
      } catch (err) {
        return { safe: false, reason: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      this.logger.debug(`解析 ${hostname} -> ${address}`);

      if (this.isCloudMetadata(address)) {
        return { safe: false, reason: `Resolved to cloud metadata endpoint: ${address}` };
      }

      if (this.isPrivateIp(address)) {
        if (this.ssrfConfig.dangerouslyAllowPrivateNetwork) {
          this.logger.warn(`允许私有网络访问: ${hostname} (${address})`);
          return { safe: true, reason: 'Private IP allowed by dangerous override' };
        }
        return {
          safe: false,
          reason: `Hostname resolves to private IP: ${hostname} -> ${address}`,
        };
      }

      return { safe: true, reason: `Public IP address: ${address}` };
    } catch (err) {
      return { safe: false, reason: `URL check error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 同步 URL 校验（仅基于 URL 字符串与主机名文本判别，不做 DNS 解析）
   * 用于快速过滤明显的内网/保留地址。
   * 注意：此方法不防御 DNS rebinding，如需严格防护使用 checkUrl 或 checkAsync。
   */
  check(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // WHATWG URL 对 IPv6 字面量保留方括号（[fc00::1]），必须剥除后才能被
    // isIP() 识别、被 isHostnameBlocked 的前缀检查匹配——否则私有 IPv6 绕过同步检查
    const hostname = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    if (!hostname) return false;
    // 白名单放行
    if (this.isAllowedHostname(hostname)) return true;
    // Origin 白名单
    const origin = parsed.origin;
    for (const allowed of this.ssrfConfig.allowedOrigins) {
      if (allowed.toLowerCase() === origin.toLowerCase()) return true;
    }
    // IP 字面量检查
    if (isIP(hostname)) {
      if (this.isCloudMetadata(hostname)) return false;
      if (this.isPrivateIp(hostname)) {
        return this.ssrfConfig.dangerouslyAllowPrivateNetwork;
      }
      return true;
    }
    // 文本别名阻断
    if (this.isHostnameBlocked(hostname)) return false;
    // 普通域名：放行（DNS 解析在 checkAsync 中处理）
    return true;
  }

  /**
   * 异步 URL 校验（布尔返回值，便利方法）
   * 在 check() 基础上对非 IP 主机名做 DNS 解析。
   * fail-close：DNS 解析失败也拒绝。
   */
  async checkAsync(url: string): Promise<boolean> {
    const result = await this.checkUrl(url);
    return result.safe;
  }

  // ===========================================================================
  // IP 判别
  // ===========================================================================

  /**
   * 判断 IP 是否为私有/保留地址（全量移植自 .cjs isPrivateIp）
   *
   * IPv4 私有段：
   *   - 10.0.0.0/8
   *   - 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
   *   - 192.168.0.0/16
   *   - 127.0.0.0/8 (loopback)
   *   - 169.254.0.0/16 (link-local)
   *   - 0.0.0.0/8 (本网络，L-B2 修复)
   *   - 224.0.0.0/4 (multicast)
   *   - 255.255.255.255 (broadcast)
   *
   * IPv6 私有段：
   *   - fc00::/7 (ULA)
   *   - fe80::/10 (link-local, H-B8 修复：覆盖 fe80::-febf::)
   *   - ::1 (loopback)
   *   - :: (unspecified)
   *
   * 特殊处理：
   *   - M-B17: IPv4-mapped IPv6 (::ffff:x.x.x.x) 归一化为 IPv4 后判断
   *   - ::x.x.x.x (IPv4-compat) 归一化为 IPv4 后判断
   */
  isPrivateIp(ip: string): boolean {
    if (!ip || typeof ip !== 'string') return false;

    // M-B17: IPv4-mapped IPv6 (::ffff:1.2.3.4) 归一化为 IPv4 后判断
    const v4MappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4MappedMatch) {
      return this.isPrivateIp(v4MappedMatch[1] as string);
    }
    // M-B17b: WHATWG URL 会把 ::ffff:127.0.0.1 规范化为十六进制 ::ffff:7f00:1，
    // 上面的点分正则匹配不到——按十六进制组还原 IPv4 判断（否则公网放行漏判）
    const v4MappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1] as string, 16);
      const lo = parseInt(v4MappedHex[2] as string, 16);
      const restored = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return this.isPrivateIp(restored);
    }
    // 同时处理 ::127.0.0.1 / ::169.254.169.254 等 IPv4-compat 形式
    const v4CompatMatch = ip.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4CompatMatch) {
      return this.isPrivateIp(v4CompatMatch[1]);
    }

    // IPv4 私有段
    if (isIPv4(ip)) {
      const parts = ip.split('.').map(Number);
      // 10.0.0.0/8
      if (parts[0] === 10) return true;
      // 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      // 192.168.0.0/16
      if (parts[0] === 192 && parts[1] === 168) return true;
      // 127.0.0.0/8 (loopback)
      if (parts[0] === 127) return true;
      // 169.254.0.0/16 (link-local)
      if (parts[0] === 169 && parts[1] === 254) return true;
      // L-B2: 0.0.0.0/8 整个段都是"本网络"
      if (parts[0] === 0) return true;
      // 224.0.0.0/4 (multicast)
      if (parts[0] >= 224 && parts[0] <= 239) return true;
      // 255.255.255.255 (broadcast)
      if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;
      return false;
    }

    // IPv6 私有段
    if (isIPv6(ip)) {
      const lower = ip.toLowerCase();
      // fc00::/7 (Unique Local Addresses)
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
      // fe80::/10 (Link-Local Addresses)
      // H-B8: fe80::/10 covers fe80:: through febf::，检查所有四个前缀
      if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
      // L-B1: IPv6 loopback
      if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
      // :: (unspecified)
      if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
      return false;
    }

    return false;
  }

  /**
   * 判断 IP 是否为云元数据端点（全量移植自 .cjs isCloudMetadata）
   *
   * AWS/GCP/Azure 元数据: 169.254.169.254
   * GCP IPv6 元数据: fd00:ec2::254, fe80::a9fe:a9fe
   */
  isCloudMetadata(ip: string): boolean {
    if (!ip || typeof ip !== 'string') return false;

    if (isIPv4(ip)) {
      return ip === '169.254.169.254';
    }

    if (isIPv6(ip)) {
      const lower = ip.toLowerCase();
      // GCP metadata over IPv6
      if (lower === 'fd00:ec2::254' || lower.startsWith('fe80::a9fe:a9fe')) return true;
    }

    return false;
  }

  // ===========================================================================
  // 主机名白名单
  // ===========================================================================

  /**
   * 判断主机名是否在白名单中（支持通配符子域匹配）
   * 例如: *.example.com 匹配 foo.example.com, bar.example.com
   */
  isAllowedHostname(hostname: string): boolean {
    if (!hostname) return false;
    const lower = hostname.toLowerCase();
    for (const allowed of this.ssrfConfig.allowedHostnames) {
      if (allowed.toLowerCase() === lower) return true;
      // 支持通配符子域匹配
      if (allowed.startsWith('*.') && lower.endsWith(allowed.substring(1))) {
        return true;
      }
    }
    return false;
  }

  /** 添加允许的主机名 */
  addAllowedHostname(hostname: string): void {
    if (!hostname || typeof hostname !== 'string') return;
    if (!this.isAllowedHostname(hostname)) {
      this.ssrfConfig.allowedHostnames.push(hostname);
      this.logger.log(`添加允许主机名: ${hostname}`);
    }
  }

  /** 添加允许的 Origin */
  addAllowedOrigin(origin: string): void {
    if (!origin || typeof origin !== 'string') return;
    const lower = origin.toLowerCase();
    for (const allowed of this.ssrfConfig.allowedOrigins) {
      if (allowed.toLowerCase() === lower) return;
    }
    this.ssrfConfig.allowedOrigins.push(origin);
    this.logger.log(`添加允许 Origin: ${origin}`);
  }

  // ===========================================================================
  // 内部辅助方法
  // ===========================================================================

  /** DNS 解析主机名 */
  private async resolveHostname(hostname: string): Promise<string> {
    const records = await dnsLookup(hostname, { all: true });
    if (records.length === 0) {
      throw new Error('No DNS records found');
    }
    // 返回第一个解析地址
    return records[0].address;
  }

  /**
   * 判断主机名字符串是否命中文本阻断规则
   * 用于同步 check() 方法中非 IP 字面量的文本别名检查。
   */
  private isHostnameBlocked(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (!h) return true;

    // 文本别名
    const textBlocked = ['localhost', '0.0.0.0', '::', '::1', '::ffff:0.0.0.0'];
    if (textBlocked.includes(h)) return true;

    // 127.x.x.x 环回（含缩短格式）
    if (/^127\.(?:\d+\.){0,2}\d+$/.test(h)) return true;

    // IPv6-mapped IPv4
    if (/^::ffff:/i.test(h)) {
      const v4 = h.replace(/^::ffff:/i, '');
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) {
        return this.isPrivateIp(v4);
      }
      return true;
    }
    if (h.startsWith('::ffff:0:')) return true;

    // 纯 IPv6 字面量
    if (h.includes(':')) {
      if (h === '::1' || h === '::') return true;
      if (h.startsWith('fe80:')) return true;
      if (h.startsWith('fc') || h.startsWith('fd')) return true;
      if (h.startsWith('ff')) return true;
      // ::a.b.c.d IPv4-compat
      const tail = h.split(':').pop() ?? '';
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return this.isPrivateIp(tail);
      return false;
    }

    // 十进制/十六进制/八进制 IP 编码
    if (/^\d{8,}$/.test(h)) return true;
    if (/^0x[0-9a-f]+$/i.test(h)) return true;
    if (/^0[0-7]+$/.test(h)) return true;
    if (/\.0x[0-9a-f]/i.test(h) || h.split('.').some((seg) => /^0x[0-9a-f]+$/i.test(seg))) {
      return true;
    }

    // 普通域名：放行
    return false;
  }
}
