/**
 * agents 命令：列出后端智能体
 *
 * 端点：GET /api/agents（对照 agent.controller.ts → AgentService.listAgents，
 * 返回 ApiResponse<AgentInfo[]>）。
 */
import type { CliOptions } from '../args.js';
import { DEFAULT_BASE_URL, apiFetch } from '../http.js';
import { printTable, truncate } from '../format.js';

/** 智能体信息（对照 AgentInfo 的展示字段） */
interface AgentInfoLite {
  id: string;
  name: string;
  description?: string;
  model?: string;
  type?: string;
  status?: string;
}

/** agents 命令入口；返回进程退出码 */
export async function cmdAgents(options: CliOptions): Promise<number> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await apiFetch<AgentInfoLite[]>(baseUrl, '/api/agents');
    const agents = Array.isArray(res.data) ? res.data : [];

    if (options.json) {
      console.log(JSON.stringify(agents, null, 2));
      return 0;
    }

    if (agents.length === 0) {
      console.log('暂无智能体');
      return 0;
    }

    printTable(
      ['ID', '名称', '类型', '状态', '模型'],
      agents.map((a) => [
        a.id,
        truncate(a.name, 24),
        a.type ?? 'primary',
        a.status ?? '-',
        a.model ?? '-',
      ]),
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`✗ 获取智能体列表失败：${message}`);
    }
    return 1;
  }
}
