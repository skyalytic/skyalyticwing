import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
// 按文件类型分派：文本直接进入 IDE 编辑器，媒体与 Office 保留专用预览。
import { Icon } from '@/components/Icon';
import { Button } from '@/components/ui/Button';
import { TextFileEditor } from './TextFileEditor';
import { OfficeEditor } from './OfficeEditor';
import { DatabaseView } from '../workspace/DatabaseView';
import { FileActions } from './FileActions';
import { ImagePreview } from './ImagePreview';
import { PreviewFrame } from './PreviewControls';
import { useProjectPanel } from '@/stores/project-panel-store';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const MD_EXTS = new Set(['md', 'markdown']);
/** 视为文本可预览/编辑的扩展名（其余按二进制处理） */
const TEXT_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'bat',
  'ps1',
  'sql',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'vue',
  'swift',
  'kt',
  'cs',
  'xml',
  'csv',
  'txt',
  'log',
  'env',
  'gitignore',
  'dockerfile',
  'makefile',
  'lock',
  'conf',
]);


function extOf(p: string): string {
  const base =
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || '';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
}

function basename(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || p
  );
}

export function FilePreview({ filePath }: { filePath: string }) {
  const ext = extOf(filePath);
  if (IMAGE_EXTS.has(ext)) return <ImagePreview key={filePath} filePath={filePath} name={basename(filePath)} src={`/api/files/serve?path=${encodeURIComponent(filePath)}`} />;
  const document = ['docx', 'pptx', 'xlsx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'pdf'].includes(ext);
  return <PreviewFrame label={basename(filePath)} expand={document} actions={<FileActions filePath={filePath} />}>
    <FileContent key={filePath} filePath={filePath} />
  </PreviewFrame>;
}

function FileContent({ filePath }: { filePath: string }) {
  useWorkbenchLanguage();
  const ext = extOf(filePath);
  const name = basename(filePath);
  if (['db', 'sqlite', 'sqlite3'].includes(ext))
    return <DatabaseView key={filePath} filePath={filePath} />;
  if (['docx', 'pptx', 'xlsx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp'].includes(ext))
    return <OfficeEditor key={filePath} filePath={filePath} onOpenFile={path=>useProjectPanel.getState().openFile(path)} />;
  if (ext === 'pdf')
    return (
      <iframe
        title={name}
        className="flex-1 w-full border-0"
        src={`/api/files/serve?path=${encodeURIComponent(filePath)}`}
      />
    );

  if (MD_EXTS.has(ext)) {
    return <TextFileEditor key={filePath} filePath={filePath} markdownMode />;
  }

  if (TEXT_EXTS.has(ext) || !name.includes('.')) {
    return <TextFileEditor key={filePath} filePath={filePath} />;
  }

  // 二进制/未知类型：下载入口
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon name="file" size={44} style={{ opacity: 0.4 }} />
      <div className="text-sm font-medium">{name}</div>
      <div className="text-xs opacity-60">{wt('二进制文件，暂不支持内嵌预览')}</div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          window.open(`/api/files/serve?path=${encodeURIComponent(filePath)}`, '_blank')
        }
      >
        {wt('打开 / 下载')}
      </Button>
    </div>
  );
}
