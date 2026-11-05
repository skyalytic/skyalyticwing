import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 目录选择器（选择项目文件夹）——三端分层回退：
// - Tauri 桌面端：挂载即调系统原生文件夹选择对话框（与 VS Code / TRAE 等 IDE 一致），
//   选中后 POST /files/project（后端校验 + 自动加白名单 + 持久化）；取消直接关闭。
// - Web 浏览器端：沙箱限制无法弹出返回绝对路径的原生对话框，回退为手动输入绝对路径。
// - CLI 端：不涉及（远程操作服务端）。
// 已选状态下提供"清除"入口（产物回落智能体工作目录）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui/Button';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import { useProjectPanel } from '@/stores/project-panel-store';

/** Tauri internals 最小类型（与 tauri-bridge 一致的访问方式） */
interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export function FolderPickerModal() {
  useWorkbenchLanguage();
  const projectDir = useProjectPanel((s) => s.projectDir);
  const setPickerOpen = useProjectPanel((s) => s.setPickerOpen);
  const chooseProjectDir = useProjectPanel((s) => s.chooseProjectDir);
  const clearProjectDir = useProjectPanel((s) => s.clearProjectDir);

  // 手输回退模式（Web 环境或原生对话框调用失败时）
  const [manualMode, setManualMode] = useState(false);
  const [manualPath, setManualPath] = useState(projectDir);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (manualMode) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    // Tauri 桌面端：直连 internals invoke（桥接封装会吞错误，无法区分"用户取消"与"调用失败"）
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
      .__TAURI_INTERNALS__;
    const rawInvoke = internals?.invoke;
    if (!rawInvoke) {
      setManualMode(true); // 非 Tauri 环境（浏览器）：手输回退
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // tauri-plugin-dialog v2：directory:true / multiple:false 返回 string | null（取消为 null）
        const r = (await rawInvoke('plugin:dialog|open', {
          options: { directory: true, multiple: false, title: wt('选择项目文件夹') },
        })) as string | string[] | null;
        if (cancelled) return;
        const path = typeof r === 'string' ? r : Array.isArray(r) ? (r[0] ?? '') : '';
        if (path) {
          const ok = await chooseProjectDir(path);
          if (!ok && !cancelled) setManualMode(true); // 后端校验失败 → 手输修正
        } else {
          setPickerOpen(false); // 用户在原生对话框取消 → 直接关闭
        }
      } catch {
        if (!cancelled) setManualMode(true); // 原生对话框不可用 → 手输回退
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manualMode, chooseProjectDir, setPickerOpen]);

  const confirmManual = useCallback(async () => {
    const p = manualPath.trim();
    if (!p) return;
    await chooseProjectDir(p);
  }, [manualPath, chooseProjectDir]);

  const clear = useCallback(async () => {
    const ok = await showConfirm(wt('确定清除项目文件夹？清除后 AI 产物将保存到智能体工作目录。'));
    if (!ok) return;
    await clearProjectDir();
    setPickerOpen(false);
  }, [clearProjectDir, setPickerOpen]);

  // 原生模式下不渲染自定义弹窗（系统对话框本身就是 UI）
  if (!manualMode) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setPickerOpen(false)}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-[520px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-black/10 dark:border-white/10">
          <Icon name="folder" size={16} />
          <span className="text-sm font-medium">{wt('选择项目文件夹')}</span>
          <span className="flex-1" />
          <Icon
            name="x"
            size={16}
            className="cursor-pointer opacity-60 hover:opacity-100"
            onClick={() => setPickerOpen(false)}
          />
        </div>

        {/* 手输路径（浏览器沙箱无法弹出返回绝对路径的原生对话框） */}
        <div className="px-4 py-4 space-y-2">
          <div className="text-xs opacity-60 leading-relaxed">
            {wt(
              '输入项目文件夹的绝对路径（如 D:\\projects\\my-app）。选择后 AI 产物将保存到该目录， 右侧工程面板的文件树与预览同步生效。',
            )}
          </div>
          <input
            ref={inputRef}
            className="input-field w-full text-sm"
            placeholder="D:\projects\my-app"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmManual();
            }}
          />
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-black/10 dark:border-white/10">
          {projectDir ? (
            <Button size="sm" variant="danger" onClick={() => void clear()}>
              {wt('清除')}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)}>
            {wt('取消')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!manualPath.trim()}
            onClick={() => void confirmManual()}
          >
            {wt('确定')}
          </Button>
        </div>
      </div>
    </div>
  );
}
