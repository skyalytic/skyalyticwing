import type { LlmMessage } from '../types.js';

/** Restore protocol pairs after a crash without replaying a tool or claiming it never ran. */
export function recoverToolHistory(history: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push(message);
      const results = new Map<string, LlmMessage>();
      while (history[index + 1]?.role === 'tool') {
        const result = history[++index]!;
        if (result.toolCallId) results.set(result.toolCallId, result);
      }
      for (const call of message.toolCalls) {
        out.push(
          results.get(call.id) ?? {
            role: 'tool',
            toolCallId: call.id,
            content:
              'Execution result unknown after interruption. Inspect existing files, processes or remote state before retrying. Do not assume the operation was never executed.',
          },
        );
        results.delete(call.id);
      }
      for (const result of results.values())
        out.push({
          role: 'assistant',
          content: `Recovered unpaired tool result (${result.toolCallId}): ${typeof result.content === 'string' ? result.content : JSON.stringify(result.content)}`,
        });
    } else if (message.role === 'tool') {
      out.push({
        role: 'assistant',
        content: `Recovered unpaired tool result (${message.toolCallId}): ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`,
      });
    } else out.push(message);
  }
  return out;
}
