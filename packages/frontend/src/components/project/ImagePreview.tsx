import { useEffect, useRef, useState } from 'react';
import { wt } from '@/i18n/workbench-text';
import { Modal } from '@/components/ui/Modal';
import { FileActions } from './FileActions';
import { PreviewFrame, ZoomControls, clampPreviewZoom } from './PreviewControls';

export function ImagePreview({ src, name, filePath, expand = true }: { src: string; name: string; filePath?: string; expand?: boolean }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setZoom(null); setError(false); setSize({ width: 0, height: 0 });
  }, [src]);
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const measure = () => setArea({ width: node.clientWidth, height: node.clientHeight });
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const fit = size.width && size.height ? Math.max(0.01, Math.min(area.width / size.width, area.height / size.height, 1)) : 1;
  const scale = zoom ?? fit;
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); setZoom(clampPreviewZoom(scale + (event.deltaY < 0 ? 0.1 : -0.1)));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [scale]);
  return <PreviewFrame expand={expand} label={name} actions={<><ZoomControls scale={scale} onChange={setZoom} onFit={() => setZoom(null)} />{filePath && <FileActions filePath={filePath} />}</>}>
    <div ref={scroll} className="preview-scroll" tabIndex={0} aria-label={wt('图片预览，可滚动查看')}>
      {error ? <p role="alert">{wt('图片加载失败，请确认文件仍然存在。')}</p> : <div className="preview-image-stage">
        <img src={src} alt={name} draggable={false} onError={() => setError(true)} onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={{ width: size.width ? size.width * scale : undefined, height: size.height ? size.height * scale : undefined }}
          onDoubleClick={() => setZoom(zoom === null ? 1 : null)} />
      </div>}
    </div>
  </PreviewFrame>;
}

/** Both generated and uploaded images use the same zoomable viewer. */
export function ImageAttachment({ src, name, filePath, className }: { src: string; name: string; filePath?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const localSrc = filePath ? `/api/files/serve?path=${encodeURIComponent(filePath)}` : src;
  return <><button className="image-preview-trigger" aria-label={wt('放大图片') + ' ' + name} onClick={() => setOpen(true)}>
    <img src={localSrc} alt={name} className={className} loading="lazy" style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain' }} />
  </button><Modal open={open} onClose={() => setOpen(false)} title={name} width="calc(96vw / var(--ui-zoom, 1))"><div style={{ height: 'calc(65vh / var(--ui-zoom, 1))', display: 'flex' }}>
    <ImagePreview src={localSrc} name={name} filePath={filePath} expand={false} />
  </div></Modal></>;
}
