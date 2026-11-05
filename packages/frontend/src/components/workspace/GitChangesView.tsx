import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 工作区"代码变更"视图：git status --porcelain 文件列表 + diff HEAD（+/- 行着色）。
// 目录取当前工程目录；非 git 仓库时给引导文案。刷新按钮重查。
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui/Button';
import { SpinnerWrap } from '@/components/ui/Spinner';
import { apiClient } from '@/services/api-client';
import { useProjectPanel } from '@/stores/project-panel-store';

interface GitChanges {
  dir: string;
  isRepo: boolean;
  branch: string;
  files: Array<{ status: string; path: string }>;
  stat: string;
  diff: string;
}

/** 状态字母 → 中文徽标（porcelain 双字符 XY 取合并语义） */
const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  M: {
    get text() {
      return wt('修改');
    },
    cls: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  },
  A: {
    get text() {
      return wt('新增');
    },
    cls: 'bg-green-500/15 text-green-600 dark:text-green-400',
  },
  D: {
    get text() {
      return wt('删除');
    },
    cls: 'bg-red-500/15 text-red-500',
  },
  R: {
    get text() {
      return wt('重命名');
    },
    cls: 'bg-purple-500/15 text-purple-500',
  },
  C: {
    get text() {
      return wt('复制');
    },
    cls: 'bg-blue-500/15 text-blue-500',
  },
  U: {
    get text() {
      return wt('未合并');
    },
    cls: 'bg-orange-500/15 text-orange-500',
  },
  '?': {
    get text() {
      return wt('未跟踪');
    },
    cls: 'bg-black/10 dark:bg-white/10 opacity-70',
  },
};

function statusBadge(s: string) {
  const key = s.charAt(0) === '?' ? '?' : s.replace(/\s/g, '').charAt(0) || 'M';
  const meta = STATUS_LABEL[key] ?? { text: s, cls: 'bg-black/10 dark:bg-white/10' };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${meta.cls}`}>{meta.text}</span>
  );
}

/** diff 文本渲染：+ 绿 / - 红 / @@ 蓝，其余默认 */
function DiffBody({ text }: { text: string }) {
  useWorkbenchLanguage();
  return (
    <pre className="p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-all select-text">
      {text.split('\n').map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---')
            ? 'text-gray-400'
            : line.startsWith('+')
              ? 'text-green-600 dark:text-green-400 bg-green-500/5'
              : line.startsWith('-')
                ? 'text-red-500 bg-red-500/5'
                : line.startsWith('@@')
                  ? 'text-blue-500'
                  : 'text-gray-600 dark:text-gray-300';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

export function GitChangesView() {
  useWorkbenchLanguage();
  const projectDir = useProjectPanel((s) => s.projectDir);
  const treeVersion = useProjectPanel(s => s.treeVersion);
  const [data, setData] = useState<GitChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError('');
    try {
      const d = await apiClient.get<GitChanges>(
        `/files/git-changes?dir=${encodeURIComponent(projectDir)}`,
      );
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => {
    void load();
  }, [load, treeVersion]);

  if (!projectDir) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-compare" size={40} style={{ opacity: 0.35 }} />
        <div className="text-sm font-medium">{wt('未选择项目文件夹')}</div>
        <div className="text-xs opacity-60">
          {wt('在"编辑器"tab 选择项目文件夹后，这里显示该目录的 git 变更。')}
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <SpinnerWrap label={wt('读取 git 变更')} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="alert" size={36} className="text-red-500" />
        <div className="text-xs text-red-500 break-all max-w-full px-4">{error}</div>
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          {wt('重试')}
        </Button>
      </div>
    );
  }

  if (!data) return null;

  if (!data.isRepo) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="git-compare" size={40} style={{ opacity: 0.35 }} />
        <div className="text-sm font-medium">{wt('该目录不是 git 仓库')}</div>
        <div className="text-xs opacity-60 break-all px-4">{data.dir}</div>
        <div className="text-xs opacity-60">{wt('可在"终端"tab 执行 git init 后使用。')}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 头部：分支 + 变更数 + 刷新 */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-black/10 dark:border-white/10 shrink-0">
        <Icon name="git-compare" size={13} />
        <span className="text-xs font-medium">{data.branch}</span>
        <span className="text-[10px] opacity-60 flex-1 truncate">
          {data.files.length} {wt('个变更')}
        </span>
        <Icon
          name="refresh"
          size={13}
          className="cursor-pointer opacity-60 hover:opacity-100"
          onClick={() => void load()}
          title={wt('刷新')}
        />
      </div>
      {/* 变更文件列表 */}
      {data.files.length > 0 ? (
        <div className="max-h-40 overflow-auto border-b border-black/10 dark:border-white/10 shrink-0">
          {data.files.map((f) => (
            <div
              key={f.path}
              className="flex items-center gap-2 px-3 py-1 hover:bg-black/5 dark:hover:bg-white/5"
            >
              {statusBadge(f.status)}
              <span className="text-[11px] font-mono truncate flex-1" title={f.path}>
                {f.path}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-4 text-xs opacity-60 border-b border-black/10 dark:border-white/10 shrink-0">
          {wt('工作区干净，没有未提交变更。')}
        </div>
      )}
      {/* stat + diff */}
      <div className="flex-1 overflow-auto min-h-0">
        {data.diff ? (
          <>
            {data.stat ? (
              <pre className="px-2 pt-2 text-[10px] font-mono text-gray-500 whitespace-pre-wrap break-all">
                {data.stat}
              </pre>
            ) : null}
            <DiffBody text={data.diff} />
          </>
        ) : (
          <div className="p-4 text-xs opacity-60 text-center">
            {wt('已暂存或无未提交差异（diff HEAD 为空）。')}
          </div>
        )}
      </div>
    </div>
  );
}
