import { describe, expect, it, vi } from 'vitest';
import { DESIGN_EDITOR_SCRIPT } from '@/components/workspace/design-editor-script';

describe('canvas content retention', () => {
  it('keeps edits beyond 20,000 characters in the document and exported history', () => {
    document.body.innerHTML = '<p id="audit-text">before</p>';
    const send = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const winEvents = vi.spyOn(window, 'addEventListener');
    const docEvents = vi.spyOn(document, 'addEventListener');
    try {
      new Function(DESIGN_EDITOR_SCRIPT)();
      document.dispatchEvent(new Event('DOMContentLoaded'));
      window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'sky-canvas-edit', command: 'select', value: '#audit-text' } }));
      const content = '中文😀'.repeat(6000) + 'END';
      window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'sky-canvas-edit', command: 'text', value: content } }));
      expect(document.getElementById('audit-text')?.textContent).toBe(content);
      const reports = send.mock.calls.map(call => call[0] as any).filter(item => item?.type === 'sky-canvas-document');
      expect(reports.at(-1)?.payload.html).toContain(content);
    } finally {
      for (const [event, handler, options] of winEvents.mock.calls) window.removeEventListener(event, handler, options);
      for (const [event, handler, options] of docEvents.mock.calls) document.removeEventListener(event, handler, options);
      vi.restoreAllMocks(); document.body.innerHTML = '';
    }
  });
});
