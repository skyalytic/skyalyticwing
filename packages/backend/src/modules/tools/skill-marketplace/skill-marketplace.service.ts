import { Injectable } from '@nestjs/common';
import { EcosystemService } from '../../ecosystem/ecosystem.service.js';
export interface MarketplaceSource { name:string; baseUrl:string; type:string }
export interface MarketplaceItem { name?:string;slug?:string;description?:string;installed?:boolean;_source:string;_sourceType:string }
@Injectable()
export class SkillMarketplaceService {
  constructor(private readonly ecosystem:EcosystemService){}
  getSources():MarketplaceSource[]{return [{name:'Skyalytic 官网',baseUrl:'https://skyalytic.com/api/ecosystem/v1',type:'skyalytic'}]}
  async search(query:string,_sourceFilter:string,_forceRefresh:boolean):Promise<MarketplaceItem[]>{
    const result=await this.ecosystem.catalog(query,'skill');
    return result.items.map(item=>({name:item.name,slug:item.id,description:item.description,installed:result.installed.some(i=>i.id===item.id),_source:'Skyalytic 官网',_sourceType:'skyalytic'}));
  }
  async install(name:string,source:string){
    if(source&&source!=='skyalytic')return {success:false,error:'仅支持 Skyalytic 官网目录，请重新搜索资源'};
    return this.ecosystem.install(name);
  }
}
