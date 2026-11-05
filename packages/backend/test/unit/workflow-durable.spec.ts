import 'reflect-metadata';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowService } from '../../src/modules/workflow/workflow.service';
describe('durable expert workflows', () => {
  let root:string, service:WorkflowService;const prior=process.env['SKYALYTICWING_DATA_DIR'];
  const llm={chatSync:jest.fn(),getDefaultModel:()=> 'default'};
  const agents={getAgent:jest.fn(),getTeam:jest.fn()};
  const swarm={createSubAgent:jest.fn(),executeSync:jest.fn(),destroyAgent:jest.fn()};
  const create=()=>new WorkflowService({error:jest.fn()} as never,llm as never,agents as never,swarm as never);
  const step=(id:string,extra={})=>({id,name:id,prompt:'do '+id,...extra});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  beforeEach(()=>{jest.resetAllMocks();root=mkdtempSync(join(tmpdir(),'wing-workflow-'));process.env['SKYALYTICWING_DATA_DIR']=root;
    llm.chatSync.mockResolvedValue({content:'done',usage:{totalTokens:12}});service=create();service.onModuleInit();});
  afterEach(()=>{service.onModuleDestroy();if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(root,{recursive:true,force:true});});
  it('persists completed DAG outputs, resolves dependencies and survives reload',async()=>{
    const wf=service.createWorkflow({name:'DAG',steps:[step('merge',{dependsOn:['a','b']}),step('a',{dependsOn:[]}),step('b',{dependsOn:[]})]}).workflow!;
    service.runWorkflow(wf.id);await tick();expect(service.getRunLogs(wf.id)[0].status).toBe('success');
    expect(llm.chatSync.mock.calls[2][0].messages[1].content).toContain('步骤 a');
    const restarted=create();restarted.onModuleInit();expect(restarted.getRunLogs(wf.id)[0].stepResults.map(s=>s.stepId)).toEqual(['a','b','merge']);
  });
  it('rejects invalid edits without mutating the original workflow',()=>{
    const wf=service.createWorkflow({name:'valid',steps:[step('a')]}).workflow!;
    expect(service.updateWorkflow(wf.id,{name:'changed',steps:[step('a',{dependsOn:['a']})]}).success).toBe(false);
    expect(service.readWorkflow(wf.id)?.name).toBe('valid');
    expect(service.createWorkflow({name:'empty',steps:[step('a',{prompt:''})]}).success).toBe(false);
  });
  it('pauses before review, approves once, and does not replay completed steps',async()=>{
    const wf=service.createWorkflow({name:'review',steps:[step('a'),step('b',{reviewBefore:true})]}).workflow!;
    const run=service.runWorkflow(wf.id).run!;await tick();expect(service.getRunLogs(wf.id)[0].status).toBe('paused');
    expect(service.runWorkflow(wf.id).success).toBe(false);expect(service.deleteWorkflow(wf.id).success).toBe(false);
    expect(service.control(wf.id,run.id,'resume').success).toBe(false);
    expect(service.control(wf.id,run.id,'approve').success).toBe(true);await tick();
    expect(llm.chatSync).toHaveBeenCalledTimes(2);expect(service.getRunLogs(wf.id)[0].status).toBe('success');
  });
  it('dispatches the selected expert with its model, role, tools and bounded budget',async()=>{
    agents.getAgent.mockReturnValue({id:'writer',name:'Writer',model:'expert-model',systemPrompt:'editor role',tools:['read_file'],callable:true});
    swarm.createSubAgent.mockReturnValue({id:'child'});swarm.executeSync.mockResolvedValue({success:true,result:'expert output',calls:2,tokens:54});
    const wf=service.createWorkflow({name:'expert',steps:[step('a',{agentId:'writer'})],budget:{maxCalls:3,maxDurationMs:10000}}).workflow!;
    service.runWorkflow(wf.id);await tick();
    expect(swarm.createSubAgent.mock.calls[0][1]).toMatchObject({model:'expert-model',systemPrompt:'editor role',tools:['read_file'],maxIterations:3,allowDelegation:false});
    expect(service.getRunLogs(wf.id)[0]).toMatchObject({status:'success',calls:2,stepResults:[{agentId:'writer',tokens:54}]});
  });
  it('stops after the call budget, rejects disabled workflows and does not accept empty results',async()=>{
    const wf=service.createWorkflow({name:'budget',steps:[step('a'),step('b')],budget:{maxCalls:1,maxDurationMs:10000}}).workflow!;
    service.runWorkflow(wf.id);await tick();expect(llm.chatSync).toHaveBeenCalledTimes(1);expect(service.getRunLogs(wf.id)[0].error).toContain('预算');
    service.updateWorkflow(wf.id,{enabled:false});expect(service.runWorkflow(wf.id).success).toBe(false);
    llm.chatSync.mockResolvedValue({content:''});const empty=service.createWorkflow({name:'empty',steps:[step('a')]}).workflow!;service.runWorkflow(empty.id);await tick();expect(service.getRunLogs(empty.id)[0].status).toBe('error');
  });
  it('marks crash-interrupted runs and requires consent before retrying unknown side effects',async()=>{
    const wf=service.createWorkflow({name:'crash',steps:[step('a')]}).workflow!;
    llm.chatSync.mockResolvedValue({content:'ok'});service.runWorkflow(wf.id);await tick();
    const path=join(root,'workflows.json'),data=JSON.parse(readFileSync(path,'utf8'));
    data.runs[wf.id][0].status='running';data.runs[wf.id][0].activeStepId='a';data.runs[wf.id][0].stepResults=[];
    writeFileSync(path,JSON.stringify(data));const restarted=create();restarted.onModuleInit();const run=restarted.getRunLogs(wf.id)[0];
    expect(run.status).toBe('interrupted');expect(restarted.control(wf.id,run.id,'resume').success).toBe(false);
    expect(restarted.control(wf.id,run.id,'resume',true).success).toBe(true);await tick();expect(restarted.getRunLogs(wf.id)[0].status).toBe('success');
  });
  it('aborts an in-flight request and never starts the next step',async()=>{
    llm.chatSync.mockImplementation(({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
    const wf=service.createWorkflow({name:'cancel',steps:[step('a'),step('b')]}).workflow!;const run=service.runWorkflow(wf.id).run!;
    service.control(wf.id,run.id,'cancel');await tick();expect(llm.chatSync).toHaveBeenCalledTimes(1);expect(service.getRunLogs(wf.id)[0].status).toBe('cancelled');
  });
  it('passes and saves the full predecessor output beyond 12000 characters',async()=>{
    const output='x'.repeat(16000)+'IMPORTANT-END';
    llm.chatSync.mockResolvedValueOnce({content:output}).mockResolvedValueOnce({content:'reviewed'});
    const wf=service.createWorkflow({name:'full output',steps:[step('a'),step('b')]}).workflow!;
    const run=service.runWorkflow(wf.id).run!;await tick();
    expect(llm.chatSync.mock.calls[1][0].messages[1].content).toContain(output);
    expect(readFileSync(join(root,'workflow-runs',run.id,'step-1.txt'),'utf8')).toBe(output);
    expect(service.getRunLogs(wf.id)[0].status).toBe('success');
  });
  it('allows stopping a running model request',async()=>{
    service=new WorkflowService({error:jest.fn()} as never,llm as never);service.onModuleInit();
    llm.chatSync.mockImplementation(({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
    const wf=service.createWorkflow({name:'cancel',steps:[step('a')]}).workflow!;
    const run=service.runWorkflow(wf.id).run!;
    expect(service.control(wf.id,run.id,'cancel').success).toBe(true);await tick();
    expect(service.getRunLogs(wf.id)[0].status).toBe('cancelled');
  });
  it('rejects resuming an old failed run while a new run is paused',async()=>{
    llm.chatSync.mockRejectedValueOnce(new Error('offline'));
    const wf=service.createWorkflow({name:'no overlap',steps:[step('a'),step('b',{reviewBefore:true})]}).workflow!;
    const first=service.runWorkflow(wf.id).run!;await tick();
    service.runWorkflow(wf.id);await tick();
    expect(service.control(wf.id,first.id,'resume',true).success).toBe(false);
    service.control(wf.id,first.id,'cancel');
    expect(service.readWorkflow(wf.id)?.lastRunStatus).toBe('paused');
  });
});

