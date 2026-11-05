import 'reflect-metadata';
import { createServer, type Server, type RequestListener } from 'node:http';
import { RemoteService } from '../../src/modules/core/remote/remote.service';
describe('remote request lifecycle',()=>{
  let server:Server,service:RemoteService;
  afterEach(async()=>{service?.onModuleDestroy();server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(()=>r()));});
  async function setup(handler:RequestListener){
    server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    service=new RemoteService({info(){},warn(){}} as never);
    // Inject a loopback fixture directly; production registration still enforces its network policy.
    const node={id:'fixture',name:'fixture',host:'127.0.0.1',port:(server.address() as {port:number}).port,status:'active',authKey:'synthetic',tasksCompleted:0};
    (service as unknown as {registry:Record<string,unknown>}).registry={fixture:node};
  }
  it('reports remote HTTP errors as failures',async()=>{
    await setup((_req,res)=>{res.statusCode=500;res.end('{"error":"fixture failure"}');});
    expect(await service.dispatchToRemote('fixture',{})).toMatchObject({success:false,error:'Remote HTTP 500'});
  });
  it('aborts outstanding requests on shutdown instead of leaving sockets alive',async()=>{
    let reached!:()=>void;const requestArrived=new Promise<void>(r=>{reached=r;});
    await setup(()=>reached());
    const pending=service.dispatchToRemote('fixture',{});await requestArrived;service.onModuleDestroy();
    expect(await pending).toMatchObject({success:false,error:'Remote service stopped'});
  });
});
