import { wt } from '@/i18n/workbench-text';
// 审批状态 store（支持 4 种决策类型 + 审批历史）
import { create } from 'zustand';
import { apiClient } from '@/services/api-client';
import type { ToolApprovalRequest } from '@/types';

/** 审批决策类型（对齐旧版 approval.js 的 4 种决策） */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'denied' | 'deny-always';

/** 前端弹窗自动移除延迟（毫秒），略长于后端 120s 审批超时 */
const APPROVAL_AUTO_REMOVE_MS = 125_000;

/** 审批弹窗自动过期定时器（approvalId → timer） */
const approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const responding = new Set<string>();

/** 清除单个审批的自动移除定时器 */
function clearApprovalTimer(id: string): void {
  const timer = approvalTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    approvalTimers.delete(id);
  }
}

/** 审批历史条目 */
export interface ApprovalHistoryItem {
  id: string;
  tool?: string;
  toolName?: string;
  decision?: string;
  approved?: boolean;
  reason?: string;
  timestamp?: number;
  args?: unknown;
}

/** 已决记录供历史查看；不再占据对话输入区。 */
export interface ApprovalResolvedRecord {
  request: ToolApprovalRequest;
  decision: ApprovalDecision;
  reason?: string;
  resolvedAt: number;
}

export interface ApprovalState {
  pendingApprovals: ToolApprovalRequest[];
  /** 最近审批历史（GET /api/approvals/history，最多 50 条） */
  approvalsHistory: ApprovalHistoryItem[];
  /** 已决审批（id → 记录），切换会话时清空 */
  resolvedApprovals: Record<string, ApprovalResolvedRecord>;
  addApproval: (request: ToolApprovalRequest) => void;
  removeApproval: (id: string) => void;
  /** 提交决策：POST /api/approvals/{id} body { decision, reason } */
  respondApproval: (id: string, decision: ApprovalDecision, reason?: string) => Promise<void>;
  /** 清空已决记录（切换会话时调用） */
  clearResolved: () => void;
  /** 拉取审批历史（最近 50 条） */
  loadApprovalsHistory: () => Promise<void>;
  clear: () => void;
}

export const useApprovalStore = create<ApprovalState>()((set, get) => ({
  pendingApprovals: [],
  approvalsHistory: [],
  resolvedApprovals: {},

  addApproval: (request) =>
    set((state) => {
      if (state.pendingApprovals.some((a) => a.id === request.id)) {
        return state;
      }
      // 后端 120s 超时后不再等待响应（视为拒绝），前端 125s 自动移除卡片
      // 并记录超时拒绝结果
      approvalTimers.set(
        request.id,
        setTimeout(() => {
          approvalTimers.delete(request.id);
          const s = useApprovalStore.getState();
          if (s.pendingApprovals.some((a) => a.id === request.id)) {
            useApprovalStore.setState((st) => ({
              pendingApprovals: st.pendingApprovals.filter((a) => a.id !== request.id),
              resolvedApprovals: {
                ...st.resolvedApprovals,
                [request.id]: {
                  request,
                  decision: 'denied',
                  reason: wt('审批超时，已自动拒绝'),
                  resolvedAt: Date.now(),
                },
              },
            }));
          }
        }, APPROVAL_AUTO_REMOVE_MS),
      );
      return { pendingApprovals: [...state.pendingApprovals, request] };
    }),

  removeApproval: (id) => {
    clearApprovalTimer(id);
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id),
    }));
  },

  respondApproval: async (id, decision, reason) => {
    if (responding.has(id)) return;
    responding.add(id);
    const request = get().pendingApprovals.find((a) => a.id === id);
    try {
      // 对齐旧版端点：POST /api/approvals/{id} body { decision, reason }
      await apiClient.post(`/approvals/${id}`, { decision, reason });
      // A failed submission must stay pending and retryable instead of showing approval.
      clearApprovalTimer(id);
      set((state) => ({
        pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id),
        resolvedApprovals: request ? {
          ...state.resolvedApprovals,
          [id]: { request, decision, reason, resolvedAt: Date.now() },
        } : state.resolvedApprovals,
      }));
      // 决策成功后刷新工具列表、权限及审批历史
      void Promise.allSettled([
        apiClient.get('/tools').catch(() => undefined),
        apiClient.get('/permissions').catch(() => undefined),
        get().loadApprovalsHistory(),
      ]);
    } catch (e) {
      console.error(wt('审批响应失败:'), e);
      throw e;
    } finally {
      responding.delete(id);
    }
  },

  loadApprovalsHistory: async () => {
    try {
      const data = await apiClient.get<
        { approvals?: ApprovalHistoryItem[] } | ApprovalHistoryItem[]
      >('/approvals/history');
      const list = Array.isArray(data) ? data : (data?.approvals ?? []);
      // 仅保留最近 50 条
      set({ approvalsHistory: list.slice(0, 50) });
    } catch (e) {
      console.warn(wt('加载审批历史失败:'), e);
    }
  },

  clearResolved: () => set({ resolvedApprovals: {} }),

  clear: () => {
    // 清除全部自动移除定时器，避免残留回调操作已重置的状态
    for (const timer of approvalTimers.values()) clearTimeout(timer);
    approvalTimers.clear();
    responding.clear();
    set({ pendingApprovals: [], approvalsHistory: [], resolvedApprovals: {} });
  },
}));
