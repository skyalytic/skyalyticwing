import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { apiFetch } from './http.js';
import type { TurnEvent } from './commands/run.js';

/** Direct tools use the same backend approvals as AI turns. Never silently wait without a CLI prompt. */
export async function watchToolApprovals(
  base: string,
  sessionId: string,
  signal: AbortSignal,
  approve?: (event: TurnEvent) => Promise<string>,
) {
  const seen = new Set<string>();
  while (!signal.aborted) {
    try {
      const response = await apiFetch<
        Array<{ id: string; sessionId: string; toolName: string; reason?: string }>
      >(base, '/api/approvals', { signal });
      for (const request of response.data ?? []) {
        if (request.sessionId !== sessionId || seen.has(request.id)) continue;
        seen.add(request.id);
        let decision = 'denied';
        if (approve) {
          let onAbort: (() => void) | undefined;
          try {
            decision = await Promise.race([
              approve({ type: 'approval_request', request }),
              new Promise<string>((resolve) => {
                onAbort = () => resolve('denied');
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) onAbort();
              }),
            ]);
          } finally {
            if (onAbort) signal.removeEventListener('abort', onAbort);
          }
        } else if (process.stdin.isTTY) {
          const readline = createInterface({ input: process.stdin, output: process.stderr });
          try {
            const answer = await readline.question(
              `${request.reason ?? request.toolName}\n允许本次执行？[y/N] `,
              { signal },
            );
            decision = /^(y|yes)$/i.test(answer.trim()) ? 'allow-once' : 'denied';
          } finally {
            readline.close();
          }
        } else
          console.error(
            `需要审批：${request.toolName}。当前非交互调用未自动批准；请使用交互终端或已授权的权限模式。`,
          );
        if (!signal.aborted)
          await apiFetch(base, `/api/approvals/${encodeURIComponent(request.id)}`, {
            method: 'POST',
            body: { decision },
            signal,
          });
      }
      await delay(500, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      console.error(`审批状态读取失败：${String(error)}。可在 Wing 中处理审批。`);
      try {
        await delay(2000, undefined, { signal });
      } catch {
        return;
      }
    }
  }
}
