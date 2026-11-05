import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolResult } from '@skyalyticwing/shared';
import type { DesktopControlService } from '../../../../modules/automation/desktop-control.service.js';
import { ChatControlRegistry } from '../../../../modules/ai/chat/chat-control.registry.js';
import { DesktopInputObservationError } from './visual-desktop-workflow.js';

type Dict = Record<string, any>;
type InputReceipt = { method: string; outcome: 'delivered' | 'unknown' | 'not_started' };
type Cell = { id: string; ctx: ToolContext; text: string[]; image?: Dict; actionCount: number; receipts: InputReceipt[]; errors: string[]; observedAt?: number; finish(result: ToolResult): void };
type Kernel = { child: ChildProcess; cell?: Cell };
/** A cancelled/uninstalled cell loses its process and all cached window bindings. */
export class SkyRepl {
  private kernels = new Map<string, Kernel>();
  private unsubscribe: () => void;
  constructor(private readonly control: DesktopControlService) {
    this.unsubscribe = ChatControlRegistry.onAbort(id => { if (id) this.reset(id); else for (const key of this.kernels.keys()) this.reset(key); });
  }
  dispose(): void { this.unsubscribe(); for (const id of this.kernels.keys()) this.reset(id); }
  reset(sessionId: string): void {
    const kernel = this.kernels.get(sessionId); if (!kernel) return;
    this.kernels.delete(sessionId);
    kernel.cell?.finish({ success: false, error: 'Computer Use session ended; initialize and observe again before input. Attempted input may already have taken effect; do not replay it.',
      data: { desktopWorkflow: true, actionCount: kernel.cell.actionCount, inputReceipts: kernel.cell.receipts, observationComplete: false } });
    kernel.child.kill(); this.control.invalidateSky(sessionId);
  }
  private kernel(sessionId: string): Kernel {
    const existing = this.kernels.get(sessionId); if (existing) return existing;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir','path','pathext','temp','tmp'].includes(key.toLowerCase())));
    const child = spawn(process.execPath, [join(__dirname, 'repl-worker.cjs')], { cwd: tmpdir(), env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const kernel: Kernel = { child }; this.kernels.set(sessionId, kernel);
    child.on('message', async (message: Dict) => {
      const cell = kernel.cell; if (!cell || cell.id !== message['run']) return;
      if (message['type'] === 'text') { cell.text.push(String(message['text'])); return; }
      if (message['type'] === 'done') {
        // A JavaScript error invalidates observations, not the identity of known
        // windows. Fresh observations still revalidate HWND/PID and geometry.
        const failure = message['error'] || cell.errors.join('\n');
        if (failure) this.control.invalidateSky(sessionId, true);
        const delivered = cell.receipts.filter(r => r.outcome === 'delivered').map(r => r.method);
        const recovery = delivered.length ? ` Earlier input was delivered (${delivered.join(', ')}); this error did not undo it. Observe the current UI before deciding the next action; do not replay the cell.` : '';
        cell.finish({ success: !failure, ...(failure ? { error: String(failure) + recovery } : {}), output: cell.text.join('\n'),
          data: { desktopWorkflow: true, actionCount: cell.actionCount, inputReceipts: cell.receipts,
            observationComplete: !failure && cell.observedAt === cell.actionCount,
            ...(delivered.includes('type_text') ? { next: 'Text input was delivered; the field value is not yet verified. Inspect the field and ALL visible result group headings, including a group with only one item. If exact text is unclear, magnify with get_window_state({window, screenshotId, region:{x,y,width,height}, scale:3}) before editing or declaring no match. A candidate in the relevant group should be opened to verify its identity; web suggestions/history are not application records. Never retype based only on a placeholder or a guessed look-alike character. Ctrl+A selects text; it does not delete it, and clicking again cancels that selection.' } : {}),
            ...(cell.image ? { visualObservation: cell.image, lookId: cell.image['screenshotId'] } : {}) } }); return;
      }
      if (message['type'] !== 'sky') return;
      let receipt: InputReceipt | undefined;
      try {
        if (cell.ctx.signal?.aborted) throw new Error('Computer Use stopped');
        if (['click','press_key','type_text','scroll','set_value','drag','perform_secondary_action'].includes(message['method'])) {
          if (cell.actionCount) {
            cell.receipts.push({ method: message['method'], outcome: 'not_started' });
            throw new Error('Perform one state-derived input per cell, then refresh and inspect the result. This additional input was not started.');
          }
          cell.actionCount++;
          delete cell.image; delete cell.observedAt;
          receipt = { method: message['method'], outcome: 'unknown' }; cell.receipts.push(receipt);
        }
        if (['activate_window','launch_app','get_window_state'].includes(message['method'])) { delete cell.image; delete cell.observedAt; }
        const result = await this.control.skyCall(sessionId, message['method'], message['args'] || {}, image => { cell.image = image; });
        if (receipt) receipt.outcome = 'delivered';
        if (message['method'] === 'get_window_state') cell.observedAt = cell.actionCount;
        if (receipt && message['args']?.return_state === true && (result as Dict)?.['observationComplete'] === true) cell.observedAt = cell.actionCount;
        if (kernel.cell !== cell || cell.ctx.signal?.aborted) throw new Error('Computer Use stopped');
        child.send({ type: 'reply', id: message['id'], value: result });
      } catch (error) {
        cell.errors.push(error instanceof Error ? error.message : String(error));
        if (receipt && (error as { code?: string })?.code === 'DESKTOP_INPUT_NOT_STARTED') receipt.outcome = 'not_started';
        if (receipt && error instanceof DesktopInputObservationError) receipt.outcome = 'delivered';
        if (child.connected) child.send({ type: 'reply', id: message['id'], error: error instanceof Error ? error.message : String(error) }); }
    });
    const closed = () => { if (this.kernels.get(sessionId) === kernel) this.reset(sessionId); };
    child.once('exit', closed); child.once('error', closed);
    return kernel;
  }
  async run(code: string, ctx: ToolContext, timeoutMs?: number): Promise<ToolResult> {
    if (!ctx.sessionId || !code.trim()) return { success: false, error: 'A session and JavaScript code are required' };
    if (ctx.signal?.aborted) return { success: false, error: 'Task cancelled' };
    const kernel = this.kernel(ctx.sessionId);
    if (kernel.cell) return { success: false, error: 'A Computer Use cell is already running in this conversation' };
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => this.reset(ctx.sessionId);
      const cell: Cell = { id: randomUUID(), ctx, text: [], actionCount: 0, receipts: [], errors: [], finish: result => {
        if (kernel.cell !== cell) return;
        delete kernel.cell; if (timer) clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort); resolve(result);
      } };
      kernel.cell = cell; ctx.signal?.addEventListener('abort', abort, { once: true });
      if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(abort, timeoutMs);
      if (ctx.signal?.aborted) { abort(); return; }
      kernel.child.send({ type: 'run', id: cell.id, code });
    });
  }
}
