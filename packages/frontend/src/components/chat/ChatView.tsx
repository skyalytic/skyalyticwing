import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 聊天主视图（对齐旧版 renderChatView：无顶栏、空会话居中欢迎区+快捷按钮、
// 消息气泡流、底部工具栏+附件预览+输入框；工具面板为右侧抽屉）
// IDE 工程模式：主区右侧挂可收缩项目面板（文件树 + 文件预览，产物点击联动）
import { useCallback, useEffect, useState } from 'react';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ApprovalInlineCard } from './ApprovalInlineCard';
import { ToolPanelDrawer } from '@/modules/tools/ToolPanelDrawer';
import { ProjectPanel } from '@/components/project/ProjectPanel';
import { TaskWelcome } from './TaskWelcome';
import { GenerationHistory } from '@/modules/tools/GenerationHistory';
import { useChat } from '@/hooks/use-chat';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useApprovalStore } from '@/stores/approval-store';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';
import type { Attachment, ToolListItem } from '@/types';

/** 这里只显示仍需操作的审批；完成后的记录在安全设置的审批记录中查看。 */
function ApprovalInlineStack() {
  useWorkbenchLanguage();
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const clearResolved = useApprovalStore((s) => s.clearResolved);
  const takeoverId = pendingApprovals.find(
    (a) => !a.sessionId || a.sessionId === currentSessionId,
  )?.id;

  // 切换会话时清空已决记录（已决卡属于会话内的对话记录）
  useEffect(() => {
    clearResolved();
  }, [currentSessionId, clearResolved]);

  const sessionPending = pendingApprovals.filter(
    (a) => (!a.sessionId || a.sessionId === currentSessionId) && a.id !== takeoverId,
  );
  if (sessionPending.length === 0) return null;

  return (
    <div className="px-4 pb-2 space-y-2 shrink-0">
      {sessionPending.map((a) => (
        <ApprovalInlineCard key={a.id} request={a} />
      ))}
    </div>
  );
}

