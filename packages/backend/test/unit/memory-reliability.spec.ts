import 'reflect-metadata';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from '../../src/modules/ai/agent/memory.service.js';
import { MemoryDataService } from '../../src/modules/memory/memory-data.service.js';
import { VectorsService } from '../../src/modules/ai/vectors/vectors.service.js';
import { MemoryController } from '../../src/modules/memory/memory.controller.js';
import { AgentService } from '../../src/modules/ai/agent/agent.service.js';
import { createMemoryTools } from '../../src/modules/tools/executor/built-in/memory.js';

const logger = {info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()} as any;
describe('private durable memory',()=>{
  let root:string, identity:string, prior:string|undefined, priorWeb:string|undefined;
  let policy:any, memory:MemoryService, data:MemoryDataService, vectors:VectorsService;
  beforeEach(async()=>{
    root=mkdtempSync(join(tmpdir(),'wing-memory-audit-'));
    prior=process.env['SKYALYTICWING_DATA_DIR']; priorWeb=process.env['SKYALYTICWING_WEB_DATA_DIR'];
    process.env['SKYALYTICWING_DATA_DIR']=root; process.env['SKYALYTICWING_WEB_DATA_DIR']=root;
    identity='personal';
    policy={localMemoryRoot:(base:string)=>join(base,identity),credentialIdentity:()=>identity};
    memory=new MemoryService(logger,policy); memory.onModuleInit();
    data=new MemoryDataService(logger,policy); data.onModuleInit();
    vectors=new VectorsService(logger,{isPathAllowed:()=>true} as any,policy);
    jest.spyOn(vectors as any,'initLanceDb').mockResolvedValue(undefined);
    await vectors.onModuleInit();
  });
  afterEach(()=>{
    memory.onModuleDestroy();
    if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;
    if(priorWeb===undefined)delete process.env['SKYALYTICWING_WEB_DATA_DIR'];else process.env['SKYALYTICWING_WEB_DATA_DIR']=priorWeb;
    jest.restoreAllMocks();
  });
  it('creates Markdown directories, saves across restart and returns usable one-based search paths',()=>{
    expect(memory.appendToToday('专用检索词')).toEqual({ok:true});
    const match=memory.search('专用检索词')[0]!;
    expect(match.path).toMatch(/^memory\//);
    expect(match.lineStart).toBeGreaterThan(0);
    expect(memory.get(match.path,match.lineStart,20)).toMatchObject({content:expect.stringContaining('专用检索词')});
    memory.appendToMemory('长期事实');
    const reloaded=new MemoryService(logger,policy);
    expect(reloaded.get()).toContain('长期事实');
    expect(memory.search('   ')).toEqual([]);
  });
  it('isolates Markdown, knowledge, vectors and agent facts across identity switches',()=>{
    const agents=new AgentService(policy); agents.onModuleInit();
    memory.appendToMemory('personal-only');
    data.addKnowledge('personal-only','personal-only');
    vectors.addEmbedding('personal-only',{});
    agents.setMemory('agent',{agentId:'agent',facts:['personal-only'],lastUpdated:0});
    identity='enterprise-a';
    expect(memory.search('personal-only')).toEqual([]);
    expect(data.listKnowledge()).toEqual([]);
    expect(vectors.list().total).toBe(0);
    expect(agents.getMemory('agent').facts).toEqual([]);
    memory.appendToMemory('enterprise-only'); data.addKnowledge('enterprise-only','enterprise-only');
    vectors.addEmbedding('enterprise-only',{});
    identity='personal';
    expect(memory.get()).toContain('personal-only');
    expect(memory.get()).not.toContain('enterprise-only');
    expect(data.listKnowledge().map(e=>e.title)).toEqual(['personal-only']);
    expect(vectors.list().entries.map(e=>e.content)).toEqual(['personal-only']);
    expect(agents.getMemory('agent').facts).toEqual(['personal-only']);
  });
  it('uses collision-free IDs even in the same millisecond and does not expose mutable stored references',()=>{
    jest.spyOn(Date,'now').mockReturnValue(123);
    const first=data.addKnowledge('one','body');const second=data.addKnowledge('two','body');
    expect(first.id).not.toBe(second.id);
    first.content='tampered';data.listKnowledge()[0]!.content='tampered';
    expect(data.listKnowledge()[0]!.content).toBe('body');
    expect(data.deleteKnowledge(first.id)).toBe(true);
    expect(data.listKnowledge()[0]!.id).toBe(second.id);
  });
  it('does not report success or mutate memory when knowledge persistence fails',()=>{
    data.addKnowledge('kept','original');
    const store=join(root,identity,'memory.json');
    // A directory cannot be replaced as a file: exercise a real write failure.
    const bad=join(root,identity,'blocked.json');mkdirSync(bad);
    (data as any).memoryPath=bad;
    jest.spyOn(data as any,'ensureScope').mockImplementation(()=>undefined);
    expect(()=>data.addKnowledge('lost','must fail')).toThrow();
    expect(data.listKnowledge().map(e=>e.title)).toEqual(['kept']);
    expect(JSON.parse(readFileSync(store,'utf8')).knowledge).toHaveLength(1);
  });
  it('recovers a valid knowledge backup and refuses to overwrite unrecoverable data',()=>{
    data.addKnowledge('kept','body'); data.addKnowledge('second','body');
    const path=join(root,identity,'memory.json');writeFileSync(path,'{broken');
    const restored=new MemoryDataService(logger,policy);restored.onModuleInit();
    expect(restored.listKnowledge().map(e=>e.title)).toEqual(['kept']);
    writeFileSync(path+'.bak','{broken');
    const broken=new MemoryDataService(logger,policy);broken.onModuleInit();
    expect(()=>broken.addKnowledge('new','body')).toThrow();
    expect(readFileSync(path,'utf8')).toBe('{broken');
  });
  it('never returns a deleted knowledge item from stale vectors, including after restart',async()=>{
    const entry=data.addKnowledge('removed','removed secret');
    vectors.addEmbedding('removed secret',{type:'knowledge',knowledgeId:entry.id});
    data.deleteKnowledge(entry.id);
    expect(vectors.search('removed')).toEqual([]); expect(vectors.list().entries).toEqual([]);
    const restarted=new VectorsService(logger,{isPathAllowed:()=>true} as any,policy);
    jest.spyOn(restarted as any,'initLanceDb').mockResolvedValue(undefined); await restarted.onModuleInit();
    expect(restarted.search('removed')).toEqual([]);
  });
  it('does not retain vectors whose durable save was denied',()=>{
    jest.spyOn((vectors as any).security,'isPathAllowed').mockReturnValue(false);
    expect(()=>vectors.addEmbedding('unsaved',{})).toThrow('未保存');
    expect(vectors.list().total).toBe(0);
  });
  it('rejects prefix traversal, non-memory files, agent traversal and junction escapes',()=>{
    expect(memory.get('../../outside.md')).toHaveProperty('error');
    expect(memory.get('memory.json')).toHaveProperty('error');
    expect(memory.appendToMemory('escape','../../outside').ok).toBe(false);
    identity='linked'; const folder=join(root,identity);mkdirSync(folder);
    const outside=join(root,'outside');mkdirSync(outside);
    writeFileSync(join(outside,'secret.md'),'DO NOT READ');
    symlinkSync(outside,join(folder,'memory'),'junction');
    expect(memory.get('memory/secret.md')).toHaveProperty('error');
  });
  it('keeps workspace notes private and consolidates preference and decision sections separately',()=>{
    memory.appendToMemory('worker-only','worker');
    expect(memory.get()).not.toContain('worker-only');
    memory.appendToToday('### 摘要\n**用户偏好发现**:\n- 喜欢简洁的回复\n**重要决策**:\n- 使用离线方案处理任务');
    memory.runDreamCycle(); memory.runDreamCycle();
    const value=String(memory.get());
    expect(value.match(/喜欢简洁的回复/g)).toHaveLength(1);
    expect(value).toMatch(/## 用户偏好\n[^#]*喜欢简洁的回复/);
    expect(value).toMatch(/## 重要决策\n[^#]*使用离线方案/);
    expect(memory.get('workspaces/worker/MEMORY.md')).toMatchObject({content:expect.not.stringContaining('喜欢简洁的回复')});
  });
  it('does not promote memory on a GET status request',()=>{
    const run=jest.spyOn(memory,'runDreamCycle');
    const controller=new MemoryController(memory,data,{listJobs:()=>[]} as any,logger);
    expect(controller.dream().success).toBe(true); expect(run).not.toHaveBeenCalled();
    controller.dreamRun();expect(run).toHaveBeenCalledTimes(1);
  });
  it('reports a partial indexing failure without inviting duplicate knowledge writes',async()=>{
    jest.spyOn(vectors,'addEmbedding').mockImplementation(()=>{throw new Error('denied');});
    const tools=createMemoryTools(((type:any)=>type===MemoryDataService?data:type===VectorsService?vectors:undefined) as any);
    const add=tools.find(t=>t.name==='knowledge_add')!;
    const result=await add.execute({title:'saved',content:'saved body'},{sessionId:'s',workspace:root,config:{},log:()=>{},broadcast:()=>{}});
    expect(result).toMatchObject({success:true,data:{indexWarning:expect.any(String)}});
    expect(data.listKnowledge()).toHaveLength(1);
  });
});
