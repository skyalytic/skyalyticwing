import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LoggerService } from '../core/logger/logger.service.js';
import { getDefaultDataDir } from '../core/utils/web-data.util.js';
import { readJsonRecover, writeJsonAtomicSync } from '../core/utils/atomic-json.util.js';
import { LocalResourcePolicy } from '../core/security/local-resource-policy.service.js';

export interface KnowledgeEntry { id: string; title: string; content: string; tags: string[]; createdAt: number; }
interface MemoryStoreShape {
  conversations: Record<string, Array<{content:string;timestamp:number;category:string}>>;
  knowledge: KnowledgeEntry[];
  deletedKnowledgeIds: string[];
  lastCleanup: number;
}
export interface KnowledgeStats { totalKnowledge:number; totalConversations:number; totalConversationEntries:number; lastCleanup:number|null; }
const emptyStore = (): MemoryStoreShape => ({conversations:{},knowledge:[],deletedKnowledgeIds:[],lastCleanup:Date.now()});

@Injectable()
export class MemoryDataService implements OnModuleInit {
  private store = emptyStore();
  private memoryPath = '';
  constructor(private readonly logger:LoggerService, @Optional() private readonly policy?:LocalResourcePolicy) {}
  onModuleInit(): void {
    try { this.ensureScope(); this.ensureDreamFiles(); }
    catch (err) { this.logger.warn('Memory data unavailable; preserving existing files', {error:String(err)}); }
  }
  private getDataDir(): string { const root=getDefaultDataDir(); return this.policy?.localMemoryRoot(root) ?? root; }
  private ensureScope(): void {
    const path=join(this.getDataDir(),'memory.json');
    if (path===this.memoryPath) return;
    const parsed=readJsonRecover<Partial<MemoryStoreShape>>(path,emptyStore());
    if (!parsed || !Array.isArray(parsed.knowledge) || parsed.knowledge.some(e=>!e || typeof e.id!=='string' || typeof e.title!=='string' || typeof e.content!=='string' || !Array.isArray(e.tags) || e.tags.some(t=>typeof t!=='string'))) throw new Error('记忆文件格式损坏，已保留原文件');
    this.store={...emptyStore(),...parsed,deletedKnowledgeIds:Array.isArray(parsed.deletedKnowledgeIds)?parsed.deletedKnowledgeIds:[]};
    this.memoryPath=path;
  }
  private commit(next:MemoryStoreShape):void {
    writeJsonAtomicSync(this.memoryPath,next);
    this.store=next; // Do not expose a successful in-memory write before durable persistence.
  }
  listKnowledge():KnowledgeEntry[] { this.ensureScope(); return structuredClone(this.store.knowledge); }
  addKnowledge(title:string,content:string,tags?:string[]):KnowledgeEntry {
    this.ensureScope();
    if (typeof title!=='string' || typeof content!=='string' || (!title.trim()&&!content.trim()) || (tags!==undefined && (!Array.isArray(tags)||tags.some(t=>typeof t!=='string')))) throw new Error('知识条目参数无效');
    const entry:KnowledgeEntry={id:`know-${randomUUID()}`,title,content,tags:[...(tags??[])],createdAt:Date.now()};
    this.commit({...this.store,knowledge:[...this.store.knowledge,entry]});
    return structuredClone(entry);
  }
  deleteKnowledge(id:string):boolean {
    this.ensureScope();
    if (!this.store.knowledge.some(e=>e.id===id)) return false;
    this.commit({...this.store,knowledge:this.store.knowledge.filter(e=>e.id!==id),deletedKnowledgeIds:[...new Set([...this.store.deletedKnowledgeIds,id])]});
    return true;
  }
  getStats():KnowledgeStats {
    this.ensureScope();
    return {totalKnowledge:this.store.knowledge.length,totalConversations:Object.keys(this.store.conversations).length,totalConversationEntries:Object.values(this.store.conversations).reduce((n,items)=>n+(Array.isArray(items)?items.length:0),0),lastCleanup:this.store.lastCleanup||null};
  }
  searchKnowledge(query:string,maxResults=10):Array<KnowledgeEntry & {score:number}> {
    this.ensureScope();
    if (!query.trim()) return [];
    const key=query.trim().toLowerCase();
    const count=Number.isFinite(maxResults)?Math.max(1,Math.min(100,Math.floor(maxResults))):10;
    return this.store.knowledge.map(e=>({...structuredClone(e),score:(e.title.toLowerCase().includes(key)?6:0)+(e.content.toLowerCase().includes(key)?3:0)+(e.tags.some(t=>t.toLowerCase().includes(key))?2:0)}))
      .filter(e=>e.score>0).sort((a,b)=>b.score-a.score||b.createdAt-a.createdAt).slice(0,count);
  }
  getShortTermRecallCount():number {
    const parsed=readJsonRecover<unknown>(join(this.getDataDir(),'dreams','short-term-recall.json'),[]);
    return Array.isArray(parsed)?parsed.length:0;
  }
  isDreamEnabled():boolean { return true; }
  private ensureDreamFiles():void {
    for (const name of ['short-term-recall.json','phase-signals.json']) {
      const file=join(this.getDataDir(),'dreams',name);
      if (!existsSync(file)) writeJsonAtomicSync(file,[]);
    }
  }
}
