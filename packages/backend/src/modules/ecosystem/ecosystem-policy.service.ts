import { LocalResourcePolicy } from '../core/security/local-resource-policy.service.js';
import { BadRequestException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { join } from 'node:path';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import type { CatalogItem } from './ecosystem.service.js';
interface Policy { revision:number; allowedIds:string[]; deniedPermissions:string[]; requireApproval:boolean; }
interface Store { policy:Policy; approved:string[]; audit:Array<{at:number;action:string;resource:string}>; }
@Injectable()
export class EcosystemPolicyService {
  constructor(@Optional() private readonly resources?: LocalResourcePolicy) {}
  private path(){const base=getDefaultDataDir();return join(this.resources?.localResourceRoot(base)??base,'ecosystem-policy.json');}
  private read():Store{return readJsonRecover(this.path(),{policy:{revision:0,allowedIds:[],deniedPermissions:[],requireApproval:false},approved:[],audit:[]});}
  get(){return this.read();}
  set(input:Policy){
    const store=this.read();if(input?.revision!==store.policy.revision)throw new BadRequestException('策略已变更，请刷新');
    if(!Array.isArray(input.allowedIds)||input.allowedIds.length>1000||input.allowedIds.some(id=>typeof id!=='string'||!/^[a-z0-9-]{1,81}$/.test(id))||!Array.isArray(input.deniedPermissions)||input.deniedPermissions.some(p=>typeof p!=='string'||p.length>200)||typeof input.requireApproval!=='boolean')throw new BadRequestException('策略格式无效');
    store.policy={revision:input.revision+1,allowedIds:[...new Set(input.allowedIds)],deniedPermissions:[...new Set(input.deniedPermissions)],requireApproval:input.requireApproval};
    writeJsonAtomicSync(this.path(),store);this.audit('policy.update','local');return this.get();
  }
  private key(item:CatalogItem){return `${item.id}@${item.version}:${item.artifactSha256}`;}
  check(item:CatalogItem){
    const store=this.read();if(store.policy.allowedIds.length&&!store.policy.allowedIds.includes(item.id))throw new ForbiddenException('资源不在管理员允许列表中');
    if(item.permissions.some(permission=>store.policy.deniedPermissions.includes(permission)))throw new ForbiddenException('此资源申请的权限被管理员禁止');
    if(store.policy.requireApproval&&!store.approved.includes(this.key(item)))throw new ForbiddenException('此版本需要管理员在生态治理中批准');
  }
  approve(item:CatalogItem){const store=this.read();const key=this.key(item);if(!store.approved.includes(key))store.approved.push(key);writeJsonAtomicSync(this.path(),store);this.audit('version.approve',key);return {success:true};}
  audit(action:string,resource:string){const store=this.read();store.audit.push({at:Date.now(),action,resource});store.audit=store.audit.slice(-1000);writeJsonAtomicSync(this.path(),store);}
}
