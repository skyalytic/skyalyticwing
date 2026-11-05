import { nativeInvoke } from '@/services/native-browser';
import { isTauri } from '@/services/tauri-bridge';
import { wt } from '@/i18n/workbench-text';
// WebSocket hook：连接管理、事件订阅，自动更新 stores
import { useEffect } from 'react';
import { wsClient } from '@/services/ws-client';
import { apiClient } from '@/services/api-client';
import { useConnectionStore } from '@/stores/connection-store';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore, sessionChat } from '@/stores/chat-store';
import { useApprovalStore } from '@/stores/approval-store';
import { useProjectPanel } from '@/stores/project-panel-store';
import { useAskUserStore, type AskUserRequest } from '@/stores/ask-user-store';
import { toast } from '@/components/ui/Toast';
import { genId } from '@/utils/format';
import type { ConnectionStatus, WsEvent } from '@/types';

export interface UseWebSocketReturn {
  status: ConnectionStatus;
  reconnectAttempts: number;
  reconnect: () => void;
}

const acceptsSession = (id?: string): boolean => !!id && (
  useSessionStore.getState().currentSessionId === id || !!useChatStore.getState().sessions[id]
);

const ownsCurrentTurn = (sessionId: string, turnId?: string) => {
  if (!turnId) return true;
  const lastUser = [...sessionChat(useChatStore.getState(), sessionId).messages].reverse().find(m => m.role === 'user');
  return !lastUser?.turnId || lastUser.turnId === turnId;
};

