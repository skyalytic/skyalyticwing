import type { Attachment } from '@/types';
import { isBrowserAnnotation } from './browser-annotation';
export const CONTEXT_REFERENCE_MIME = 'text/x-wing-context-reference';
export const CONTEXT_REFERENCE_EVENT = 'wing-attach-context';
export interface ContextReference {
  version: 1;
  kind:
    'file' | 'selection' | 'folder' | 'chat' | 'rule' | 'problem' | 'skill' | 'plugin' | 'command';
  label: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  segmentOffset?: number;
  content?: string;
  instruction?: string;
  truncated?: boolean;
}
export function contextAttachment(ref: Omit<ContextReference, 'version'>): Attachment {
  const data: ContextReference = { ...ref, version: 1 };
  if (data.content && new TextEncoder().encode(data.content).length > 24000) {
    let text = '',
      bytes = 0;
    for (const char of data.content) {
      const length = new TextEncoder().encode(char).length;
      if (bytes + length > 24000) break;
      text += char;
      bytes += length;
    }
    data.content = text;
    data.truncated = true;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return {
    type: 'file',
    name: data.label,
    mimeType: CONTEXT_REFERENCE_MIME,
    size: bytes.length,
    url: `data:${CONTEXT_REFERENCE_MIME};base64,${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))}`,
  };
}
export function isContextAttachment(att: Attachment): boolean {
  return (
    isBrowserAnnotation(att) || (att.type === 'file' && att.mimeType === CONTEXT_REFERENCE_MIME)
  );
}
export function attachmentText(att: Attachment): string {
  try {
    if (!att.url?.startsWith('data:text/') || att.url.length > 200000) return '';
    return new TextDecoder().decode(
      Uint8Array.from(atob(att.url.split(',')[1] || ''), (c) => c.charCodeAt(0)),
    );
  } catch {
    return '';
  }
}
export function readContextReference(att: Attachment): ContextReference | null {
  if (att.mimeType !== CONTEXT_REFERENCE_MIME) return null;
  try {
    const r = JSON.parse(attachmentText(att));
    if (
      r?.version !== 1 ||
      typeof r.label !== 'string' ||
      ![
        'file',
        'selection',
        'folder',
        'chat',
        'rule',
        'problem',
        'skill',
        'plugin',
        'command',
      ].includes(r.kind)
    )
      return null;
    if (
      ['path', 'content', 'instruction'].some(
        (key) => r[key] !== undefined && typeof r[key] !== 'string',
      )
    )
      return null;
    if (
      ['startLine', 'endLine', 'segmentOffset'].some(
        (key) => r[key] !== undefined && (!Number.isSafeInteger(r[key]) || r[key] < 0),
      )
    )
      return null;
    return r;
  } catch {
    return null;
  }
}
export function attachContext(ref: Omit<ContextReference, 'version'>): void {
  window.dispatchEvent(
    new CustomEvent(CONTEXT_REFERENCE_EVENT, { detail: contextAttachment(ref) }),
  );
}
