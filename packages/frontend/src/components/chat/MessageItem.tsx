import { deduplicateAttachments } from '@skyalyticwing/shared';
import { workbenchLocale } from '@/i18n/workbench-text';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 单条消息（对齐旧版 renderChatView 的气泡结构：用户右侧 / 助手左侧 md 气泡 + 时间戳）
// 消息操作栏（hover 显示，对齐参考形态）：时间 + 复制 + 删除；
// 用户消息额外提供"回退到本轮对话发起前"（截断本轮 + 恢复该轮 AI 写过的文件）
// 与"分叉新会话"（复制该时刻前的消息，形成独立会话分支）
import { memo, useState } from 'react';
import { useWorkspaceTabs } from '@/stores/workspace-tab-store';
import { useNavigate } from 'react-router-dom';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCallDisplay } from './ToolCallDisplay';
import { Icon } from '@/components/Icon';
import { isContextAttachment } from '@/services/context-reference';
import { BrowserAnnotationChip } from './BrowserAnnotationChip';
import { toast } from '@/components/ui/Toast';
import { formatTime } from '@/utils/format';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useProjectPanel } from '@/stores/project-panel-store';
import { apiClient } from '@/services/api-client';
import type { Attachment, ChatMessage, ToolResult } from '@/types';
import { ImageAttachment } from '@/components/project/ImagePreview';

export interface MessageItemProps {
  message: ChatMessage;
  /** 消息在列表中的下标（回退本轮需要截断位置） */
  index?: number;
  streaming?: boolean;
  showTimestamp?: boolean;
  onQuickReply?: (text: string) => void;
}

/** 解析 ask_user 工具参数（string | object） */
function parseAskUserArgs(args: unknown): { question: string; options?: string[] } | null {
  try {
    const obj = typeof args === 'string' ? JSON.parse(args) : args;
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as { question?: unknown }).question === 'string'
    ) {
      const o = obj as { question: string; options?: unknown };
      return {
        question: o.question,
        options: Array.isArray(o.options) ? o.options.map(String) : undefined,
      };
    }
  } catch {
    /* 非法 JSON 忽略 */
  }
  return null;
}

/** 附件渲染（旧版：图片缩略 / 视频播放 / 音频播放 / 文件 chip + 下载）
 *  间距由 .chat-attachments 的 gap 控制（勿加 space-y-*：margin 与 flex-wrap 叠加会错位）
 *  工程模式联动：附件带本地路径（path）时点击 → 右侧项目面板预览 */
function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  useWorkbenchLanguage();
  const openFile = (path: string) => {
    useWorkspaceTabs.getState().openTab('editor');
    useProjectPanel.getState().openFile(path);
  };
  return (
    <div className="chat-attachments mt-2">
      {deduplicateAttachments(attachments).map((att, i) => {
        if (isContextAttachment(att)) return <BrowserAnnotationChip key={i} attachment={att} />;
        const src = att.url || att.path || '';
        const mime = att.mimeType || '';
        if (att.type === 'image' || mime.startsWith('image/')) {
          return (
            <div className="chat-attachment-image" key={i}>
              <ImageAttachment
                src={src}
                name={att.name || 'image'}
                filePath={att.path}
                className="max-w-full rounded border border-gray-600 cursor-pointer"
              />
            </div>
          );
        }
        if (att.type === 'video' || mime.startsWith('video/')) {
          return (
            <div className="chat-attachment-video" key={i}>
              <video
                controls
                preload="metadata"
                className="max-w-full rounded border border-gray-600"
                style={{ maxHeight: 400 }}
                src={src}
              />
            </div>
          );
        }
        if (att.type === 'audio' || mime.startsWith('audio/')) {
          return (
            <div className="chat-attachment-audio bg-gray-700 rounded p-2" key={i}>
              <audio controls preload="metadata" src={src} className="w-full" />
              <span className="text-xs text-gray-400 ml-2">{att.name || 'audio'}</span>
            </div>
          );
        }
        const safeHref = /^(https?:|data:image\/(png|jpeg|gif|webp)|\/api\/files\/serve\?)/i.test(
          src,
        )
          ? src
          : '#';
        return (
          <div
            className="chat-attachment-file bg-gray-700 rounded p-2 flex items-center gap-2"
            key={i}
          >
            <span className="text-gray-300 flex items-center gap-1">
              <Icon name="file" size={14} /> {att.name || 'file'}
            </span>
            {att.path ? (
              <button
                className="text-blue-400 text-xs hover:underline"
                onClick={() => openFile(att.path!)}
                title={wt('在右侧项目面板中预览')}
              >
                {wt('预览')}
              </button>
            ) : null}
            <a
              href={safeHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 text-xs hover:underline"
            >
              {wt('下载')}
            </a>
          </div>
        );
      })}
    </div>
  );
}

