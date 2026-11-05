// 消息列表（对齐旧版 renderChatView：p-4 space-y-4 普通滚动 + 流式气泡 typing-indicator）
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ToolProcessGroup } from './ToolProcessGroup';
import { useChatStore } from '@/stores/chat-store';
import { useAskUserStore } from '@/stores/ask-user-store';
import { useApprovalStore } from '@/stores/approval-store';
import { MessageItem } from './MessageItem';
import { MarkdownRenderer } from './MarkdownRenderer';
import { BackgroundTaskBar } from './BackgroundTaskBar';
import type { ChatMessage } from '@/types';

export interface MessageListProps {
  messages: ChatMessage[];
  streamingContent: string;
  isStreaming: boolean;
}

export function MessageList({ messages, streamingContent, isStreaming }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  // 是否自动跟随底部：用户向上滚动回看历史时暂停，滚回底部附近后恢复
  const autoFollowRef = useRef(true);
  // 上一次滚动位置（用于区分向上/向下滚动）
  const lastScrollTopRef = useRef(0);

  // 新消息或流式更新时滚动到底部（旧版 scrollBottom 行为）：
  // 仅当用户位于底部附近（未被暂停跟随）时才自动滚动，流式中也允许回看历史
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoFollowRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingContent, isStreaming]);

  // 流式中（无文本时也显示 typing 气泡，与旧版 chatStream||chatSending 一致）
  const calls = useChatStore(s => s.toolCalls);
  const sessionId = useChatStore(s => s.messagesSessionId);
  const waitingQuestion = useAskUserStore(s => s.requests.some(r => r.sessionId === sessionId));
  const waitingApproval = useApprovalStore(s => s.pendingApprovals.some(r => r.sessionId === sessionId));
  const runningTool = Object.values(calls).some(call => call.status === 'running');
  const textStreaming = messages.some(m => m.streaming);
  const showStreamBubble = isStreaming && !!streamingContent;
  const showWaiting = isStreaming && !streamingContent && !textStreaming && !runningTool && !waitingQuestion && !waitingApproval;
  const rows: Array<{kind: 'message'; message: ChatMessage; index: number} | {kind: 'tools'; items: Array<{message: ChatMessage; index: number}>}> = [];
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && !message.content && !message.attachments?.length) return;
    const previous = rows[rows.length - 1];
    if (message.role === 'tool') {
      if (previous?.kind === 'tools' && previous.items[0].message.turnId === message.turnId) previous.items.push({message,index});
      else rows.push({kind: 'tools', items: [{message,index}]});
    } else rows.push({kind: 'message', message, index});
  });

  return (
    <div
      className="chat-transcript flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin"
      ref={scrollRef}
      onWheel={(e) => {
        // 向上滚动：用户主动回看历史，立即暂停自动跟随
        if (e.deltaY < 0) autoFollowRef.current = false;
      }}
      onScroll={(e) => {
        const el = e.currentTarget;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
        const goingDown = el.scrollTop >= lastScrollTopRef.current;
        lastScrollTopRef.current = el.scrollTop;
        // 向下滚回底部附近时恢复跟随；离开底部区域时暂停
        if (goingDown && nearBottom) autoFollowRef.current = true;
        else if (!nearBottom) autoFollowRef.current = false;
      }}
    >
      {/* 后台任务状态卡（超长任务转后台执行的实时进度，background_task 事件驱动） */}
      <BackgroundTaskBar />
      {rows.map(row => row.kind === 'tools'
        ? <ToolProcessGroup key={row.items[0].message.id} items={row.items} />
        : <MessageItem key={row.message.id} message={row.message} index={row.index} streaming={row.message.streaming} showTimestamp={row.message.role === 'user' || (row.message.phase !== 'progress' && !row.message.streaming)} />)}
      {showStreamBubble ? (
        <div className="chat-msg-assistant md-content">
          <div>
            {streamingContent ? <MarkdownRenderer content={streamingContent} /> : null}
            <div className="typing-indicator mt-2">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      ) : null}
      {showWaiting ? <div className="chat-waiting" role="status" aria-label={t('common.loading')}><div className="typing-indicator"><span /><span /><span /></div></div> : null}
      {messages.length === 0 && !isStreaming ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 w-full min-h-[200px]">
          <div className="text-center">
            <h2 className="text-xl mb-2">{t('chat.welcome')}</h2>
            <p className="mb-4">{t('chat.welcomeDesc')}</p>
            <div className="flex flex-wrap gap-2 justify-center">
              <span className="text-xs text-gray-600">{t('chat.emptyState')}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