export function ChatView() {
  useWorkbenchLanguage();
  const { messages, isStreaming, isStopping, streamingContent, sendMessage, stopStreaming, clearConversation, isClearing } = useChat();
  // 排队输入：流式期间发送的消息进入队列，本轮结束自动发出
  const [queues, setQueues] = useState<Record<string, Array<{ content: string; attachments?: Attachment[]; model?: string }>>>({});
  const queueSessionId = useSessionStore(s => s.currentSessionId) ?? '';
  const queued = queues[queueSessionId] ?? [];
  const setQueued = useCallback((value: typeof queued | ((old: typeof queued) => typeof queued)) => {
    setQueues(all => ({...all, [queueSessionId]: typeof value === 'function' ? value(all[queueSessionId] ?? []) : value}));
  }, [queueSessionId]);

  // ── 工具面板（旧版 openToolPanel('bash')：右侧抽屉 + 动态表单）──
  const [panelTool, setPanelTool] = useState<ToolListItem | null>(null);

  const openToolPanel = useCallback(async () => {
    try {
      const [list, system] = await Promise.all([
        apiClient.get<ToolListItem[]>('/tools'),
        apiClient.get<{platform?: string}>('/system/info').catch(() => null),
      ]);
      const name = system?.platform === 'win32' ? 'powershell' : 'bash';
      setPanelTool((Array.isArray(list) ? list : []).find(x => x.name === name) ?? null);
    } catch {
      setPanelTool(null);
    }
  }, []);

  // ── 压缩对话上下文（旧版 compactChat：POST /compact + 系统消息反馈）──
  const addMessage = useChatStore((s) => s.addMessage);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  // 只读透视：子代理/系统会话仅可查看（输入区显示只读横幅）
  const isReadonlySession = /^(bg-task-|subagent-|cron-ai-)/.test(currentSessionId ?? '');
  const compactChat = useCallback(async () => {
    if (messages.length < 6) {
      addMessage({
        id: `sys-${Date.now()}`,
        role: 'system',
        content: wt('对话消息太少，无需压缩'),
        timestamp: Date.now(),
      });
      return;
    }
    // 当前无会话时不发请求
    if (!currentSessionId) {
      addMessage({
        id: `sys-${Date.now()}`,
        role: 'system',
        content: wt('当前无活跃会话，无法压缩'),
        timestamp: Date.now(),
      });
      return;
    }
    addMessage({
      id: `sys-${Date.now()}`,
      role: 'system',
      content: wt('正在压缩对话上下文...'),
      timestamp: Date.now(),
    });
    try {
      // 当前生效的对话模型（与 ChatInput 一致：general.defaultModel），读取失败不阻塞压缩
      let model = '';
      try {
        const g = await apiClient.get<Record<string, unknown>>('/config/general');
        const gv = (g as { value?: Record<string, unknown> })?.value ?? g;
        if (gv && typeof gv['defaultModel'] === 'string') model = gv['defaultModel'];
      } catch {
        /* 后端回退默认模型 */
      }
      const d = await apiClient.post<{
        success?: boolean;
        compacted?: boolean;
        tokensBefore?: number;
        tokensAfter?: number;
        saved?: number;
        error?: string;
      }>('/compact', { sessionId: currentSessionId, model });
      if (d?.success && d.compacted) {
        const pct = d.tokensBefore && d.saved ? Math.round((d.saved / d.tokensBefore) * 100) : 0;
        addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: wt('上下文压缩完成！节省了约 {{v0}}% 的token ({{v1}} → {{v2}})', {
            v0: pct,
            v1: d.tokensBefore,
            v2: d.tokensAfter,
          }),
          timestamp: Date.now(),
        });
      } else if (d?.success) {
        addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: wt('当前对话未达到压缩阈值，无需压缩'),
          timestamp: Date.now(),
        });
      } else {
        addMessage({
          id: `sys-${Date.now()}`,
          role: 'system',
          content: wt('压缩失败: ') + (d?.error || wt('未知错误')),
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      addMessage({
        id: `sys-${Date.now()}`,
        role: 'system',
        content: wt('压缩请求失败: ') + (e instanceof Error ? e.message : String(e)),
        timestamp: Date.now(),
      });
    }
  }, [messages.length, addMessage, currentSessionId]);

  const clearChat = useCallback(async () => {
    try {
      await clearConversation();
      setQueued([]);
    } catch (error) {
      toast.error(wt('清空对话失败'), error instanceof Error ? error.message : String(error));
    }
  }, [clearConversation]);

  const handleSend = useCallback(
    (content: string, attachments?: Attachment[], model?: string) => {
      // 流式期间发送 → 进入排队队列，本轮结束后自动发出（F 消息队列/steer）
      if (useChatStore.getState().isStreaming) {
        setQueued((q) => [...q, { content, attachments, model }]);
        return;
      }
      void sendMessage(content, attachments, model);
    },
    [sendMessage],
  );

  // 流式结束 → 自动发送队首消息
  useEffect(() => {
    if (!isStreaming && !isClearing && queued.length > 0) {
      const next = queued[0];
      setQueued((q) => q.slice(1));
      void sendMessage(next.content, next.attachments, next.model);
    }
  }, [isStreaming, isClearing, queued, sendMessage]);

  /** 排队消息条（可移除单条） */
  const queuedBar =
    queued.length > 0 ? (
      <div className="px-4 pb-1 flex flex-wrap gap-1 items-center shrink-0">
        <span className="text-xs opacity-50">{wt('排队中（本轮结束后自动发送）：')}</span>
        {queued.map((q, i) => (
          <span key={i} className="text-xs bg-gray-700 px-2 py-0.5 rounded flex items-center gap-1">
            <span className="max-w-[220px] truncate">{q.content}</span>
            <button
              className="text-red-400 ml-0.5"
              title={wt('移出队列')}
              onClick={() => setQueued((arr) => arr.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    ) : null;

  // 空会话：旧版居中欢迎区 + 3 个快捷按钮（外层挂右侧项目面板）
  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="sky-chat-workspace flex flex-row h-full w-full min-w-0 overflow-hidden">
        <div className="chat-view flex flex-col h-full flex-1 min-w-0 overflow-hidden">
          <GenerationHistory />
          <TaskWelcome />
          <ApprovalInlineStack />
          {queuedBar}
          <ChatInput
            onSend={handleSend}
            disabled={isClearing}
            onStop={() => { setQueued([]); stopStreaming(); }}
            stopping={isStopping}
            onCompact={() => void compactChat()}
            onClear={clearChat}
            onOpenToolPanel={() => void openToolPanel()}
            readonly={isReadonlySession}
          />
          <ToolPanelDrawer tool={panelTool} onClose={() => setPanelTool(null)} />
        </div>
        <ProjectPanel />
      </div>
    );
  }

  return (
    <div className="sky-chat-workspace flex flex-row h-full w-full min-w-0 overflow-hidden">
      <div className="chat-view flex flex-col h-full flex-1 min-w-0 overflow-hidden">
        <GenerationHistory />
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
        />
        <ApprovalInlineStack />
        {queuedBar}
        <ChatInput
          onSend={handleSend}
          onStop={() => { setQueued([]); stopStreaming(); }}
            stopping={isStopping}
          disabled={isStreaming || isClearing}
          onCompact={() => void compactChat()}
          onClear={clearChat}
          onOpenToolPanel={() => void openToolPanel()}
          readonly={isReadonlySession}
        />
        <ToolPanelDrawer tool={panelTool} onClose={() => setPanelTool(null)} />
      </div>
      <ProjectPanel />
    </div>
  );
}