/** 消息操作图标按钮（hover 显隐由父级 group 控制） */
function MsgAction({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  useWorkbenchLanguage();
  return (
    <Icon
      name={icon}
      size={13}
      title={title}
      onClick={onClick}
      className="cursor-pointer opacity-60 hover:opacity-100"
    />
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  index,
  streaming = false,
  showTimestamp = true,
}: MessageItemProps) {
  const { role, content, timestamp, toolName } = message;
  const isUser = role === 'user';
  const generationPending =
    role === 'assistant' &&
    content ===
      '生成任务的提交结果待核实，已暂停后续生成。请查询原任务，不要重新提交，以免重复扣费。';
  const isSystem = role === 'system' || (message as { isSystem?: boolean }).isSystem;
  const time = timestamp ? new Date(timestamp).toLocaleTimeString(workbenchLocale()) : '';

  // 订阅该工具调用的实时状态（selector 精确订阅：仅该 callId 状态变化才触发重渲染）
  const toolCall = useChatStore((s) =>
    message.toolCallId ? s.toolCalls[message.toolCallId] : undefined,
  );
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const truncateFromIndex = useChatStore((s) => s.truncateFromIndex);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const forkSession = useSessionStore((s) => s.forkSession);
  const navigate = useNavigate();
  const [rolling, setRolling] = useState(false);

  const copyContent = () => {
    void navigator.clipboard
      .writeText(content)
      .then(() => toast.success(wt('已复制')))
      .catch(() => toast.error(wt('复制失败')));
  };

  /** 从这条消息分叉出新会话（复制该时刻前的全部消息，原会话不受影响） */
  const forkFromHere = async () => {
    if (!currentSessionId) {
      toast.error(wt('当前无活跃会话，无法分叉'));
      return;
    }
    const newId = await forkSession(currentSessionId, timestamp);
    if (newId) {
      toast.success(wt('已分叉出新会话'));
      navigate('/');
    }
  };

  /** 回退到本轮对话发起前：恢复本轮及之后的文件修改，再截断对应消息。 */
  const rollbackRound = () => {
    if (rolling || streaming) return;
    if (useChatStore.getState().isStreaming) {
      toast.error(wt('AI 正在回复中，请等待本轮完成后再回退'));
      return;
    }
    setRolling(true);
    apiClient
      .post<{ restored?: string[] }>('/files/rollback', {
        sessionId: currentSessionId ?? '',
        sinceTs: timestamp,
      })
      .then((d) => {
        const n = d?.restored?.length ?? 0;
        if (typeof index === 'number') truncateFromIndex(index);
        // 回滚改写了磁盘文件：退出预览并强制文件树重新加载
        useProjectPanel.getState().showTree();
        useProjectPanel.getState().bumpTreeVersion();
        toast.success(
          n > 0
            ? wt('已回退至本轮开始前，并恢复 {{v0}} 个文件', { v0: n })
            : wt('已回退至本轮开始前'),
        );
      })
      .catch((e) => toast.error(wt('回退失败'), e instanceof Error ? e.message : undefined))
      .finally(() => setRolling(false));
  };

  // ── 用户消息：右侧对齐 + 附件 + hover 操作栏（复制/删除/回退本轮） ──
  if (isUser) {
    return (
      <div className="group">
        <div className="chat-msg-user">
          <div className="wing-user-bubble">
            {message.attachments?.filter(isContextAttachment).map((ma, k) => (
              <span className="wing-user-reference" key={k}>
                <BrowserAnnotationChip attachment={ma} />
              </span>
            ))}
            {content ? <span className="wing-user-text">{content}</span> : null}
            {message.attachments && message.attachments.length > 0 ? (
              <div className="wing-user-files">
                {message.attachments
                  .filter((ma) => !isContextAttachment(ma))
                  .map((ma, k) =>
                    ma.type === 'image' || (ma.mimeType || '').startsWith('image/') ? (
                      <ImageAttachment
                        key={k}
                        src={ma.url || ma.path || ''}
                        filePath={ma.path}
                        className="max-w-xs rounded mt-1 border border-gray-600"
                        name={ma.name || 'image'}
                      />
                    ) : (
                      <span
                        key={k}
                        className="text-xs bg-gray-700 px-2 py-1 rounded mt-1 inline-flex items-center gap-1"
                      >
                        <Icon name="file" size={14} /> {wt('[附件]')}
                        {ma.name || ma.mimeType || 'file'}
                      </span>
                    ),
                  )}
              </div>
            ) : null}
          </div>
        </div>
        {showTimestamp && time ? (
          <div className="msg-timestamp text-right flex items-center justify-end gap-1.5">
            <span>{time}</span>
            <span className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <MsgAction icon="copy" title={wt('复制')} onClick={copyContent} />
              <MsgAction
                icon="trash"
                title={wt('删除这条消息')}
                onClick={() => deleteMessage(message.id)}
              />
              <MsgAction
                icon="worktree"
                title={wt('从这条消息分叉新会话（Fork）')}
                onClick={() => void forkFromHere()}
              />
              <MsgAction
                icon="corner-up-left"
                title={wt('撤销本轮及之后的对话和文件修改')}
                onClick={() => void rollbackRound()}
              />
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  // ── 工具角色消息：保留工具执行结果展示（新版功能，不丢失） ──
  if (role === 'tool' || toolName) {
    // 本会话工具调用：透传 store 中的真实状态与结果（running/success/error 实时更新）
    if (toolCall) {
      return (
        <ToolCallDisplay
          name={toolCall.toolName}
          args={toolCall.args}
          result={toolCall.result}
          status={toolCall.status}
        />
      );
    }
    // 历史消息（无实时状态）：按消息内容兜底展示，状态由 result 推导
    let toolResult: ToolResult = {
      success: !/^(Tool call (rejected|blocked)|Not executed:)/i.test(content),
      output: typeof content === 'string' ? content : String(content),
    };
    try {
      const stored = JSON.parse(content);
      if (stored && typeof stored === 'object' && typeof stored.success === 'boolean')
        toolResult = stored;
    } catch {
      /* Legacy plain-text tool result. */
    }
    return <ToolCallDisplay name={toolName ?? 'tool'} result={toolResult} />;
  }

  // ── 助手 / 系统消息（旧版 space-y-2 结构 + hover 操作栏：复制/删除） ──
  return (
    <div className="space-y-2 group">
      {isSystem ? (
        <div className={`chat-turn-status ${message.turnStatus === "failed" ? "error" : ""}`} role={message.turnStatus === "failed" ? "alert" : undefined}>{content}</div>
      ) : content ? (
        <div className={`chat-msg-assistant md-content${streaming ? ' stream-cursor' : ''}`}>
          <div>
            <MarkdownRenderer
              content={generationPending ? wt(content) : content}
            />
          </div>
        </div>
      ) : null}

      {message.attachments && message.attachments.length > 0 ? (
        <AttachmentList attachments={message.attachments} />
      ) : null}

      {showTimestamp && time && !isSystem ? (
        <div className="msg-timestamp flex items-center gap-1.5">
          <span>{time}</span>
          <span className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <MsgAction icon="copy" title={wt('复制')} onClick={copyContent} />
            <MsgAction
              icon="trash"
              title={wt('删除这条消息')}
              onClick={() => deleteMessage(message.id)}
            />
          </span>
        </div>
      ) : null}
    </div>
  );
});

export { parseAskUserArgs };
