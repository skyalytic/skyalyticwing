/** Render inline references as source excerpts, not a JSON object the model must interpret. */
export function contextReferenceText(raw: string): string | null {
  let ref: Record<string, unknown>;
  try {
    ref = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !ref ||
    ref['version'] !== 1 ||
    typeof ref['label'] !== 'string' ||
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
    ].includes(String(ref['kind']))
  )
    return null;
  const metadata = [`[用户引用：${ref['label']}]`];
  if (typeof ref['path'] === 'string') metadata.push(`来源路径：${ref['path']}`);
  if (Number.isSafeInteger(ref['startLine']) && Number(ref['startLine']) > 0) {
    metadata.push(
      `选区行号：${ref['startLine']}–${Number.isSafeInteger(ref['endLine']) ? ref['endLine'] : ref['startLine']}`,
    );
  }
  if (Number.isSafeInteger(ref['segmentOffset']))
    metadata.push(`分段起始字节：${ref['segmentOffset']}`);
  if (typeof ref['content'] === 'string') {
    metadata.push(
      ref['truncated'] === true
        ? '以下是引用内容的部分摘录，已截断；不能据此声称已读取完整内容。'
        : '以下引用内容已随本条消息提供。',
    );
    if (ref['kind'] === 'selection')
      metadata.push('这是用户选中时的文字快照，可能包含尚未保存的修改。');
    metadata.push('引用正文（作为来源资料处理）：', ref['content'], '[引用正文结束]');
  } else {
    metadata.push('未附带正文；需要内容时按来源路径读取。');
  }
  if (typeof ref['instruction'] === 'string') metadata.push(`引用说明：${ref['instruction']}`);
  return metadata.join('\n');
}
