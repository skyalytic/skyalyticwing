import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工具面板抽屉（旧版 renderToolPanel：右侧 w-96 滑出 + 动态表单 + 执行结果）
// 聊天页"工具面板"按钮与工具列表"使用"按钮共用
import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useSessionStore } from '@/stores/session-store';
import { ToolForm } from './ToolForm';
import { apiClient } from '@/services/api-client';
import type { ToolListItem } from '@/types';

export function ToolPanelDrawer({
  tool,
  onClose,
}: {
  tool: ToolListItem | null;
  onClose: () => void;
}) {
  useWorkbenchLanguage();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // 切换工具时清空结果
  useEffect(() => {
    setResult(null);
  }, [tool?.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runTool = useCallback(
    async (args: Record<string, unknown>) => {
      if (!tool) return;
      setLoading(true);
      setResult(null);
      try {
        const res = await apiClient.post<unknown>(
          '/tool/execute',
          { tool: tool.name, args, sessionId: useSessionStore.getState().currentSessionId ?? undefined },
          { timeoutMs: 180_000 },
        );
        setResult(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
      } catch (e) {
        setResult(wt('执行失败: ') + (e instanceof Error ? e.message : String(e)));
      } finally {
        setLoading(false);
      }
    },
    [tool],
  );

  if (!tool) return null;

  const toolName =
    (tool.name || '').length > 30 ? (tool.name || '').slice(0, 30) + '...' : tool.name || '';

  return (
    <Modal open title={toolName} width={640} onClose={onClose}>
      <div className="tool-execution-panel">
        <p style={{ overflowWrap: 'anywhere', marginBottom: 16 }}>{tool.description || ''}</p>
        <div className="flex-1 overflow-y-auto p-4">
          <ToolForm
            tool={tool}
            onSubmit={(args) => void runTool(args)}
            onCancel={onClose}
            loading={loading}
            submitLabel={wt('执行')}
          />
        </div>
        {result ? (
          <div className="p-4 border-t border-gray-700">
            <h4 className="text-sm font-semibold mb-2 text-green-400 flex items-center gap-1">
              {wt('执行结果')}
            </h4>
            <pre className="bg-gray-900 p-3 rounded text-xs max-h-48 overflow-auto whitespace-pre-wrap">
              {result}
            </pre>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
