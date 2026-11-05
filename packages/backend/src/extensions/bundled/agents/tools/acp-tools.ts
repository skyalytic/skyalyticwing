import type { ToolDefinition, ToolResult } from '@skyalyticwing/shared';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { AcpService } from '../../../../modules/ai/acp/acp.service.js';
import { jsonOut } from '../../reach/tools/agent-reach.js';

function fail(error: string): ToolResult {
  return { success: false, error };
}

/**
 * ACP（Agent Communication Protocol）域内置工具（移植自旧版 misc.cjs acp_* 系列）：
 * acp_status / acp_session_create / acp_session_list / acp_session_close /
 * acp_approval_classify / acp_session_resume / acp_event_replay。
 *
 * 桥接 modules/ai/acp 的 AcpService（AcpManager 门面），经 ServiceResolver 懒解析
 * （AcpModule 非全局，且其内部 AgentLoopService 与工具执行器存在依赖关系）。
 */
export function createAcpTools(resolve: ServiceResolver): ToolDefinition[] {
  const getAcp = (): AcpService | undefined => resolve(AcpService);

  return [
    // ═══ acp_status ═══
    {
      name: 'acp_status',
      description:
        '获取 ACP 协议状态：启用状态、并发会话上限、活跃/总会话数、SSE 客户端数等。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          return jsonOut(acp.getStatus());
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ acp_session_create ═══
    {
      name: 'acp_session_create',
      description: '创建一个新的 ACP 会话（供 IDE 等外部工具通过 ACP 协议与 Agent 通信）。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent ID（默认 main）' },
        },
        required: [],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { agentId?: string };
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          const r = acp.initializeSession({
            agentId: a.agentId || 'main',
            channel: 'tool',
            peerId: '',
            runtimeOptions: {},
            backendCandidates: ['default'],
          });
          if (!r.success) return fail(r.error || '会话创建失败');
          return jsonOut({ sessionId: r.sessionId, status: 'ready' });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ acp_session_list ═══
    {
      name: 'acp_session_list',
      description: '列出所有 ACP 会话及其状态（会话 ID、Agent、消息数、活跃状态）。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          const sessions = acp.listCompatSessions();
          return jsonOut({ total: sessions.length, sessions });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ acp_session_close ═══
    {
      name: 'acp_session_close',
      description: '关闭一个 ACP 会话（释放并发额度并记录 session_closed 事件）。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要关闭的 ACP 会话 ID' },
        },
        required: ['sessionId'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = args as { sessionId?: string };
        if (!a || typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
          return fail('Parameter "sessionId" is required');
        }
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          const r = acp.closeSession({ sessionId: a.sessionId });
          if (!r.success) return fail(r.error || `会话关闭失败: ${a.sessionId}`);
          return jsonOut({ closed: a.sessionId });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ acp_approval_classify ═══
    {
      name: 'acp_approval_classify',
      description: '使用 ACP 审批分类器判断工具调用的审批类别与是否可自动批准。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          toolName: { type: 'string', description: '工具名称' },
          args: { type: 'object', description: '工具参数（可选）' },
        },
        required: ['toolName'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { toolName?: string; args?: unknown };
        if (typeof a.toolName !== 'string' || a.toolName.length === 0) {
          return fail('Parameter "toolName" is required');
        }
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          return jsonOut({ classification: acp.classifyApproval(a.toolName, a.args) });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ acp_session_resume ═══
    {
      name: 'acp_session_resume',
      description: '恢复 ACP 会话：重新连接既有会话继续交互，可选附带首条用户消息（记入事件账本）。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '要恢复的 ACP 会话 ID' },
          message: { type: 'string', description: '恢复后发送的首条消息（可选）' },
        },
        required: ['sessionId'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { sessionId?: string; message?: string };
        if (typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
          return fail('Parameter "sessionId" is required');
        }
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          const detail = acp.loadSessionDetail(a.sessionId);
          if (!detail) return fail(`ACP 会话未找到: ${a.sessionId}`);
          const r = acp.resumeSessionById(a.sessionId);
          if (!r.success) return fail(r.error || '会话恢复失败');
          if (typeof a.message === 'string' && a.message.length > 0) {
            acp.recordUserPrompt(a.sessionId, a.message);
          }
          return jsonOut({ sessionId: a.sessionId, resumed: true, status: r.status, session: detail });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ acp_event_replay ═══
    {
      name: 'acp_event_replay',
      description: '回放 ACP 事件账本：获取指定会话的历史事件记录（支持游标与条数限制）。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'ACP 会话 ID' },
          afterCursor: { type: 'number', description: '从该游标之后开始回放（可选）' },
          limit: { type: 'number', description: '最大事件数，默认 50' },
        },
        required: ['sessionId'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { sessionId?: string; afterCursor?: number; limit?: number };
        if (typeof a.sessionId !== 'string' || a.sessionId.length === 0) {
          return fail('Parameter "sessionId" is required');
        }
        const acp = getAcp();
        if (!acp) return fail('AcpService 未初始化，ACP 功能不可用');
        try {
          const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 50;
          const replay = acp.readReplay(a.sessionId, a.afterCursor, limit);
          return jsonOut(replay);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
