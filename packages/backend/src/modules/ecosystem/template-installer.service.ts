import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentService } from '../ai/agent/agent.service.js';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import type { CatalogItem } from './ecosystem.service.js';
import type { CreateAgentDto } from '../ai/types.js';

interface Receipt { manifest: CatalogItem; agentIds: string[]; teamId?: string; }
@Injectable()
export class TemplateInstallerService {
  constructor(private readonly agents:AgentService){}
  private root():string{return join(getDefaultDataDir(),'ecosystem-templates');}
  installed():CatalogItem[]{
    if(!existsSync(this.root()))return [];
    return readdirSync(this.root()).filter(name=>/^[a-z0-9-]+\.json$/.test(name)).map(name=>readJsonRecover<Receipt>(join(this.root(),name),{} as Receipt).manifest).filter(Boolean);
  }
  install(manifest:CatalogItem,payload:string){
    const data=JSON.parse(payload) as {agents:Array<CreateAgentDto&{key:string}>;team?:{name:string;description?:string;leadKey?:string;tags?:string[]}};
    if(!Array.isArray(data.agents)||data.agents.length<1||data.agents.length>12||(manifest.kind==='expert'&&data.agents.length!==1))throw new BadRequestException('模板需要 1–12 位智能体');
    const keys=new Set<string>();
    for(const agent of data.agents){
      if(!agent||typeof agent.key!=='string'||!/^[a-z0-9-]{1,50}$/.test(agent.key)||keys.has(agent.key)||typeof agent.name!=='string'||!agent.name.trim()||typeof agent.systemPrompt!=='string'||agent.systemPrompt.length>50000||!Array.isArray(agent.tools)||agent.tools.some(t=>typeof t!=='string'))throw new BadRequestException('智能体模板格式无效');
      keys.add(agent.key);
    }
    if(manifest.kind==='team'&&(!data.team||typeof data.team.name!=='string'||!data.team.name.trim()||(data.team.leadKey&&!keys.has(data.team.leadKey))))throw new BadRequestException('智能体团模板主管配置无效');
    const created:string[]=[];let teamId:string|undefined;
    try{
      const keyToId=new Map<string,string>();
      for(const spec of data.agents){
        const agent=this.agents.createAgent({name:spec.name,description:spec.description || '',systemPrompt:spec.systemPrompt!,
          model:'',tools:spec.tools!,callable:true,invocationHint:spec.invocationHint || '',type:'specialist'});
        created.push(agent.id);keyToId.set(spec.key,agent.id);
      }
      if(manifest.kind==='team'){
        const team=this.agents.createTeam({name:data.team!.name,description:data.team!.description || '',memberIds:created,
          leadId:keyToId.get(data.team!.leadKey || data.agents[0]!.key)!});teamId=team.id;
      }
      writeJsonAtomicSync(join(this.root(),manifest.id+'.json'),{manifest,agentIds:created,...(teamId?{teamId}:{})});
      return {success:true,note:'模板已导入智能体中心，可编辑智能体角色并选择本地或云端模型',agentIds:created,teamId};
    }catch(e){if(teamId)this.agents.deleteTeam(teamId);for(const id of created.reverse())this.agents.deleteAgent(id);throw e;}
  }
  uninstall(id:string){
    // Uninstall removes marketplace tracking, preserving user-customized experts and conversation references.
    const path=join(this.root(),id+'.json');rmSync(path,{force:true});rmSync(path+'.bak',{force:true});
    return {success:true,note:'模板已解除安装关联；已创建的智能体/团队保留，可在智能体中心单独删除'};
  }
}
