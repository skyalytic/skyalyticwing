import { contextReferenceText } from '../../src/modules/ai/agent/context-reference.js';

describe('inline context rendering', () => {
  it('keeps the selected unsaved excerpt and source range without raw transport JSON', () => {
    const text = contextReferenceText(
      JSON.stringify({
        version: 1,
        kind: 'selection',
        label: '日志.txt 3–6',
        path: 'E:/日志.txt',
        startLine: 3,
        endLine: 6,
        content: '还未保存的中文\n只解释这些行',
      }),
    );
    expect(text).toContain('选区行号：3–6');
    expect(text).toContain('还未保存的中文\n只解释这些行');
    expect(text).toContain('可能包含尚未保存');
    expect(text).not.toContain('"version":');
  });
  it('distinguishes missing content, empty content and truncated excerpts', () => {
    const ref = { version: 1, kind: 'file', label: '日志.txt', path: 'E:/日志.txt' };
    expect(contextReferenceText(JSON.stringify(ref))).toContain('未附带正文');
    expect(contextReferenceText(JSON.stringify({ ...ref, content: '' }))).toContain(
      '已随本条消息提供',
    );
    expect(
      contextReferenceText(JSON.stringify({ ...ref, content: '摘录', truncated: true })),
    ).toContain('已截断');
  });
  it.each(['null', '{}', 'broken', '{"version":2,"kind":"file","label":"x"}'])(
    'rejects malformed data %s',
    (value) => {
      expect(contextReferenceText(value)).toBeNull();
    },
  );
});
