import { describe, expect, it } from 'vitest';
import {
  contextAttachment,
  readContextReference,
  attachmentText,
} from '@/services/context-reference';

describe('context snapshots', () => {
  it('round trips Unicode and preserves unsaved selection lines and segment origin', () => {
    const snapshot = {
      kind: 'selection' as const,
      label: '说明.ts 3–5',
      path: 'D:/项目/说明.ts',
      startLine: 3,
      endLine: 5,
      segmentOffset: 1048576,
      content: '未保存的中文 🧪\n\t<标签>',
    };
    expect(readContextReference(contextAttachment(snapshot))).toEqual({ ...snapshot, version: 1 });
  });
  it('caps large snapshots on UTF-8 boundaries without losing the source', () => {
    const ref = readContextReference(
      contextAttachment({
        kind: 'selection',
        label: '大文件',
        path: 'D:/大文件.txt',
        content: '中文🧪'.repeat(6000),
      }),
    )!;
    expect(new TextEncoder().encode(ref.content).length).toBeLessThanOrEqual(24000);
    expect(ref.content).not.toContain('\uFFFD');
    expect(ref.truncated).toBe(true);
    expect(ref.path).toBe('D:/大文件.txt');
  });
  it('does not fetch remote attachment URLs or crash on corrupt references', () => {
    const attachment = contextAttachment({ kind: 'file', label: 'hello', path: 'D:/hello.txt' });
    expect(attachmentText({ ...attachment, url: 'https://example.invalid/file' })).toBe('');
    expect(
      readContextReference({
        ...attachment,
        url: 'data:text/x-wing-context-reference;base64,broken',
      }),
    ).toBeNull();
  });
});
