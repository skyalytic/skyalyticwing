import type { ChannelMessage, ChannelPluginApi } from '@skyalyticwing/sdk';

// BaseChannel 显式 implements ChannelPluginApi，使 TS 编译器在编译期校验
// 基类与 SDK 契约一致（onMessage 返回 () => void、connect/disconnect/sendMessage 签名匹配），
// 避免基类与接口漂移导致的契约不匹配问题。
//
// disconnect() 由抽象方法改为模板方法（template method）。
// 基类 disconnect() 统一负责：置 connected=false → 调用子类 doDisconnect() 钩子 → 调用 clearHandlers()。
// 子类不再重写 disconnect()，而是按需重写 protected doDisconnect() 执行渠道特定的断连清理
// （如关闭 WebSocket、清理重连定时器）。这样基类保证 handlers 一定被清理，
// 避免 8/11 渠道曾因遗漏 clearHandlers() 导致的处理器泄漏与重连后重复处理。
//
// BaseChannel 已声明 implements ChannelPluginApi（H-H2 修复时已加），
// 此处保留注释标记 L-F3 关联，确保接口与基类同步演进（包括 configure、reconnect 等新增钩子）。
export abstract class BaseChannel implements ChannelPluginApi {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: string;
  protected handlers: Array<(message: ChannelMessage) => void | Promise<void>> = [];
  protected connected = false;

  // _connecting 标志位防止 connect() TOCTOU 竞态。
  // 原实现仅 `if (this.connected) return` + 后续 `this.connected = true`，两者之间非原子。
  // 若 connect() 中有 await（如等待 WebSocket 握手），并发调用 connect() 会同时通过 `!connected` 检查
  // 并各自创建连接，导致重复连接。子类 connect() 应在开头调用 _markConnecting()，
  // 在连接成功后调用 _markConnected()，在失败/异常时调用 _clearConnecting()。
  private _connecting = false;

  abstract connect(): Promise<void>;
  abstract sendMessage(peerId: string, content: string): Promise<void>;

  /**
   * 子类 connect() 开头应调用此方法。
   * 若已连接或正在连接则返回 false，子类应立即 return（不重复连接）。
   * 否则置 _connecting=true 并返回 true，子类继续执行连接逻辑。
   */
  protected _markConnecting(): boolean {
    if (this.connected || this._connecting) return false;
    this._connecting = true;
    return true;
  }

  /** M-F2 fix: 连接成功后子类调用此方法置 connected=true 并清除 _connecting 标志 */
  protected _markConnected(): void {
    this._connecting = false;
    this.connected = true;
  }

  /** M-F2 fix: 连接失败时子类调用此方法清除 _connecting 标志（connected 仍为 false） */
  protected _clearConnecting(): void {
    this._connecting = false;
  }

  // 模板方法，子类不应重写（TypeScript 无 final 关键字，靠约定与下方 doDisconnect 钩子约束）。
  // 调用顺序：先置 connected=false（使任何异步重连逻辑能立即观察到断开状态），
  // 再调用 doDisconnect() 让子类执行渠道特定清理，最后 clearHandlers() 保证处理器清理。
  async disconnect(): Promise<void> {
    this.connected = false;
    this._connecting = false;
    try {
      await this.doDisconnect();
    } catch (err) {
      // 子类断连清理失败不应阻塞 handlers 清理，仅记录错误
      console.error('[Channel] Error in doDisconnect:', err);
    }
    this.clearHandlers();
  }

  // 子类断连清理钩子。默认实现为空，子类按需重写
  // （例如关闭 WebSocket、clearTimeout 重连定时器、销毁客户端等）。
  // 基类 disconnect() 模板方法会在此之后统一调用 clearHandlers()，子类无需再自行调用。
  protected async doDisconnect(): Promise<void> {
    // 默认无操作
  }

