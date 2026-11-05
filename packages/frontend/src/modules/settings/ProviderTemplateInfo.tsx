import { wt, useWorkbenchLanguage, workbenchLocale } from '@/i18n/workbench-text';

export interface ProviderCatalogInfo {
  checkedAt: string;
  sources: string[];
  note?: string;
  noteEn?: string;
  setup?: 'gateway' | 'deployment' | 'reference' | 'local';
  references?: Array<{ id: string; kind: 'chat' | 'image' | 'video' }>;
}
export function ProviderTemplateInfo({ catalog, counts, onApply }: {
  catalog?: ProviderCatalogInfo;
  counts: [number, number, number, number];
  onApply: () => void;
}) {
  useWorkbenchLanguage();
  if (!catalog) return <p className="model-template-hint">{wt('选择厂商即可填入能力预设；自定义接口请按服务商文档填写。')}</p>;
  return <section className="model-template-info" aria-label={wt('厂商模板')}>
    <div className="model-template-heading">
      <span>{wt('官方文档核对')} · {catalog.checkedAt}</span>
      {catalog.setup !== 'reference' && <button type="button" className="btn-secondary" onClick={onApply}>{wt('重新填入预设')}</button>}
    </div>
    {catalog.setup === 'reference' ? <p>{wt('仅供查阅：原生接口尚未适配，暂不能直接配置使用。')}</p> : <>
      <p className="model-template-hint">{wt('下方显示当前表单已配置的模型数量，不代表厂商的全部模型。')}</p>
      <div className="model-capability-badges">
        {['文本对话', '视觉理解', '图片生成', '视频生成'].map((label, i) => <span key={label} data-enabled={counts[i] > 0}>{wt(label)} · {counts[i] > 0 ? wt('{{count}} 个模型', { count: counts[i] }) : wt('未配置')}</span>)}
      </div>
    </>}
    <p>{wt('预设不代表账号已开通；以厂商权限、地区和余额为准。')}</p>
    {catalog.note && <p>{workbenchLocale().startsWith('en') ? catalog.noteEn || catalog.note : catalog.note}</p>}
    {!!catalog.references?.length && <details className="model-template-references">
      <summary>{wt('其他已收录模型（未启用自动路由）')} · {catalog.references.length}</summary>
      <ul>{catalog.references.map(m => <li key={m.id}><code>{m.id}</code><span>{wt(m.kind === 'chat' ? '文本对话' : m.kind === 'image' ? '图片生成' : '视频生成')}</span></li>)}</ul>
    </details>}
    <div className="model-template-links">{catalog.sources.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer">{wt('官方文档')} {i + 1} ↗</a>)}</div>
    <p className="model-template-hint">{wt('重新填入只修改当前表单，保存后才生效；API Key 保持不变。')}</p>
  </section>;
}
