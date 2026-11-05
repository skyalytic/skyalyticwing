import type { BrowserSnapshot } from './browser.service.js';

export interface BrowserTarget { index?: number; x?: number; y?: number; action?: string }
export interface BrowserWait {
  condition: 'text' | 'url' | 'element' | 'load';
  text?: string | undefined; url?: string | undefined; index?: number | undefined;
  state?: 'visible' | 'hidden' | 'enabled' | undefined; timeoutMs?: number | undefined;
  observationId?: string | undefined;
}

/** Compare the observed target, not unrelated ads/clocks elsewhere in the page. */
export function sameBrowserTarget(before: BrowserSnapshot, after: BrowserSnapshot, target?: BrowserTarget): boolean {
  if (before.pageId !== after.pageId || before.documentId !== after.documentId || before.url !== after.url) return false;
  if (JSON.stringify(before.viewport) !== JSON.stringify(after.viewport)) return false;
  if (target?.index !== undefined) {
    const old = before.elements.find(e => e.index === target.index);
    const next = after.elements.find(e => e.index === target.index);
    return !!old && !!next && JSON.stringify(old) === JSON.stringify(next);
  }
  if (target && ['type', 'key'].includes(target.action || '') && target.x === undefined && target.y === undefined) {
    return !!before.activeElement && JSON.stringify(before.activeElement) === JSON.stringify(after.activeElement);
  }
  // Coordinates have no stable DOM identity: retain the stricter viewport check.
  return JSON.stringify(before.elements) === JSON.stringify(after.elements);
}

export function validateBrowserWait(wait: BrowserWait): number {
  if (!['text', 'url', 'element', 'load'].includes(wait.condition)) throw new Error('wait_for requires condition: text/url/element/load');
  if (wait.condition === 'text' && (typeof wait.text !== 'string' || !wait.text.trim())) throw new Error('text condition requires text');
  if (wait.condition === 'url' && (typeof wait.url !== 'string' || !wait.url.trim())) throw new Error('url condition requires an exact URL');
  if (wait.condition === 'element' && (!Number.isInteger(wait.index) || wait.index! < 1)) throw new Error('element condition requires an observed index');
  if (wait.state !== undefined && !['visible', 'hidden', 'enabled'].includes(wait.state)) throw new Error('Invalid element state');
  if (wait.timeoutMs !== undefined && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs < 0)) throw new Error('Invalid timeoutMs');
  return Math.min(wait.timeoutMs ?? 3000, 3000);
}

export function browserConditionMatches(snapshot: BrowserSnapshot, wait: BrowserWait): boolean {
  switch (wait.condition) {
    case 'load': return snapshot.readyState === 'interactive' || snapshot.readyState === 'complete';
    case 'url': return snapshot.url === wait.url;
    case 'text': return [snapshot.pageText || '', ...snapshot.elements.flatMap(e => [e.text || '', e.hint || ''])].some(text => text.includes(wait.text!));
    case 'element': {
      const el = snapshot.elements.find(e => e.index === wait.index);
      return wait.state === 'hidden' ? !el && !snapshot.elementsTruncated : !!el && (wait.state !== 'enabled' || !el.disabled);
    }
  }
}

/** A failed observation never turns an already delivered input into a retryable input. */
export class BrowserObservationError extends Error {
  readonly inputReceipt = { outcome: 'delivered', replay: false } as const;
  constructor(readonly pageId: string, readonly action: string, cause: unknown) {
    super(`Input delivered (${action}), but observation failed: ${cause instanceof Error ? cause.message : String(cause)}. Take a fresh snapshot and inspect all tabs; do not replay the action.`);
  }
}
