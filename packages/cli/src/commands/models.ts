/**
 * models 命令：列出后端可用模型
 *
 * 端点：GET /api/models（对照 provider.controller.ts → ProviderService.listModels，
 * 返回 { models: ModelItem[] }，聚合各 provider 的 chat/image/video 模型）。
 */
import type { CliOptions } from '../args.js';
import { DEFAULT_BASE_URL, apiFetch } from '../http.js';
import { printTable } from '../format.js';

/** 模型项（对照 ProviderService 的 ModelItem） */
interface ModelItem {
  id: string;
  name?: string;
  providerId?: string;
  providerName?: string;
  available?: boolean;
  vision?: boolean;
  kind?: string;
}

/** models 命令入口；返回进程退出码 */
export async function cmdModels(options: CliOptions): Promise<number> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await apiFetch<{ models: ModelItem[] }>(baseUrl, '/api/models');
    const models = Array.isArray(res.data?.models) ? res.data.models : [];

    if (options.json) {
      console.log(JSON.stringify(models, null, 2));
      return 0;
    }

    if (models.length === 0) {
      console.log('暂无可用模型（请先在后端设置中配置供应商 API Key）');
      return 0;
    }

    printTable(
      ['模型 ID', '供应商', '类型', '视觉', '可用'],
      models.map((m) => [
        m.id,
        m.providerName ?? m.providerId ?? '-',
        m.kind ?? 'chat',
        m.vision ? '✓' : '-',
        m.available === false ? '✗' : '✓',
      ]),
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`✗ 获取模型列表失败：${message}`);
    }
    return 1;
  }
}
