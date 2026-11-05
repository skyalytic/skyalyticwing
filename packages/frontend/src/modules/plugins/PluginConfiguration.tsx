import {useEffect,useState} from 'react';
import {Modal} from '@/components/ui/Modal';
import {Button} from '@/components/ui/Button';
import {apiClient} from '@/services/api-client';
import {showConfirm} from '@/components/modals/ConfirmDialog';
import {wt} from '@/i18n/workbench-text';
type Field={type?:string;title?:string;description?:string;default?:unknown;enum?:Array<string|number>;format?:string;writeOnly?:boolean};
type Setup={config:Record<string,unknown>;schema?:{properties?:Record<string,Field>;required?:string[]}|null};
const secret=(key:string,f:Field)=>/api.?key|secret|token|password|credential|auth|webhook/i.test(key)||f.writeOnly===true||f.format==='password';
export function PluginConfiguration({id,name,onClose}:{id:string;name:string;onClose:()=>void}){
  const [setup,setSetup]=useState<Setup|null>(null),[values,setValues]=useState<Record<string,any>>({}),[json,setJson]=useState('{}'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let cancelled=false;apiClient.get<Setup>(`/plugins/${encodeURIComponent(id)}/configuration`).then(data=>{if(cancelled)return;setSetup(data);setJson(JSON.stringify(data.config,null,2));setValues(Object.fromEntries(Object.entries(data.schema?.properties||{}).map(([k,f])=>[k,data.config[k]==='***'?'':data.config[k]??f.default??(f.type==='boolean'?false:'')])));}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[id]);
  const fields=Object.entries(setup?.schema?.properties||{}),form=fields.length>0&&fields.every(([,f])=>['string','number','integer','boolean'].includes(f.type||'string'));
  const save=async()=>{setError('');setBusy(true);try{let patch:Record<string,unknown>;
    if(form){patch={};for(const [k,f]of fields){const v=values[k];if(secret(k,f)&&v===''&&setup?.config[k]==='***')continue;if((f.type==='number'||f.type==='integer')&&v==='')continue;patch[k]=f.type==='number'||f.type==='integer'?Number(v):v;}}
    else {patch=JSON.parse(json);if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error(wt('配置必须为 JSON 对象'));}
    await apiClient.put(`/plugins/${encodeURIComponent(id)}/config`,patch);onClose();
  }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const clear=async()=>{if(!await showConfirm(wt('清除该插件在本机保存的配置和凭据？'),{title:wt('清除配置'),danger:true}))return;setBusy(true);try{await apiClient.delete(`/plugins/${encodeURIComponent(id)}/config`);onClose();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <Modal open title={wt('配置插件')+' · '+name} onClose={()=>{if(!busy)onClose();}} width={600} closeOnOverlay={!busy}>
    <p className="text-sm mb-4">{wt('配置加密保存在本机。已保存的密钥留空表示保留，实际 API 权限和额度由服务商决定。')}</p>
    {error&&<p role="alert" className="mb-3 text-red-500">{error}</p>}
    {!setup?<p>{wt('加载中…')}</p>:<form onSubmit={e=>{e.preventDefault();void save();}}>
      {form?fields.map(([key,f])=><label className="block mb-3" key={key}>{f.title||key}
        {f.description&&<small className="block opacity-70">{f.description}</small>}
        {f.type==='boolean'?<select className="input-field w-full" value={String(values[key])} onChange={e=>setValues(v=>({...v,[key]:e.target.value==='true'}))}><option value="true">{wt('开启')}</option><option value="false">{wt('关闭')}</option></select>
        :f.enum?<select className="input-field w-full" value={String(values[key])} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}>{!setup.schema?.required?.includes(key)&&<option value=""/>}{f.enum.map(x=><option key={String(x)} value={x}>{String(x)}</option>)}</select>
        :<input className="input-field w-full" type={secret(key,f)?'password':f.type==='number'||f.type==='integer'?'number':'text'} step={f.type==='integer'?1:'any'} autoComplete={secret(key,f)?'new-password':'off'} value={String(values[key]??'')} required={setup.schema?.required?.includes(key)&&setup.config[key]!=='***'} placeholder={setup.config[key]==='***'?wt('已配置，留空保留'):''} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}/>}
      </label>):<label className="block">{wt('JSON 配置')}<textarea aria-label={wt('JSON 配置')} className="input-field w-full font-mono" rows={10} value={json} spellCheck={false} onChange={e=>setJson(e.target.value)}/><small>{wt('按插件作者要求填写字段。保留 *** 可保留原密钥，空字符串会清除该字段。')}</small></label>}
      <div className="flex flex-wrap gap-2 mt-4"><Button type="submit" loading={busy}>{wt('保存配置')}</Button><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{wt('取消')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>void clear()}>{wt('清除配置')}</Button></div>
    </form>}
  </Modal>;
}
