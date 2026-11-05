/**
 * doctor 命令：检查后端连通性并输出状态摘要
 *
 * 端点（对照 packages/backend/src/modules/core/system/system.controller.ts）：
 *   GET /api/health      - 存活探针（Tauri/前端轮询同款）
 *   GET /api/status/full - 完整状态聚合（版本/运行时长/供应商/智能体/工具/定时任务/WS 客户端）
 *   GET /api/models      - 模型清单（统计可用模型数）
 */
import type { CliOptions } from '../args.js';
import { ApiError, DEFAULT_BASE_URL, apiFetch } from '../http.js';
import { formatUptime, printTable } from '../format.js';

/** GET /api/status/full 返回的聚合快照（仅取 CLI 关注的字段） */
interface StatusFull {
  version: string;
  uptime: number;
  system?: { platform?: string; arch?: string };
  agents?: { total?: number };
  tools?: { total?: number };
  providers?: { total?: number; configured?: number };
  cron?: { running?: boolean; totalJobs?: number; enabledJobs?: number };
  websocket?: { clients?: number };
}

/** GET /api/models 返回的模型项（对照 ProviderService.listModels） */
interface ModelItem {
  id: string;
  available?: boolean;
  kind?: string;
}

/** doctor 命令入口；返回进程退出码 */
export async function cmdDoctor(options: CliOptions): Promise<number> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  try {
    // 1. 存活探针（短超时，快速失败）
    await apiFetch<unknown>(baseUrl, '/api/health', { timeoutMs: 5000 });

    // 2. 状态聚合 + 模型清单（允许部分失败：字段降级为 '-'）
    let status: StatusFull | undefined;
    let models: ModelItem[] = [];
    const failures: string[] = [];
    try {
      const res = await apiFetch<StatusFull>(baseUrl, '/api/status/full', { timeoutMs: 8000 });
      status = res.data;
    } catch (error) {
      failures.push(`状态检查失败：${error instanceof Error ? error.message : String(error)}`);
      // 老版本后端可能没有 /api/status/full，忽略并继续
    }
    try {
      const res = await apiFetch<{ models: ModelItem[] }>(baseUrl, '/api/models', {
        timeoutMs: 8000,
      });
      models = Array.isArray(res.data?.models) ? res.data.models : [];
    } catch (error) {
      failures.push(`模型检查失败：${error instanceof Error ? error.message : String(error)}`);
      // 模型清单失败不阻断 doctor
    }

    const modelCount = models.length;
    const availableModels = models.filter((m) => m.available === true).length;

    if (options.json) {
      // 机器可读输出
      console.log(
        JSON.stringify(
          {
            ok: failures.length === 0,
            failures,
            baseUrl,
            backend: 'reachable',
            ...(status?.version !== undefined ? { version: status.version } : {}),
            ...(status?.uptime !== undefined ? { uptimeSeconds: status.uptime } : {}),
            models: { total: modelCount, available: availableModels },
            providers: status?.providers ?? null,
            agents: status?.agents ?? null,
            tools: status?.tools ?? null,
            cron: status?.cron ?? null,
            websocket: status?.websocket ?? null,
          },
          null,
          2,
        ),
      );
      return failures.length ? 1 : 0;
    }

    // 人类可读输出
    const rows: string[][] = [
      ['后端地址', baseUrl],
      ['连接状态', '✓ 正常'],
      ['后端版本', status?.version ?? '-'],
      ['运行时长', status?.uptime !== undefined ? formatUptime(status.uptime) : '-'],
      ['模型数量', `${modelCount}（可用 ${availableModels}）`],
      [
        '供应商',
        status?.providers
          ? `${status.providers.total ?? 0} 个（已配置 ${status.providers.configured ?? 0}）`
          : '-',
      ],
      ['智能体', status?.agents ? String(status.agents.total ?? 0) : '-'],
      ['工具', status?.tools ? String(status.tools.total ?? 0) : '-'],
      [
        '定时任务',
        status?.cron
          ? `${status.cron.running ? '运行中' : '已停止'} · 共 ${status.cron.totalJobs ?? 0} 个（启用 ${status.cron.enabledJobs ?? 0}）`
          : '-',
      ],
      ['WS 客户端', status?.websocket ? String(status.websocket.clients ?? 0) : '-'],
    ];
    printTable(['检查项', '结果'], rows);
    for (const failure of failures) console.error(failure);
    return failures.length ? 1 : 0;
  } catch (err) {
    // 后端不可达：优雅报错（不抛栈），便于脚本按退出码判断
    const message =
      err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(
        JSON.stringify({ ok: false, baseUrl, backend: 'unreachable', error: message }, null, 2),
      );
    } else {
      console.error(`✗ 无法连接后端 ${baseUrl}`);
      console.error(`  原因：${message}`);
      console.error(
        '  提示：请确认后端已启动（Gateway 计划任务 / 桌面端），或用 --base-url 指定其他地址。',
      );
    }
    return 1;
  }
}
