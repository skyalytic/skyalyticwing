import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EcosystemPolicyService } from '../../src/modules/ecosystem/ecosystem-policy.service';
import type { CatalogItem } from '../../src/modules/ecosystem/ecosystem.service';
describe('enterprise ecosystem approval policy',()=>{
  const prior=process.env['SKYALYTICWING_DATA_DIR'];let root:string;
  beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'wing-policy-'));process.env['SKYALYTICWING_DATA_DIR']=root;});
  afterEach(()=>{if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(root,{recursive:true,force:true});});
  it('pins approvals to artifact/version and prevents stale policy updates',()=>{
    const service=new EcosystemPolicyService(),item={id:'office',version:'1.0.0',artifactSha256:'abc',permissions:['read']} as CatalogItem;
    service.set({revision:0,allowedIds:['office'],deniedPermissions:['send'],requireApproval:true});
    expect(()=>service.check(item)).toThrow('批准');service.approve(item);expect(()=>service.check(item)).not.toThrow();
    expect(()=>service.check({...item,version:'1.0.1'})).toThrow('批准');expect(()=>service.check({...item,permissions:['send']})).toThrow('禁止');
    expect(()=>service.set({revision:0,allowedIds:[],deniedPermissions:[],requireApproval:false})).toThrow('刷新');
    expect(service.get().audit).toHaveLength(2);
  });
  it('does not share enterprise governance approvals with personal or another enterprise',()=>{
    let realm='personal';
    const service=new EcosystemPolicyService({localResourceRoot:(base:string)=>join(base,realm)} as any);
    const item={id:'office',version:'1.0.0',artifactSha256:'abc',permissions:[]} as CatalogItem;
    realm='company-a';service.approve(item);expect(service.get().approved).toHaveLength(1);
    realm='personal';expect(service.get().approved).toEqual([]);
    realm='company-b';expect(service.get().approved).toEqual([]);
    realm='company-a';expect(service.get().approved).toHaveLength(1);
  });
});
