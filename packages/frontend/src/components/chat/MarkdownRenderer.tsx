// Markdown 渲染：react-markdown + rehype-sanitize + rehype-highlight
import { memo, useMemo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { prettyJson } from '@/utils/format';
import { ImageAttachment } from '@/components/project/ImagePreview';

// 允许 code 标签上的 className（rehype-highlight 需要）
const baseAttrs = defaultSchema.attributes ?? {};
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...baseAttrs,
    code: [...(baseAttrs['code'] ?? []), ['className']],
    span: [...(baseAttrs['span'] ?? []), ['className']],
    pre: [...(baseAttrs['pre'] ?? []), ['className']],
  },
};

export interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function CodeBlock({ className, children }: ComponentPropsWithoutRef<'code'>) {
  const isInline = !className && !String(children).includes('\n');
  if (isInline) {
    return <code className={className}>{children}</code>;
  }
  return <code className={className}>{children}</code>;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  const plugins = useMemo(() => [[rehypeSanitize, sanitizeSchema], rehypeHighlight], []);

  return (
    <div className={`markdown ${className ?? ''}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rehypePlugins={plugins as any}
        components={{
          code: CodeBlock as never,
          table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0}><table>{children}</table></div>,
          img: ({ src, alt }) => <ImageAttachment src={src || ''} name={alt || 'image'} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** 工具调用参数/结果通常以 JSON 字符串展示，做美化 */
export function JsonBlock({ data }: { data: unknown }) {
  const text = useMemo(() => {
    if (typeof data === 'string') return prettyJson(data);
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);
  return <pre className="tool-call-args">{text}</pre>;
}
