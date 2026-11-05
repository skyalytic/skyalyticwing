import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const observed=new Map<string,string>();
const key=(session:string,path:string)=>session+'\0'+(process.platform==='win32'?resolve(path).toLowerCase():resolve(path));
export const contentVersion=(content:string|null)=>content===null?'missing':createHash('sha256').update(content).digest('hex');
export function observeVersion(session:string,path:string,content:string|null):string {
  const version=contentVersion(content);observed.set(key(session,path),version);
  while(observed.size>10000)observed.delete(observed.keys().next().value!);
  return version;
}
/** Called under the same per-file mutation lock as the write. */
export function assertObservedVersion(session:string,path:string,content:string|null,expected?:string):void {
  const previous=expected ?? observed.get(key(session,path));
  if(previous!==undefined&&previous!==contentVersion(content))throw new Error('文件已被用户或另一位专家修改，请重新读取并合并后再写入');
  if(previous===undefined&&session.startsWith('sub-')&&content!==null)throw new Error('覆盖现有文件前必须先读取，避免覆盖其他专家的产物');
}
