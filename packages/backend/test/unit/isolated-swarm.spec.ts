import { SubagentService } from '../../src/modules/ai/agent/subagent.service';

describe('isolated tasks use the shared swarm lifecycle',()=>{
  const swarm={createSubAgent:jest.fn(),executeSync:jest.fn(),listActiveAgents:jest.fn()};
  const ws={broadcast:jest.fn()};
  const service=new SubagentService({} as never,ws as never,{getDefaultModel:()=> 'default'} as never,swarm as never);
  beforeEach(()=>{jest.clearAllMocks();swarm.createSubAgent.mockReturnValue({id:'isolated-child'});swarm.executeSync.mockResolvedValue({success:true,result:'done',calls:250});});
  it('has no implicit 200-turn cutoff and uses the common cancellation queue',async()=>{
    const result=await service.executeIsolated('long task',{sessionId:'parent'});
    expect(result).toMatchObject({success:true,output:'done',iterations:250});
    const config=swarm.createSubAgent.mock.calls[0][1];
    expect(config).not.toHaveProperty('maxIterations');expect(config.inheritTools).toBe(false);
    expect(swarm.executeSync).toHaveBeenCalledWith('isolated-child');
  });
  it('preserves explicit budgets and tool allowlists and reports failures honestly',async()=>{
    swarm.executeSync.mockResolvedValue({success:false,error:'cancelled',calls:2});
    const result=await service.executeIsolated('task',{maxIterations:7,tools:['read_file']});
    expect(swarm.createSubAgent.mock.calls[0][1]).toMatchObject({maxIterations:7,tools:['read_file'],allowDelegation:false});
    expect(result).toMatchObject({success:false,error:'cancelled',iterations:2});expect(ws.broadcast).not.toHaveBeenCalled();
  });
  it('reports only currently running isolated agents',()=>{
    swarm.listActiveAgents.mockReturnValue([{type:'isolated',status:'running'},{type:'worker',status:'running'},{type:'isolated',status:'dispatching'}]);
    expect(service.getIsolatedStatus()).toEqual({running:1,maxIterations:null});
  });
});
