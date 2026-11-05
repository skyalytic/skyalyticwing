/**
 * /ws/chat WebSocket 客户端（基于 Node 22 内置 WebSocket，零依赖）
 *
 * 协议（对齐 packages/backend/src/modules/ai/chat/chat.gateway.ts 与
 * @nestjs/platform-ws 的 WsAdapter 消息映射）：
 *
 *   Client → Server：JSON 信封 { event, data }
 *     - chat:stream  { sessionId, message, model?, agent? }  触发流式对话
 *
 *   Server → Client：JSON 信封 { type, data? }
 *     - connected      { clientId, timestamp }              连接就绪
 *     - chat:token     { sessionId, content, done:false }   assistant 增量
 *     - chat:tool_call { sessionId, toolCall:{id,name,arguments} } 工具调用
 *     - chat:error     { sessionId, error }                 流式错误
 *     - chat:done      { sessionId, message, usage? }       完成（携带完整回复）
 *     - approval_pending / approval_request                  工具审批提示（广播）
 *     - { status:'ok' } 之类的 SubscribeMessage 回执一律忽略
 */

/** token 用量（chat:done.usage，字段缺失时容错） */
export interface TokenUsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 流式对话结束结果 */
export interface WsChatResult {
  /** done=正常完成；error=后端报错；closed=连接在完成前被关闭 */
  status: 'done' | 'error' | 'closed';
  /** 完整 assistant 回复（chat:done.message） */
  message?: string;
  /** 错误信息（chat:error.error） */
  error?: string;
  /** token 用量（可选） */
  usage?: TokenUsageInfo;
}

/** 流式事件回调 */
export interface WsChatHandlers {
  /** assistant 增量文本 */
  onToken?: (content: string) => void;
  /** 工具调用摘要（name + 序列化参数） */
  onToolCall?: (name: string, args: string) => void;
  /** 工具审批提示（后端等待用户在桌面端/REST 决策） */
  onApprovalHint?: (reason: string) => void;
}

/** streamChatViaWs 的参数 */
export interface StreamChatOptions {
  /** WS 地址，如 ws://127.0.0.1:9100/ws/chat */
  wsUrl: string;
  /** 会话 ID */
  sessionId: string;
  /** 用户消息 */
  message: string;
  /** 智能体 ID（可选） */
  agent?: string;
  /** 模型 ID（可选） */
  model?: string;
  /** 连接超时毫秒数，默认 5000 */
  connectTimeoutMs?: number;
  /** 流式事件回调 */
  handlers: WsChatHandlers;
}

/**
 * 建立 WS 连接（等待 open 事件）。
 * 连接失败 / 超时 / 连接即被关闭（如 token 认证拒绝）时抛错，由调用方决定回退 HTTP。
 */
async function connectChatWs(wsUrl: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      reject(
        new Error(
          `WebSocket 地址无效 ${wsUrl}：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // 忽略关闭异常
      }
      reject(new Error(`WebSocket 连接超时（${timeoutMs}ms）：${wsUrl}`));
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`WebSocket 连接失败：${wsUrl}`));
    };
    ws.onclose = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const reason = ev.reason ? `：${ev.reason}` : '';
      reject(new Error(`WebSocket 连接被关闭（code ${ev.code}）${reason}`));
    };
  });
}

/**
 * 发起一次流式对话并订阅事件流。
 *
 * 仅在「连接阶段」失败时抛错（供调用方回退 HTTP 非流式接口）；
 * 连接成功后即使流中途出错/断开也以结果对象返回，不抛异常。
 */
export async function streamChatViaWs(options: StreamChatOptions): Promise<WsChatResult> {
  const { wsUrl, sessionId, message, handlers } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const ws = await connectChatWs(wsUrl, connectTimeoutMs);

  return new Promise<WsChatResult>((resolve) => {
    let finished = false;

    /** 幂等收尾：记录结果 → 关闭连接 → resolve（onclose 再次触发时为空操作） */
    const finish = (r: WsChatResult): void => {
      if (finished) return;
      finished = true;
      try {
        ws.close();
      } catch {
        // 忽略关闭异常
      }
      resolve(r);
    };

    // 连接已在 connectChatWs 中就绪，直接发送 chat:stream 请求
    //（可选字段按 exactOptionalPropertyTypes 要求条件展开，避免显式写入 undefined）
    const payload = {
      event: 'chat:stream',
      data: {
        sessionId,
        message,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
      },
    };
    ws.send(JSON.stringify(payload));

    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: unknown };
      try {
        msg = JSON.parse(String(ev.data)) as { type?: string; data?: unknown };
      } catch {
        return; // 非 JSON 帧（理论上不出现），忽略
      }

      // data 为松散形状：不同事件字段差异大，按需窄化读取
      const data = (msg.data ?? {}) as {
        content?: string;
        message?: string;
        error?: string;
        reason?: string;
        usage?: TokenUsageInfo;
        toolCall?: { name?: string; arguments?: unknown };
      };

      switch (msg.type) {
        case 'chat:token':
          if (typeof data.content === 'string' && data.content) {
            handlers.onToken?.(data.content);
          }
          break;
        case 'chat:tool_call':
          handlers.onToolCall?.(
            data.toolCall?.name ?? 'unknown',
            JSON.stringify(data.toolCall?.arguments ?? {}),
          );
          break;
        case 'chat:error':
          finish({ status: 'error', error: data.error ?? '未知错误' });
          break;
        case 'chat:done':
          finish({
            status: 'done',
            ...(typeof data.message === 'string' ? { message: data.message } : {}),
            ...(data.usage !== undefined ? { usage: data.usage } : {}),
          });
          break;
        case 'approval_pending':
        case 'approval_request':
          handlers.onApprovalHint?.(data.reason ?? '工具执行需要审批（可在桌面端处理）');
          break;
        default:
          // connected / pong / tool_result / {status:'ok'} 回执等：忽略
          break;
      }
    };

    ws.onerror = () => {
      // 流中途连接错误：以 closed 结束（不回退，避免重复发送消息）
      finish({ status: 'closed' });
    };
    ws.onclose = () => {
      // 若 done/error 已收尾则此处为空操作；否则以 closed 结束
      finish({ status: 'closed' });
    };
  });
}
