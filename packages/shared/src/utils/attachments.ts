import type { Attachment } from '../types/chat.js';

/** Normalize local references without conflating remote URLs or equal file names. */
function referenceKey(value: string): string {
  let path = value;
  try {
    const url = new URL(value, 'http://wing.local');
    const local = value.startsWith('/') || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (local && url.pathname === '/api/files/serve' && url.searchParams.has('path')) {
      path = url.searchParams.get('path')!;
    } else if (url.protocol === 'file:') {
      path = decodeURIComponent(url.pathname);
      if (url.hostname) path = `//${url.hostname}${path}`;
      else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
      return `url:${value}`;
    }
  } catch { /* A plain filesystem path is also valid. */ }
  const windows = /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}/.test(path);
  if (!windows && !path.startsWith('/')) return `ref:${value}`;
  const normalized = windows ? path.replace(/\\/g, '/').toLowerCase() : path;
  const prefix = normalized.startsWith('//') ? '//' : normalized.startsWith('/') ? '/' : '';
  const segments: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (segments.length && !/^[a-z]:$/.test(segments.at(-1)!)) segments.pop(); }
    else segments.push(part);
  }
  return `file:${prefix}${segments.join('/')}`;
}

/** Same file may arrive from generation and send-file tools, with different path/URL aliases. */
export function deduplicateAttachments(attachments: readonly Attachment[]): Attachment[] {
  const groups: Array<{ attachment: Attachment; keys: Set<string> }> = [];
  for (const attachment of attachments) {
    const keys = new Set([attachment.path, attachment.url].filter((v): v is string => !!v).map(referenceKey));
    const matches = groups.filter(group => [...keys].some(key => group.keys.has(key)));
    if (!matches.length) { groups.push({ attachment: { ...attachment }, keys }); continue; }
    const target = matches[0]!;
    // Merge alias bridges too, keeping the first item's position and playable metadata.
    for (const item of [...matches.slice(1).map(group => group.attachment), attachment]) {
      for (const field of ['path', 'url', 'mimeType', 'name', 'size'] as const) {
        if (target.attachment[field] == null || target.attachment[field] === '') {
          Object.assign(target.attachment, { [field]: item[field] });
        }
      }
      if (target.attachment.type === 'file' && item.type !== 'file') target.attachment.type = item.type;
    }
    for (const key of keys) target.keys.add(key);
    for (const match of matches.slice(1)) {
      for (const key of match.keys) target.keys.add(key);
      groups.splice(groups.indexOf(match), 1);
    }
  }
  return groups.map(group => group.attachment);
}
