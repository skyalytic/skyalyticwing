import { wt, useWorkbenchLanguage } from '@/i18n/workbench-text';
export type CapabilityForm = {visionIds:string;imageIds:string;videoIds:string;imageProtocol:string;videoProtocol:string;imageBaseUrl:string;videoBaseUrl:string};
export const emptyCapabilities:CapabilityForm={visionIds:'',imageIds:'',videoIds:'',imageProtocol:'none',videoProtocol:'none',imageBaseUrl:'',videoBaseUrl:''};
export function ModelCapabilities({value,onChange}:{value:CapabilityForm;onChange:(v:CapabilityForm)=>void}) {
  useWorkbenchLanguage();
  const text=(key:keyof CapabilityForm,label:string,placeholder='')=><label className="form-label">{label}{key.endsWith('Ids') ? <textarea className="form-input model-ids-input" rows={2} value={value[key]} placeholder={placeholder} onChange={e=>onChange({...value,[key]:e.target.value})} /> : <input className="form-input" value={value[key]} placeholder={placeholder} onChange={e=>onChange({...value,[key]:e.target.value})} />}</label>;
  return <details className="my-3 border rounded p-3" open={!!(value.imageIds || value.videoIds || value.visionIds)}><summary>{wt('视觉、图片与视频能力')}</summary>
    <p className="text-xs opacity-70 my-2">{wt('使用当前 API Key。厂商预设已填入支持的能力；空白表示未预设，可按服务商文档补充。')}</p>
    {text('visionIds',wt('视觉理解模型 ID（逗号分隔）'))}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div><label className="form-label">{wt('图片生成协议')}<select className="form-input" value={value.imageProtocol} onChange={e=>onChange({...value,imageProtocol:e.target.value})}><option value="none">{wt('不启用')}</option><option value="openai-compatible">OpenAI Compatible</option><option value="openai-images">OpenAI GPT Image</option><option value="dashscope">DashScope</option><option value="gemini">Gemini Native</option><option value="minimax">MiniMax Image</option><option value="xai">xAI Imagine</option><option value="zhipu">Zhipu Image</option><option value="siliconflow">SiliconFlow Image</option><option value="ideogram">Ideogram</option></select></label>{text('imageIds',wt('图片模型 ID（逗号分隔）'))}{text('imageBaseUrl',wt('图片 API 地址'))}</div>
      <div><label className="form-label">{wt('视频生成协议')}<select className="form-input" value={value.videoProtocol} onChange={e=>onChange({...value,videoProtocol:e.target.value})}><option value="none">{wt('不启用')}</option><option value="dashscope">DashScope</option><option value="ark">Volcengine Ark</option><option value="runway">Runway</option><option value="pika">Pika</option><option value="minimax">MiniMax H3</option><option value="xai">xAI Imagine Video</option></select></label>{text('videoIds',wt('视频模型 ID（逗号分隔）'))}{text('videoBaseUrl',wt('视频 API 地址'))}</div>
    </div>
  </details>;
}
