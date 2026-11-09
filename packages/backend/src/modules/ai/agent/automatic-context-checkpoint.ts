import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@skyalyticwing/shared';
import type { LlmMessage } from '../types.js';
import { compactContext, historyExcerpt, microcompactContext } from './context-compaction.js';

/** Request-local additions (memory, screenshots, system policy) must not become durable history. */
export class AutomaticContextCheckpoint {
  private readonly sources = new WeakMap<LlmMessage, { record: ChatMessage; clean: LlmMessage }>();
  private readonly transient = new WeakSet<LlmMessage>();

  track(message: LlmMessage, record: ChatMessage): void {
    this.sources.set(message, { record: structuredClone(record), clean: { ...message } });
  }

  ephemeral(message: LlmMessage): void {
    this.transient.add(message);
  }

  microcompact(messages: LlmMessage[]): LlmMessage[] {
    const result = microcompactContext(messages);
    for (let i = 0; i < result.length; i++) {
      if (result[i] === messages[i]) continue;
      const source = this.sources.get(messages[i]!);
      if (source)
        this.track(result[i]!, { ...source.record, content: result[i]!.content as string });
    }
    return result;
  }

  compact(messages: LlmMessage[], keepRecent: number): LlmMessage[] {
    return compactContext(
      messages,
      keepRecent,
      (history) =>
        historyExcerpt(
          history
            .filter((message) => !this.transient.has(message))
            .map((message) => this.sources.get(message)?.clean ?? message),
        ),
      (message) => this.transient.has(message),
    );
  }

  records(messages: LlmMessage[]): ChatMessage[] {
    return messages
      .filter((message) => message.role !== 'system' && !this.transient.has(message))
      .map((message) => {
        const source = this.sources.get(message);
        if (source) return structuredClone(source.record);
        // Recovered tool receipts and live text results have no original attachment payload.
        if (typeof message.content !== 'string')
          throw new Error('Untracked multipart context cannot be checkpointed');
        return { ...message, content: message.content, id: randomUUID(), timestamp: Date.now() };
      });
  }
}
