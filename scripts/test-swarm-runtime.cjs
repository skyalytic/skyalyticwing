// Exercise the compiled swarm and real streaming HTTP transport with an isolated local provider.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const deploy=path.resolve(process.argv[2]||'packages/backend/deploy');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'wing-swarm-runtime-'));
process.env.SKYALYTICWING_DATA_DIR=data;process.env.SKYALYTICWING_WEB_DATA_DIR=data;
const req=require('node:module').createRequire(path.join(deploy,'package.json'));
const {AgentSwarmService}=req('./dist/modules/ai/agent/agent-swarm.service.js');
const {OpenAIAdapter}=req('./dist/modules/ai/llm/openai-adapter.js');
const {ChatControlRegistry}=req('./dist/modules/ai/chat/chat-control.registry.js');
let active=0,peak=0,mode='answer',started=()=>{};
const server=http.createServer((request,response)=>{
  let body='';request.on('data',b=>body+=b);request.on('end',()=>{
    const parsed=JSON.parse(body);assert.equal(request.url,'/v1/chat/completions');
    active++;peak=Math.max(peak,active);let closed=false;
    const finish=()=>{if(!closed){closed=true;active--;}};response.once('close',finish);
    response.writeHead(200,{'Content-Type':'text/event-stream'});response.flushHeaders();started();
    if(mode==='hold')return;
    setTimeout(()=>{
      if(closed)return;
      response.end('data: '+JSON.stringify({choices:[{delta:{content:'Completed '+parsed.messages.at(-1).content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
      finish();
    },40);
  });
});
let swarm;
(async()=>{
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const adapter=new OpenAIAdapter(),logger={info(){},warn(){},error(){},debug(){}};
    const llm={getDefaultModel:()=> 'fixture',async chatSync(params){let content='';for await(const c of adapter.chat(params,{id:'fixture',type:'openai',apiKey:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,models:[]})){if(c.type==='error')throw Error(c.error);if(c.type==='content')content+=c.content;}return {content};}};
    swarm=new AgentSwarmService(logger,{broadcast(){}},llm);swarm.onModuleInit();
    const tasks=Array.from({length:8},(_,i)=>'question '+i);
    const results=await Promise.all([swarm.spawnSwarm('one',tasks),swarm.spawnSwarm('two',tasks)]);
    assert.equal(peak,5);assert.equal(swarm.getRunningCount(),0);
    for(const r of results){assert.equal(r.completed,8);assert.equal(r.failed,0);assert.deepEqual(r.results.map(x=>x.result),tasks.map(t=>'Completed '+t));}
    console.log('PASS compiled runtime: 16 tasks in two swarms, concurrency 5, ordered complete results');
    mode='hold';let arrivals=0;const entered=new Promise(resolve=>{started=()=>{if(++arrivals===5)resolve();};});
    const pending=swarm.spawnSwarm('cancel-parent',Array.from({length:8},()=> 'wait'));
    await entered;ChatControlRegistry.requestAbort('cancel-parent');
    const cancelled=await pending;assert.equal(cancelled.failed,8);assert.equal(swarm.getRunningCount(),0);ChatControlRegistry.clearAbort('cancel-parent');
    console.log('PASS compiled runtime: parent cancellation aborts real HTTP streams and queued children');
    mode='answer';const recovery=await swarm.spawnSwarm('next',['next task']);assert.equal(recovery.completed,1);
    swarm.onModuleDestroy();swarm=new AgentSwarmService(logger,{broadcast(){}},llm);swarm.onModuleInit();
    assert.ok(swarm.listHistory().some(a=>a.result==='Completed next task'));
    console.log('PASS compiled runtime: queue reused after cancellation; durable results survive service restart');
  } finally {
    swarm?.onModuleDestroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    fs.rmSync(data,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