/** 在应用根节点调用一次，建立连接并将事件路由到各 store */
export function useWebSocket(): UseWebSocketReturn {
  const status = useConnectionStore((s) => s.status);
  const reconnectAttempts = useConnectionStore((s) => s.reconnectAttempts);
  const setStatus = useConnectionStore((s) => s.setStatus);
  const setReconnectAttempts = useConnectionStore((s) => s.setReconnectAttempts);
  const markConnected = useConnectionStore((s) => s.markConnected);
  // Keep active/visited sessions subscribed so switching tabs never drops their events.
  useEffect(() => {
    const subscribed = new Set<string>();
    const subscribe = () => {
      if (wsClient.getStatus() !== 'connected') return;
      const ids = new Set(Object.keys(useChatStore.getState().sessions));
      const current = useSessionStore.getState().currentSessionId;
      if (current) ids.add(current);
      for (const id of subscribed) if (!ids.has(id)) {
        wsClient.send('unsubscribe', {sessionId: id}); subscribed.delete(id);
      }
      for (const id of ids) if (!subscribed.has(id)) {
        wsClient.send('subscribe', {sessionId: id}); subscribed.add(id);
      }
    };
    subscribe();
    const offChat = useChatStore.subscribe(subscribe);
    const offSession = useSessionStore.subscribe(subscribe);
    const offStatus = wsClient.onStatus(status => {
      if (status === 'connected') { subscribed.clear(); subscribe(); }
    });
    return () => { offChat(); offSession(); offStatus(); };
  }, []);

  useEffect(() => {
    // 订阅连接状态
    let askRevision = 0;
    let disposed = false;
    const restoreQuestions = async () => {
      const revision = ++askRevision;
      try {
        const pending = await apiClient.get<AskUserRequest[]>('/tools/ask-user/pending');
        if (!disposed) {
          if (revision === askRevision) useAskUserStore.getState().sync(pending ?? []);
          else void restoreQuestions();
        }
      } catch { /* Keep existing questions on temporary network failure. */ }
    };
    const unsubStatus = wsClient.onStatus((s, attempts) => {
      setStatus(s);
      setReconnectAttempts(attempts);
      if (s === 'connected') { markConnected(); void restoreQuestions(); }
    });

    // 订阅各类事件并路由到对应 store
    const unsubs: Array<() => void> = [unsubStatus];

    // chat_message：完整消息
    unsubs.push(
      wsClient.on('chat_message', (event: WsEvent) => {
        if (event.type !== 'chat_message') return;
        // 跨会话过滤：仅接受当前会话的消息（多会话并行生成时防串扰）
        const eventSession = (event.data as { sessionId?: string } | null | undefined)?.sessionId;
        if (!acceptsSession(eventSession)) return;
        const store = useChatStore.getState();
        // 非流式链路（POST /chat/send → chatService.sendMessage）只在结束时
        // 广播一条 assistant chat_message，此时必须结束流式状态，
        // 否则 isStreaming 永久卡 true、输入框被禁用
        if (event.data?.role === 'assistant' || event.data?.phase === 'status') {
          useProjectPanel.getState().bumpTreeVersion();
          // assistant 最终消息（可携带生成媒体 attachments）可能与 chat_stream done
          // 本地落库 / POST /chat/send 响应重复送达同一条，统一经
          // settleAssistantMessage 合并去重，防止重复追加
          store.settleAssistantMessage(event.data, eventSession);
          if (event.data.phase !== 'progress' && event.data.phase !== 'status' && ownsCurrentTurn(eventSession!, event.data.turnId))
            useChatStore.getState().clearStream(eventSession);
        } else {
          store.addMessage(event.data, eventSession);
        }
      }),
    );

    // chat_stream：流式增量
    unsubs.push(
      wsClient.on('chat_stream', (event: WsEvent) => {
        if (event.type !== 'chat_stream') return;
        // 跨会话过滤：仅接受当前会话的流式帧
        const eventSession = (event.data as { sessionId?: string } | null | undefined)?.sessionId;
        if (!acceptsSession(eventSession)) return;
        const { content, done } = event.data;
        const store = useChatStore.getState();
        if (event.data.message && !done) {
          // Stable message snapshots replace the same row as it streams and settles.
          store.settleAssistantMessage(event.data.message, eventSession);
          return;
        }
        if (!done) store.setStreaming(true, eventSession);
        if (content) store.appendStream(content, eventSession);
        if (done) {
          useProjectPanel.getState().bumpTreeVersion();
          // Completion reuses the persisted message ID; never invent a second final message.
          const fresh = useChatStore.getState();
          if (event.data.message) fresh.settleAssistantMessage(event.data.message, eventSession);
          if (ownsCurrentTurn(eventSession!, event.data.message?.turnId)) fresh.clearStream(eventSession);
        }
      }),
    );

    // tool_call：登记工具调用状态，并落一条 tool 角色消息
    unsubs.push(
      wsClient.on('tool_call', (event: WsEvent) => {
        if (event.type !== 'tool_call') return;
        if (!acceptsSession(event.data.sessionId)) return;
        const { toolName, args, callId } = event.data;
        const store = useChatStore.getState();
        store.startToolCall(callId, toolName, args, event.data.sessionId);
        // 同一 callId 仅落一条消息（去重）
        if (!sessionChat(store, event.data.sessionId!).messages.some((m) => m.toolCallId === callId || m.id === `tool-${callId}`)) {
          store.addMessage({
            sessionId: event.data.sessionId,
            id: `tool-${callId}`,
            turnId: event.data.turnId,
            turnSequence: event.data.turnSequence,
            role: 'tool',
            toolName,
            toolCallId: callId,
            content: '',
            timestamp: Date.now(),
          });
        }
      }),
    );

    // tool_result：更新工具结果
    unsubs.push(
      wsClient.on('tool_result', (event: WsEvent) => {
        if (event.type !== 'tool_result') return;
        if (!acceptsSession(event.data.sessionId)) return;
        const { toolName, result, callId } = event.data;
        useChatStore.getState().finishToolCall(callId, toolName, result, event.data.sessionId);
        // Scripts and plugins may change files, including before returning an error.
        if (event.data.sessionId === useSessionStore.getState().currentSessionId) useProjectPanel.getState().bumpTreeVersion();
      }),
    );

    // background_task：后台任务进度/状态（超长任务转后台执行，实时更新任务卡；
    // 完成时的结果回流走 chat_message + notification，此处只维护任务状态）
    unsubs.push(
      wsClient.on('background_task', (event: WsEvent) => {
        if (event.type !== 'background_task') return;
        const data = event.data;
        // 跨会话过滤：仅展示当前会话的后台任务
        if (!acceptsSession(data.sessionId)) return;
        useChatStore.getState().updateBackgroundTask(data);
      }),
    );

    // notification：系统通知（后台任务完成/失败、notify 工具等后端主动推送）
    unsubs.push(
      wsClient.on('notification', (event: WsEvent) => {
        if (event.type !== 'notification') return;
        const { title, message, level } = event.data;
        if (level === 'error') toast.error(title, message);
        else if (level === 'warn') toast.warn(title, message);
        else toast.info(title, message);
      }),
    );

    // agent_message：代理消息通知
    unsubs.push(
      wsClient.on('agent_message', (event: WsEvent) => {
        if (event.type !== 'agent_message') return;
        const { fromName, from, content } = event.data;
        toast.info(wt('代理消息 · {{v0}}', { v0: fromName || from }), content.slice(0, 120));
      }),
    );

    // subagent_completed：子代理完成通知
    unsubs.push(
      wsClient.on('subagent_completed', (event: WsEvent) => {
        if (event.type !== 'subagent_completed') return;
        const { agentId, result } = event.data;
        toast.success(wt('子代理已完成'), `${agentId}：${result.slice(0, 120)}`);
      }),
    );

    // approval_request：工具审批（内嵌审批卡渲染于对话流，见 ApprovalInlineCard；
    // 用户停留在其他页面时以 toast 提醒前往对话处理）
    unsubs.push(
      wsClient.on('approval_resolved', (event: WsEvent) => {
        if (event.type === 'approval_resolved') useApprovalStore.getState().removeApproval(event.data.id);
      }),
      wsClient.on('approval_request', (event: WsEvent) => {
        if (event.type !== 'approval_request') return;
        useApprovalStore.getState().addApproval(event.data);
        if (isTauri()) void nativeInvoke('desktop_surface', { surface: 'approval', visible: true }).catch(() => toast.error(wt('桌面审批窗口未能打开，请返回 Wing 处理')));
        toast.info(
          wt('工具审批请求 · {{v0}}', { v0: event.data.toolName }),
          wt('请在置顶审批窗口或对话中的审批卡处理'),
        );
      }),
    );

    // ask_user_request：Agent 向用户提问（shared WsEvent 联合类型暂未收录
    // 该契约事件，此处本地断言窄化；后端收录后类型自然对齐）
    unsubs.push(
      wsClient.on('ask_user_request', (event: WsEvent) => {
        const e = event as unknown as { type: 'ask_user_request'; data: AskUserRequest };
        if (e.type !== 'ask_user_request') return;
        askRevision++;
        useAskUserStore.getState().show(e.data);
        if (e.data.sessionId && e.data.sessionId !== useSessionStore.getState().currentSessionId)
          toast.info(wt('有对话正在等待你的回答'), e.data.question);
      }),
    );

    unsubs.push(wsClient.on('ask_user_resolved', (event: WsEvent) => {
      const e = event as unknown as { data: { id: string } };
      askRevision++;
      useAskUserStore.getState().remove(e.data.id);
    }));
    if (wsClient.getStatus() === 'connected') void restoreQuestions();
    unsubs.push(() => { disposed = true; });

    // error：通知
    unsubs.push(
      wsClient.on('error', (event: WsEvent) => {
        if (event.type !== 'error') return;
        console.error('[ws error]', event.data);
      }),
    );

    // ── 后端已发送但前端此前未订阅的事件（接线补齐） ──────────────────────

    // show_message：AI 经 show_message 工具主动向用户展示消息
    unsubs.push(
      wsClient.on('show_message', (event: WsEvent) => {
        if (event.type !== 'show_message') return;
        const { title, message, messageType } = event.data;
        if (messageType === 'error') toast.error(title, message);
        else if (messageType === 'warning') toast.warn(title, message);
        else if (messageType === 'success') toast.success(title, message);
        else toast.info(title, message);
      }),
    );

    // file_offer：send_file_to_user 工具的文件卡片（后端 ctx.broadcast 此前是
    // 空壳，事件从未真正到达前端——已接线广播）。
    // 工程模式联动：文件卡片落入对话流（点击即右侧项目面板预览）
    unsubs.push(
      wsClient.on('file_offer', (event: WsEvent) => {
        if (event.type !== 'file_offer') return;
        const offeredSession = event.data.sessionId;
        if (!acceptsSession(offeredSession)) return;
        if (useChatStore.getState().clearingSessionId === offeredSession) return;
        const { filename, size, caption, file } = event.data as {
          filename?: string;
          size?: number;
          caption?: string;
          file?: string;
        };
        const kb = Math.round((size || 0) / 1024);
        // 文件卡片消息：点击附件 → 右侧项目面板打开预览（openFile）
        if (file) {
          useChatStore.getState().settleAssistantMessage({
            id: genId('file-offer'),
            ...(offeredSession ? { sessionId: offeredSession } : {}),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            attachments: [
              {
                type: 'file',
                name: filename || file.split(/[\\/]/).pop() || 'file',
                mimeType: '',
                size: size || 0,
                path: file,
                url: `/api/files/serve?path=${encodeURIComponent(file)}`,
              },
            ],
          });
        }
        toast.info(
          wt('文件已发送'),
          wt('{{v0}} ({{v1}}KB){{v2}}，点击对话中的文件卡片预览', {
            v0: filename,
            v1: kb,
            v2: caption ? ` — ${caption}` : '',
          }),
        );
      }),
    );

    // session_restored：会话恢复完成（崩溃后自动恢复历史）
    unsubs.push(
      wsClient.on('session_restored', (event: WsEvent) => {
        if (event.type !== 'session_restored') return;
        toast.success(
          wt('会话已恢复'),
          wt('已恢复 {{v0}} 条历史消息', { v0: event.data.messageCount }),
        );
      }),
    );

    // isolated_agent_completed：隔离子代理执行完成
    unsubs.push(
      wsClient.on('isolated_agent_completed', (event: WsEvent) => {
        if (event.type !== 'isolated_agent_completed') return;
        const { sessionId, output, durationMs } = event.data;
        const sec = Math.round(durationMs / 1000);
        const preview = (output || '').slice(0, 120);
        // 仅当前会话的隔离代理才强提醒，其他会话的轻提示
        if (sessionId === useSessionStore.getState().currentSessionId) {
          toast.success(wt('隔离代理已完成（{{v0}}s）', { v0: sec }), preview);
        } else {
          toast.info(wt('隔离代理已完成'), preview);
        }
      }),
    );

    // cron_updated：定时任务配置变更（CronPage 此前只能手动刷新）
    unsubs.push(
      wsClient.on('cron_updated', (event: WsEvent) => {
        if (event.type !== 'cron_updated') return;
        const { jobId, action } = event.data;
        const label =
          action === 'created' ? wt('已创建') : action === 'deleted' ? wt('已删除') : wt('已更新');
        toast.info(
          wt('定时任务变更'),
          wt('任务 {{v0}} {{v1}}，可在定时任务页查看最新列表', { v0: jobId, v1: label }),
        );
      }),
    );

    // channel_message：渠道入站消息（ChannelsPage 此前仅 REST 轮询）
    unsubs.push(
      wsClient.on('channel_message', (event: WsEvent) => {
        if (event.type !== 'channel_message') return;
        const { channel, content, sender } = event.data;
        toast.info(
          wt('渠道消息 · {{v0}}', { v0: channel }),
          `${sender}: ${(content || '').slice(0, 120)}`,
        );
      }),
    );

    // channel_status：渠道连接状态变化
    unsubs.push(
      wsClient.on('channel_status', (event: WsEvent) => {
        if (event.type !== 'channel_status') return;
        const { channel, status } = event.data;
        const ok = status === 'connected' || status === 'ok' || status === 'active';
        if (ok) toast.success(wt('渠道已连接'), `${channel}: ${status}`);
        else toast.warn(wt('渠道状态变化'), `${channel}: ${status}`);
      }),
    );

    // tools_refresh / permissions_refresh：审批决策落盘后服务端通知刷新
    //（审批后规则/工具状态变化；审批历史即时刷新，工具与权限列表由设置页自拉）
    const refreshApprovalState = (): void => {
      void useApprovalStore.getState().loadApprovalsHistory();
    };
    unsubs.push(
      wsClient.on('tools_refresh', (event: WsEvent) => {
        if (event.type === 'tools_refresh') { refreshApprovalState(); window.dispatchEvent(new Event('sky-tools-changed')); }
      }),
    );
    unsubs.push(
      wsClient.on('permissions_refresh', (event: WsEvent) => {
        if (event.type === 'permissions_refresh') { refreshApprovalState(); window.dispatchEvent(new Event('sky-permissions-changed')); }
      }),
    );

    // health：仅记录
    unsubs.push(
      wsClient.on('health', (event: WsEvent) => {
        if (event.type === 'health') {
          // 健康检查可在此扩展
        }
      }),
    );

    // 建立连接
    wsClient.connect();

    return () => {
      for (const unsub of unsubs) unsub();
      wsClient.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconnect = () => wsClient.reconnect();

  return { status, reconnectAttempts, reconnect };
}
