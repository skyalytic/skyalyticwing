// todo 工具：会话级待办清单（AI 拆解任务/记录进度的落地载体）。
// 内存存储（会话维度），通过工具卡的通用展示渲染当前清单。
import { randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolContext, ToolResult } from '@skyalyticwing/shared';

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  ts: number;
}

/** sessionId → items（时间升序） */
const store = new Map<string, TodoItem[]>();

function render(list: TodoItem[]): string {
  if (list.length === 0) return '（待办清单为空）';
  return list.map((t) => `${t.done ? '[x]' : '[ ]'} #${t.id.slice(0, 4)} ${t.text}`).join('\n');
}

export function createTodoTools(): ToolDefinition[] {
  return [
    {
      name: 'todo',
      description:
        '管理当前会话的待办清单（add 添加 / list 列出 / update 更新状态或文本 / remove 删除）。' +
        '复杂任务建议先 add 拆解步骤，完成一步 update 一步，让用户实时看到进度。',
      category: 'productivity',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'update', 'remove'], description: '操作类型' },
          text: { type: 'string', description: 'add 时为待办内容；update 时为新文本（可选）' },
          id: { type: 'string', description: 'update/remove 的条目 id（list 输出中 #后 4 位）' },
          done: { type: 'boolean', description: 'update 时设置完成状态（可选）' },
        },
        required: ['action'],
      },
      async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const a = args as { action?: string; text?: string; id?: string; done?: boolean };
        const action = a?.action;
        if (!action || !['add', 'list', 'update', 'remove'].includes(action)) {
          return { success: false, error: 'action 必须是 add/list/update/remove' };
        }
        const key = ctx.sessionId || '__global__';
        const list = store.get(key) ?? [];
        if (action === 'add') {
          const text = (a.text ?? '').trim();
          if (!text) return { success: false, error: 'add 需要 text' };
          list.push({ id: randomUUID(), text, done: false, ts: Date.now() });
        } else if (action === 'update') {
          const item = list.find((t) => t.id.startsWith(a.id ?? '\u0000'));
          if (!item) return { success: false, error: `未找到待办 ${a.id ?? ''}` };
          if (typeof a.text === 'string' && a.text.trim()) item.text = a.text.trim();
          if (typeof a.done === 'boolean') item.done = a.done;
        } else if (action === 'remove') {
          const idx = list.findIndex((t) => t.id.startsWith(a.id ?? '\u0000'));
          if (idx < 0) return { success: false, error: `未找到待办 ${a.id ?? ''}` };
          list.splice(idx, 1);
        }
        store.set(key, list);
        return {
          success: true,
          output: `当前待办（${list.length} 项，完成 ${list.filter((t) => t.done).length}）：\n${render(list)}`,
          data: { items: [...list] },
        };
      },
    },
  ];
}
