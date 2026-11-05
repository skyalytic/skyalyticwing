import type { ToolDefinition } from './types.js';

// BaseTool 建立安全契约——强制子类实现 validate(input) 校验输入，
// 在 execute() 执行实际逻辑前调用，统一入口校验位置，避免各子类在 execute() 中
// 零散地做 typeof 检查导致遗漏或绕过。同时提供共享的 sanitizePath/sanitizeUrl 工具
// 供路径与 URL 相关工具统一规范化与基础校验。
//
// 注：TS tools 包为桩实现（实际工具在 packages/web/tools/*.cjs，C/B 级已覆盖），
// 此处建立抽象层契约，子类补全实现时强制遵循 validate→execute 的统一流程。
export abstract class BaseTool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly category: string;
  protected _enabled: boolean = true;

  // 强制抽象方法。子类必须实现输入校验，校验失败抛出 Error。
  // execute() 应在执行实际逻辑前首先调用 this.validate(input)。
  // 校验内容包括但不限于：必填参数存在性、类型正确性、路径/URL 基础安全校验。
  // 实际的路径白名单、命令白名单等深度校验由具体工具实现（参考 packages/web/tools/*.cjs 的 SecurityManager 调用）。
  abstract validate(input: Record<string, unknown>): void;

  abstract execute(input: Record<string, unknown>): Promise<unknown>;

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * 共享路径校验工具，供 file-read/file-write/file-edit/file-delete/
   * directory-list/glob/grep/code-lint/code-format/code-test 等路径相关工具使用。
   * 校验非空字符串、拒绝 null 字节（路径注入），并 trim 首尾空白。
   * 注意：此处仅做基础规范化，具体路径是否在允许目录内由子类 validate() 中调用
   * SecurityManager.isPathAllowed 或工作区白名单做深度校验。
   */
  protected sanitizePath(p: unknown): string {
    if (typeof p !== 'string') {
      throw new Error('Path parameter is required and must be a string');
    }
    const trimmed = p.trim();
    if (trimmed.length === 0) {
      throw new Error('Path parameter must not be empty or whitespace-only');
    }
    // 拒绝 null 字节，防止路径注入（如 "safe.txt\0../../etc/passwd"）
    if (trimmed.includes('\0')) {
      throw new Error('Path parameter must not contain null bytes');
    }
    return trimmed;
  }

  /**
   * 共享 URL 校验工具，供 api-call/web-fetch/browser-open 等使用。
   * 仅允许 http/https 协议，拒绝 file:/javascript:/data: 等危险协议。
   * 具体的目标 IP/域名 SSRF 校验由子类 validate() 中调用 SecurityManager.checkUrl 做深度校验。
   */
  protected sanitizeUrl(u: unknown): string {
    if (typeof u !== 'string' || u.length === 0) {
      throw new Error('URL parameter is required and must be a non-empty string');
    }
    const trimmed = u.trim();
    if (trimmed.length === 0) {
      throw new Error('URL parameter must not be empty or whitespace-only');
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid URL: ${trimmed}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL must use http or https protocol, got: ${parsed.protocol}`);
    }
    return trimmed;
  }

  getDefinition(): ToolDefinition {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      category: this.category,
      enabled: this._enabled,
    };
  }
}
