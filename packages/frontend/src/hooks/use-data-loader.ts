// 集中数据加载 hook：提供 loadData / loadViewData / executeTool，并暴露全局加载状态
import { useCallback } from 'react';
import {
  loadData as svcLoadData,
  loadViewData as svcLoadViewData,
  executeCurrentTool,
  useDataStore,
} from '@/services/data-loader';

export interface UseDataLoaderReturn {
  loading: boolean;
  loadError: boolean;
  lastLoadedAt: number | null;
  loadData: () => Promise<void>;
  loadViewData: (view: string) => Promise<void>;
  /** 执行工具（POST /api/tool/execute） */
  executeTool: (toolId: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function useDataLoader(): UseDataLoaderReturn {
  const loading = useDataStore((s) => s.loading);
  const loadError = useDataStore((s) => s.loadError);
  const lastLoadedAt = useDataStore((s) => s.lastLoadedAt);

  const loadData = useCallback(() => svcLoadData(), []);
  const loadViewData = useCallback((view: string) => svcLoadViewData(view), []);
  const executeTool = useCallback(
    (toolId: string, args: Record<string, unknown>) => executeCurrentTool(toolId, args),
    [],
  );

  return { loading, loadError, lastLoadedAt, loadData, loadViewData, executeTool };
}
