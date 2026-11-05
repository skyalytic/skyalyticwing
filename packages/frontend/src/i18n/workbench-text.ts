import { useTranslation } from 'react-i18next';
import i18n from './index';
import english from './workbench-en.json';

// Source phrases are namespace keys. No DOM rewriting or content translation.
i18n.addResourceBundle('en', 'workbenchText', english, true, true);
export function useWorkbenchLanguage(): string {
  const { i18n: current } = useTranslation('workbenchText');
  return current?.resolvedLanguage || i18n.language;
}
export function workbenchLocale(): string {
  return i18n.resolvedLanguage || i18n.language;
}
export function wt(source: string, values?: Record<string, unknown>): string {
  if(workbenchLocale().startsWith('en')) {
    const official=/^官方模型 · (文本|视觉|图片生成|视频生成|文本向量|重排序|自动|通用)( [A-F0-9]{4})?$/.exec(source);
    if(official) {
      const kinds:Record<string,string>={文本:'Text',视觉:'Vision',图片生成:'Image generation',视频生成:'Video generation',文本向量:'Embeddings',重排序:'Reranking',自动:'Automatic',通用:'General'};
      return 'Official model · '+kinds[official[1]!] +(official[2] || '');
    }
  }
  return i18n.t(source, {
    ns: 'workbenchText',
    keySeparator: false,
    nsSeparator: false,
    defaultValue: source,
    ...values,
  });
}
