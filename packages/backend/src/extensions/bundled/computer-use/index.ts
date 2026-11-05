import type { ExtensionHost, ExtensionInstance } from '../../host-api.js';
import { createComputerUseTool } from './tool.js';
import { DesktopControlService } from '../../../modules/automation/desktop-control.service.js';
import { AskUserService } from '../../../modules/tools/executor/ask-user.service.js';
import { SkyRepl } from './runtime/sky-repl.js';
import { archiveDesktopObservation } from './runtime/desktop-observation-archive.js';
export function activate(host: ExtensionHost): ExtensionInstance {
  let used = false, repl: SkyRepl | undefined;
  const control = () => { const value = host.resolve(DesktopControlService); if (!value) throw new Error('Desktop control host unavailable'); return value; };
  const kernel = () => { used = true; return repl ||= new SkyRepl(control()); };
  const legacy = createComputerUseTool(host.resolve);
  const windowsTools: ExtensionInstance["tools"] = [
    { name: 'node_repl', description: 'Persistent Computer Use JavaScript session. Read the bundled Computer Use guide; import @oai/sky, use returned windows, inspect snapshots, and perform one state-derived input per cell. nodeRepl.write accepts strings. Each conversation has independent state.', category: 'interactive', dangerous: true,
      parameters: { type: 'object', properties: { code: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['code'] },
      execute: async (args, ctx) => { const a = args as { code: string; timeout_ms?: number }; return archiveDesktopObservation(await kernel().run(a.code, ctx, a.timeout_ms), ctx.sessionId); } },
    { name: 'node_repl_reset', description: 'End this conversation Computer Use JavaScript session; pending input is interrupted and observations invalidated. Reinitialize before continuing.', category: 'interactive', dangerous: false,
      parameters: { type: 'object', properties: {} }, execute: async (_args, ctx) => { repl?.reset(ctx.sessionId); return { success: true }; } },
    { name: 'computer_use_confirm', description: 'Wait for the user without an execution timeout. Use purpose=user_step when the user must complete phone verification, login, or restore an app; do not end the task as blocked while awaiting them. Use action_confirmation for the bundled confirmations policy, including exact action, recipient/destination and content. Cancellation is not approval. After any reply, refresh windows and observe again.', category: 'interactive', dangerous: false,
      parameters: { type: 'object', properties: { question: { type: 'string' }, purpose: { type: 'string', enum: ['action_confirmation', 'user_step'] } }, required: ['question'] }, execute: async (args, ctx) => {
        const service = host.resolve(AskUserService); if (!service) return { success: false, error: 'Confirmation service unavailable' };
        const a = args as { question: string; purpose?: string };
        if (!a.question?.trim() || (a.purpose !== undefined && !['action_confirmation', 'user_step'].includes(a.purpose))) return { success: false, error: 'Invalid confirmation question or purpose' };
        const purpose = a.purpose || 'action_confirmation';
        // Hand the desktop back while the human acts. Discard pre-verification
        // observations, including when the reply is cancellation or the task stops.
        const desktop = control(); desktop.invalidateSky(ctx.sessionId);
        try {
          const result = await service.askUser({ sessionId: ctx.sessionId, question: a.question,
            ...(purpose === 'action_confirmation' ? { options: ['确认', '取消'] } : {}) }, ctx.signal);
          // A reply is evidence from the user, not an automatic assertion that
          // login/restoration succeeded. Preserve their words for the next turn.
          const choice = result.answer?.length === 1 ? result.answer[0] : undefined;
          const approved = purpose !== 'action_confirmation' || !result.answered ? false
            : choice === '确认' ? true : choice === '取消' ? false : null;
          const data = { ...result, purpose, approved, requiresObservation: true };
          return { success: true, output: JSON.stringify(data), data };
        } finally { desktop.invalidateSky(ctx.sessionId); }
      } },
  ];
  const confirmation = windowsTools.find(tool => tool.name === 'computer_use_confirm')!;
  return { tools: process.platform === 'win32' ? windowsTools : [{ ...legacy, execute: (args, ctx) => { used = true; return legacy.execute(args, ctx); } }, confirmation], dispose: () => { repl?.dispose(); if (used) control().release(); } };
}
