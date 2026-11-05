import type { ToolResult } from '@/types';

/** A tool may supply plain presentation data; unknown extensions keep a useful fallback. */
export function toolPresentation(name: string, args?: unknown, result?: ToolResult | string | null) {
  let input: Record<string, unknown> = {};
  try { input = (typeof args === 'string' ? JSON.parse(args) : args) ?? {}; } catch { /* raw args stay in details */ }
  const data = result && typeof result === 'object' ? result.data as Record<string, unknown> | undefined : undefined;
  const supplied = result && typeof result === 'object' ? result.presentation : undefined;
  const key = name.replace(/-/g, '_');
  const titles: Record<string, string> = {
    file_read: '读取文件', file_write: '写入文件', file_edit: '编辑文件', apply_patch: '编辑文件',
    powershell: '运行命令', bash: '运行命令', exec_command: '运行命令', shell: '运行命令',
    node_repl: '运行代码', computer_use: '操作桌面', browser: '操作浏览器',
    web_search: '搜索网页', search: '搜索', directory_list: '列出目录',
    task_verify: '任务验收', todo: '更新计划', ask_user: '提问',
  };
  const text = (...values: unknown[]) => values.find(v => typeof v === 'string' && v.trim()) as string | undefined;
  const title = text(supplied?.title, titles[key], name)!;
  const path = text(input['path'], input['file_path'], input['filePath']);
  const target = text(supplied?.summary, input['title'], path, input['command'], input['cmd'], input['query'], input['url'], input['action'], input['code']) ?? '';
  const diff = typeof data?.['diff'] === 'string' ? data['diff'] : '';
  // Count actual unified diff lines, excluding file headers; never invent statistics.
  const added = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return {title, target: target.replace(/\s+/g, ' ').slice(0, 240), path, added, removed,
    cancelled: data?.['cancelled'] === true,
    rejected: (result && typeof result === 'object' && result.blocked === true) || /Tool call rejected|approval denied|用户拒绝/i.test(result && typeof result === 'object' ? result.error ?? '' : result ?? ''),
  };
}
