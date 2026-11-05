import type { ToolDefinition } from '@skyalyticwing/shared';
import { TuiService } from '../../../../modules/terminal/tui.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
export function createTuiTools(resolve: ServiceResolver): ToolDefinition[] {
  return ['start','status','send','stop'].map(action => ({
    name: 'tui_' + action, category: 'system', dangerous: action === 'send',
    description: ({ start: '创建本地 Wing 文字交互会话，返回会话 ID。可用终端客户端 wing-tui.cjs 进行文字交互。', status: '查看当前调用会话创建的 TUI 状态与文字屏幕。', send: '向 TUI 发送消息或 /help /status /history /clear /cancel /quit；普通消息异步调用已配置模型，使用 status 获取结果。', stop: '停止指定 TUI；中断在途任务并保留聊天记录。' } as Record<string,string>)[action]!,
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'tui_start 返回的 ID' }, model: { type: 'string' }, message: { type: 'string' } }, required: action === 'send' ? ['id','message'] : action === 'stop' ? ['id'] : [] },
    async execute(args, ctx) {
      try {
        const svc = resolve(TuiService); if (!svc) throw new Error('TUI 服务未加载');
        const a = (args || {}) as { id?: string; model?: string; message?: string }; const owner = 'tool:' + ctx.sessionId;
        const data = action === 'start' ? svc.start(owner, a.model) : action === 'status' ? svc.status(owner, a.id) : action === 'stop' ? svc.stop(owner, a.id || '') : svc.send(owner, a.id || '', a.message || '');
        return { success: true, output: JSON.stringify(data), data };
      } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
    },
  }));
}
