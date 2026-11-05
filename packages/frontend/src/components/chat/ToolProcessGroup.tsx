import { useState } from 'react';
import { MessageItem } from './MessageItem';
import { toolPresentation } from './tool-presentation';
import { useChatStore } from '@/stores/chat-store';
import type { ChatMessage } from '@/types';
import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';

export function ToolProcessGroup({items}: {items: Array<{message: ChatMessage; index: number}>}) {
  useWorkbenchLanguage();
  const calls = useChatStore(s => s.toolCalls);
  const [expanded, setExpanded] = useState(true);
  const titles = [...new Set(items.map(({message}) => {
    const call = calls[message.toolCallId ?? ''];
    return toolPresentation(call?.toolName ?? message.toolName ?? 'tool', call?.args, call?.result).title;
  }))];
  const running = items.some(({message}) => calls[message.toolCallId ?? '']?.status === 'running');
  const failed = items.some(({message}) => calls[message.toolCallId ?? '']?.status === 'error');
  return <section className={items.length > 1 ? 'tool-process-group' : 'tool-process-single'}>
    <button hidden={items.length < 2} className="tool-process-heading" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
      <span>{expanded ? '▾' : '▸'}</span>
      <span className="tool-process-summary">{titles.map(title => wt(title)).join('、')}</span>
      <span className="tool-process-count">{items.length}</span>
      {running ? <span className="tool-running-dot" aria-label={wt('运行中')} /> : failed ? <span className="tool-state-error">!</span> : null}
    </button>
    {/* Keep row instances mounted so user-opened details survive new events. */}
    <div hidden={!expanded} className={items.length > 1 ? 'tool-process-rows' : undefined}>
      {items.map(({message,index}) => <MessageItem key={message.id} message={message} index={index} />)}
    </div>
  </section>;
}