  // onMessage 返回取消订阅函数 () => void，与 SDK ChannelPluginApi 契约统一。
  onMessage(handler: (message: ChannelMessage) => void | Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index !== -1) this.handlers.splice(index, 1);
    };
  }

  protected notify(message: ChannelMessage): void {
    // 遍历副本，避免 handler 同步取消订阅时 splice 修改原数组导致跳过下一个 handler
    for (const handler of [...this.handlers]) {
      try {
        const result = handler(message);
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error('[Channel] Unhandled error in message handler:', err);
          });
        }
      } catch (err) {
        console.error('[Channel] Unhandled error in message handler:', err);
      }
    }
  }

  protected clearHandlers(): void {
    this.handlers = [];
  }

  protected validateSendMessage(peerId: string, content: unknown): void {
    if (!this.connected) throw new Error('Channel not connected');
    if (!peerId || typeof peerId !== 'string') throw new Error('peerId is required');
    // 允许空字符串内容（用于仅含附件的消息），但拒绝 null/undefined。
    // 原实现 `if (!content || typeof content !== 'string')` 中 `!content` 对空字符串 `''` 返回 true，
    // 误拒合法的"仅附件"消息。改为显式检查 null/undefined 与非字符串类型，空字符串放行。
    if (content === null || content === undefined) throw new Error('content is required');
    if (typeof content !== 'string') throw new Error('content must be a string');
  }

  // 基类提供 configure() 默认空实现，子类按需重写。
  // 与 SDK ChannelPluginApi 接口契约统一，使调用方可多态调用 configure() 而无需类型断言。
  // 子类重写时应校验 config 字段并赋值到自身属性。
  configure(_config: unknown): void {
    // 默认无操作，子类按需重写
  }

  // 重连/退避/速率限制契约钩子。
  // 渠道实现按需重写以下钩子以接入渠道特定的重连策略。
  // 基类提供默认实现（不重连/不退避/不限流），子类可覆盖以接入具体策略。

  /**
   * 是否支持自动重连。默认 false，子类可重写为 true 并实现 doReconnect()。
   * 框架在连接异常断开时调用此方法判断是否触发重连流程。
   */
  supportsReconnect(): boolean {
    return false;
  }

  /**
   * 子类重连逻辑钩子。仅在 supportsReconnect() 返回 true 时被调用。
   * 子类应实现具体的重连流程（如等待 backoff 后重新 connect）。
   */
  protected async doReconnect(): Promise<void> {
    // 默认无操作，子类按需重写
  }

  /**
   * 计算重连退避时间（毫秒）。默认指数退避：base * 2^attempt，上限 60s。
   * 子类可重写以使用渠道特定的退避策略（如抖动退避、固定间隔等）。
   * @param attempt 重连尝试次数（从 0 开始）
   * @returns 退避毫秒数
   */
  protected computeBackoff(attempt: number): number {
    const base = 1000; // 1 秒
    const max = 60000; // 60 秒上限
    return Math.min(base * Math.pow(2, attempt), max);
  }

  /**
   * 速率限制检查。子类可重写以接入渠道特定的限流策略（如令牌桶、滑动窗口）。
   * 默认返回 true（不限制）。框架在 sendMessage 前调用此方法，返回 false 时应抛出限流错误。
   */
  checkRateLimit(_peerId: string): boolean {
    return true;
  }

  // 超时与 API 错误校验契约钩子。
  // 渠道实现按需重写以接入渠道特定的超时配置与错误响应校验逻辑。

  /**
   * 获取请求超时时间（毫秒）。默认 30 秒，子类可重写为渠道特定值。
   * 用于 sendMessage 等远程调用的超时控制。
   */
  protected getRequestTimeout(): number {
    return 30000;
  }

  /**
   * 校验渠道 API 错误响应。
   * 子类重写以解析渠道特定的错误响应体（如飞书 error.code、微信 errcode），
   * 返回标准化的 Error 或 null（表示无错误）。
   * 默认实现仅检查 HTTP status >= 400。
   * @param status HTTP 状态码
   * @param body 响应体（已解析的对象或原始字符串）
   * @returns 标准化 Error 或 null
   */
  protected validateApiResponse(status: number, body: unknown): Error | null {
    if (status >= 400) {
      return new Error(`Channel API error: HTTP ${status}`);
    }
    return null;
  }

  // Webhook 签名校验契约钩子。
  // 各渠道按需重写以校验传入 webhook 请求的签名（如飞书 X-Lark-Signature、企业微信 token、Slack signing secret）。
  // 默认实现返回 true（不校验），子类必须重写以启用签名校验，避免伪造请求。
  // 注意：M-D15 已修复 Feishu webhook 签名校验，此钩子为通用契约供所有渠道实现。

  /**
   * 校验 webhook 请求签名。
   * @param headers 请求头对象
   * @param rawBody 原始请求体（Buffer 或字符串）
   * @param signature 签名值（若从 query 提取则由调用方传入）
   * @returns true 表示签名合法，false 表示非法应拒绝
   */
  verifySignature(_headers: Record<string, string | string[] | undefined>, _rawBody: Buffer | string, _signature?: string): boolean {
    // 默认返回 true 兼容不使用 webhook 签名的渠道；使用 webhook 的渠道必须重写此方法
    // 进行严格的签名校验，否则存在伪造请求风险（参见 M-D15 Feishu 案例）
    return true;
  }
}
