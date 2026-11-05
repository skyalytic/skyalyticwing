import type { ChatParams, ChatChunk, ModelDefinition } from './types.js';
import type { ProviderPluginApi } from '@skyalyticwing/sdk';

// BaseProvider 增加 apiBase/endpoint URL 安全校验钩子 _validateApiBase()。
// 设计缺口：所有 Provider 的 configure() 中 `if (c.apiBase) this.apiBase = c.apiBase` 直接覆盖，无 scheme 校验，
// 攻击者可将 apiBase 设为 http://169.254.169.254/...（云元数据）等内网/链路本地地址，
// LLM 请求会携带 Authorization 头转发到攻击者控制的端点（SSRF）。
// 所有 Provider 在 configure() 中调用共享端点校验。
// 校验规则：
//   1. 仅允许 http(s)/ws(s) scheme，拒绝 file:/data:/javascript: 等
//   2. 非加密 scheme (http/ws) 仅允许 loopback（localhost/127.0.0.1/::1），且需 allowLoopback 选项放行（如 Ollama 本地）
//   3. 拒绝私网/环回/链路本地/CGNAT/保留段 IP，防止 SSRF 到内网元数据服务（169.254.169.254 等）
//      loopback 由 allowLoopback 放行
//   4. 处理 IPv6-mapped IPv4 (::ffff:1.2.3.4) 归约到 IPv4 检查
export abstract class BaseProvider implements ProviderPluginApi {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly region: 'international' | 'china' | 'both';

  abstract chat(params: ChatParams): AsyncGenerator<ChatChunk>;
  abstract listModels(): ModelDefinition[];
  abstract configure(config: Record<string, unknown>): void;

  /**
   * 校验 apiBase / endpoint / baseUrl URL，返回通过校验的 URL。
   * @param url 待校验的 URL 字符串
   * @param options.allowLoopback 是否允许 loopback 地址（127.0.0.1/::1/localhost）及非加密 scheme（http/ws），
   *   仅用于已知安全的本地服务（如 Ollama http://localhost:11434）。默认 false。
   * @throws 若 URL 格式无效、scheme 非法、或指向私网/环回/链路本地等敏感地址
   */
  protected _validateApiBase(url: string, options: { allowLoopback?: boolean } = {}): string {
    const allowLoopback = options.allowLoopback === true;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('Provider apiBase must be a non-empty string');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Provider apiBase invalid URL: ${url}`);
    }
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    // 仅允许 http(s)/ws(s)，拒绝 file:/data:/javascript: 等危险协议
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
      throw new Error(`Provider apiBase must use http(s) or ws(s) scheme, got: ${parsed.protocol}`);
    }
    const isInsecure = scheme === 'http' || scheme === 'ws';
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.username || parsed.password || parsed.hash) throw new Error('Provider endpoint must not contain credentials or fragments');
    const isLoopbackHost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1';
    // 非加密 scheme 仅允许 loopback，防止明文凭据泄露到公网；loopback 仍需 allowLoopback 显式放行
    if (isInsecure && !(allowLoopback && isLoopbackHost)) {
      throw new Error(
        `Provider apiBase ${scheme}:// only allowed for loopback with allowLoopback option; use https/wss for remote hosts: ${url}`
      );
    }
    // 拒绝私网/环回/链路本地/CGNAT/保留段 IP，防止 SSRF（loopback 由 allowLoopback 放行）
    this._rejectSensitiveIp(hostname, allowLoopback);
    return url;
  }

  /**
   * 校验 configure() 必填字符串字段，避免 `as` 断言后未校验导致 undefined/null 被赋值。
   * 子类在 configure() 中应调用此方法校验 apiKey/secretKey 等必填字段，
   * 而非直接 `this.apiKey = c.apiKey`（c.apiKey 可能 undefined）。
   * @param value 待校验的字段值
   * @param fieldName 字段名（用于错误信息）
   * @returns 通过校验的非空字符串
   * @throws 若 value 不是字符串或为空字符串
   */
  protected _requireString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Provider ${this.id} configure: field "${fieldName}" must be a non-empty string`);
    }
    return value;
  }

  /**
   * 检测并拒绝指向私网/环回/链路本地等敏感地址的 hostname。
   * 覆盖 IPv4 各保留段、IPv6 loopback/链路本地/ULA，以及 IPv6-mapped IPv4 归约。
   */
  private _rejectSensitiveIp(hostname: string, allowLoopback: boolean): void {
    // IPv4 dotted-quad
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const a = parseInt(ipv4[1], 10);
      const b = parseInt(ipv4[2], 10);
      if (a === 127) {
        if (!allowLoopback) throw new Error(`Provider apiBase loopback IP not allowed: ${hostname}`);
        return;
      }
      if (a === 10) throw new Error(`Provider apiBase private 10.0.0.0/8 not allowed: ${hostname}`);
      if (a === 172 && b >= 16 && b <= 31) throw new Error(`Provider apiBase private 172.16.0.0/12 not allowed: ${hostname}`);
      if (a === 192 && b === 168) throw new Error(`Provider apiBase private 192.168.0.0/16 not allowed: ${hostname}`);
      if (a === 169 && b === 254) throw new Error(`Provider apiBase link-local 169.254.0.0/16 not allowed: ${hostname}`);
      if (a === 100 && b >= 64 && b <= 127) throw new Error(`Provider apiBase CGNAT 100.64.0.0/10 not allowed: ${hostname}`);
      if (a === 0) throw new Error(`Provider apiBase 0.0.0.0/8 not allowed: ${hostname}`);
      if (a >= 224) throw new Error(`Provider apiBase multicast/reserved not allowed: ${hostname}`);
      return;
    }
    // IPv6（去除方括号）
    const v6 = hostname.replace(/^\[|\]$/g, '');
    if (v6.includes(':')) {
      const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6);
      if (hexMapped) {
        const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
        this._rejectSensitiveIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, allowLoopback);
        return;
      }
      if (v6 === '::' || /^ff/i.test(v6)) throw new Error('Provider apiBase unspecified or multicast IPv6 not allowed');
      // IPv6-mapped IPv4（::ffff:1.2.3.4）归约到 IPv4 检查
      const mapped = v6.match(/^(?:0*:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
      if (mapped) {
        this._rejectSensitiveIp(mapped[1], allowLoopback);
        return;
      }
      if (v6 === '::1') {
        if (!allowLoopback) throw new Error(`Provider apiBase loopback IPv6 not allowed: ${hostname}`);
        return;
      }
      if (/^fe[89ab]/i.test(v6)) throw new Error(`Provider apiBase link-local IPv6 not allowed: ${hostname}`);
      if (v6.startsWith('fc') || v6.startsWith('fd')) throw new Error(`Provider apiBase ULA IPv6 not allowed: ${hostname}`);
    }
  }
}
