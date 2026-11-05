import { createLogger, type Logger } from '@skyalyticwing/shared';
import type { SecurityConfig } from '../types/index.js';

export class SecurityEngine {
  private config: SecurityConfig;
  private logger: Logger;

  constructor(config: SecurityConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? createLogger({ name: 'security' });
  }

  validateUrl(url: string): boolean {
    if (!this.config.ssrfProtection) return true;
    try {
      const parsed = new URL(url);
      // 只允许 http/https 协议，拒绝 file://、javascript:、data: 等导致 SSRF 绕过的协议
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      const hostname = parsed.hostname.toLowerCase();
      // 拒绝空主机名（file:///etc/passwd 等无主机名的 URL）
      if (!hostname) return false;
      // Block localhost and loopback (including IPv6-mapped IPv4)
      // :: 为 IPv6 未指定地址，多数 OS 中等效于连接 loopback；::ffff:0.0.0.0 为 IPv6-mapped IPv4 通配
      const blocked = ['localhost', '0.0.0.0', '169.254.169.254', '::1', '::', '::ffff:0.0.0.0'];
      if (blocked.some(host => hostname === host)) return false;
      // 拒绝以 127. 开头的所有地址（包括缩短格式如 127.1、127.0.1，多数 OS 解析为 127.0.0.1）
      if (/^127\.(?:\d+\.){0,2}\d+$/.test(hostname)) return false;
      // Block IPv6-mapped IPv4 loopback and private addresses (e.g., ::ffff:127.0.0.1)
      if (/^::ffff:/i.test(hostname)) {
        const ipv4 = hostname.replace(/^::ffff:/i, '');
        // Only validate if it's a standard dotted-decimal IPv4
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4)) {
          return this.validateUrl(`http://${ipv4}`);
        }
        return false; // Non-standard format (e.g., hex) - reject
      }
      // Block private IPv4 ranges
      if (hostname.startsWith("10.")) return false;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
      if (hostname.startsWith("192.168.")) return false;
      if (hostname.startsWith("0.")) return false;
      // Block link-local
      if (hostname.startsWith("169.254.")) return false;
      // Reject octal IP formats (e.g., 012.0.0.1 = 10.0.0.1)
      if (/^0[0-7]+\./.test(hostname)) return false;
      // Reject hex IP formats (e.g., 0x0a000001 = 10.0.0.1)
      if (/^0x[0-9a-f]+$/i.test(hostname)) return false;
      // Reject mixed dotted-hex IP formats (e.g., 0x7f.0.0.1 = 127.0.0.1)
      if (/^0x[0-9a-f]/i.test(hostname) || /\.0x[0-9a-f]/i.test(hostname)) return false;
      // Reject decimal integer IPs (e.g., 167772161 = 10.0.0.1)
      if (/^\d+$/.test(hostname) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
      // Block IPv6 unique local addresses (fc00::/7)
      if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return false;
      // Block IPv6 link-local
      if (/^fe80:/i.test(hostname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  validatePath(filePath: string): boolean {
    if (!this.config.pathPolicy) return true;
    const { allowed = [], denied = [] } = this.config.pathPolicy;
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
    // `..` 检查改为路径段级别（按 / 切分后检查是否含 `..` 段），
    // 而非子串匹配，避免误拒合法文件名如 `file..txt`、`a..b.css` 等。
    // 子串匹配 `normalized.includes('..')` 会拒绝所有含两个连续点的路径，
    // 包括合法的 `foo..bar.txt`。改为段级别检查仅拒绝真正的父目录引用 `../` 或 `..` 段。
    const segments = normalized.split('/');
    if (segments.includes('..')) return false;
    // Check allowed whitelist - if defined, path must be under one of the allowed paths
    if (allowed.length > 0) {
      const isAllowed = allowed.some(pattern => {
        // 归一化 pattern 与 path 的尾斜杠，避免 `/allowed/` vs `/allowed` 匹配失败。
        // 原实现 np.endsWith('/') 时 `np + '/'` 变成 `np + '//'`，startsWith 判断可能失效；
        // 同时若 pattern 含尾斜杠而 path 不含，`np + '/'` 会多一个斜杠导致 startsWith 误判。
        // 统一去除尾斜杠后再比较，使 /allowed/ 与 /allowed 等价。
        const np = pattern.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
        const normPath = normalized.replace(/\/$/, '');
        return normPath === np || normPath.startsWith(np + '/');
      });
      if (!isAllowed) return false;
    }
    // Check denied list
    for (const pattern of denied) {
      // 同上，denied 模式也归一化尾斜杠
      const np = pattern.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
      const normPath = normalized.replace(/\/$/, '');
      if (normPath === np || normPath.startsWith(np + '/')) return false;
    }
    return true;
  }

  checkCommandApproval(command: string): 'auto' | 'ask' | 'deny' {
    // TS-11 fix: 使用 logger 与 command 参数消除未使用警告
    this.logger.debug({ command }, 'Command approval check');
    return this.config.commandApproval;
  }

  isSandboxEnabled(): boolean {
    return this.config.sandboxEnabled;
  }
}
