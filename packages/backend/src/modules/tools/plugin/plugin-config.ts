export function sensitiveConfigKey(key: string, schema?: any): boolean {
  return /api.?key|secret|token|password|credential|auth|webhook/i.test(key) || schema?.writeOnly === true || schema?.format === 'password';
}
export function redactPluginConfig(value: any, schema?: any): any {
  if (Array.isArray(value)) return value.map(v=>redactPluginConfig(v,schema?.items));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!key.startsWith('_')).map(([key,v])=>[key,
    sensitiveConfigKey(key,schema?.properties?.[key]) && v !== '' && v != null ? '***' : redactPluginConfig(v,schema?.properties?.[key])]));
}
export function mergePluginConfig(previous: any, patch: any): any {
  if (patch === '***') return previous;
  if (Array.isArray(patch)) return patch.map((v,i)=>mergePluginConfig(previous?.[i],v));
  if (!patch || typeof patch !== 'object') return patch;
  return {...previous,...Object.fromEntries(Object.entries(patch).filter(([key])=>!key.startsWith('_')&&!['__proto__','constructor','prototype'].includes(key)).map(([key,v])=>[key,mergePluginConfig(previous?.[key],v)]))};
}
export function hasPluginSecrets(value: any, schema?: any): boolean {
  if (Array.isArray(value)) return value.some(v=>hasPluginSecrets(v,schema?.items));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key,v])=>!key.startsWith('_')&&((sensitiveConfigKey(key,schema?.properties?.[key])&&v!==''&&v!=null)||hasPluginSecrets(v,schema?.properties?.[key])));
}
