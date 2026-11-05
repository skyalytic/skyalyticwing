import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpService } from '../../src/modules/tools/mcp/mcp.service';

describe('MCP startup child lifecycle', () => {
  let root: string, service: McpService;
  const old = process.env['SKYALYTICWING_DATA_DIR'];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wing-mcp-lifecycle-'));
    process.env['SKYALYTICWING_DATA_DIR'] = root;
    service = new McpService();
  });
  afterEach(() => {
    service.onModuleDestroy();
    if (old === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = old;
    rmSync(root, { recursive: true, force: true });
  });
  function fixture(mode: string) {
    const file = join(root, 'server.cjs'), pidFile = join(root, 'pid');
    writeFileSync(file, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(pidFile)},process.pid+'\\n');setInterval(()=>{},1000);require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize'&&${JSON.stringify(mode)}!=='wait')setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,...(${JSON.stringify(mode)}==='error'?{error:{message:'fixture rejected'}}:{result:{capabilities:{},serverInfo:{name:'fixture',version:'1'}}})})+'\\n'),50);});`);
    service.addServer({ id: 'fixture', name: 'fixture', command: process.execPath, args: [file], enabled: true });
    return pidFile;
  }
  async function waitFor(check: () => boolean) {
    for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error('Child process lifecycle condition timed out');
  }
  const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  it('cleans up a child whose initialize handshake failed', async () => {
    const file = fixture('error');
    await expect(service.startServer('fixture')).rejects.toThrow('fixture rejected');
    await waitFor(() => dead(Number(readFileSync(file, 'utf8').trim())));
    expect(service.listServers()[0].status).toBe('error');
  });
  it('redacts credentials in handshake and rate-limit errors received over stdio', async () => {
    const file=join(root,'errors.cjs');
    writeFileSync(file, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{message:'429 Retry-After: 60 '+process.env.API_KEY}})+'\\n')});`);
    service.addServer({id:'rate-limit',name:'Fixture',command:process.execPath,args:[file],env:{API_KEY:'sentinel-provider-key'},enabled:true});
    await expect(service.startServer('rate-limit')).rejects.toThrow('429 Retry-After: 60 [redacted]');
  });
  it('cancels a still-initializing child and keeps the server stopped', async () => {
    const file = fixture('wait');
    const result = service.startServer('fixture').catch(e => e);
    await waitFor(() => existsSync(file));
    service.stopServer('fixture');
    expect(await result).toBeInstanceOf(Error);
    await waitFor(() => dead(Number(readFileSync(file, 'utf8').trim())));
    expect(service.listServers()[0].status).toBe('stopped');
  });
  it('shares one startup child between concurrent connection requests', async () => {
    const file = fixture('success');
    await Promise.all([service.startServer('fixture'), service.startServer('fixture')]);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(service.listServers()[0].status).toBe('running');
    service.stopServer('fixture');
    await waitFor(() => dead(Number(readFileSync(file, 'utf8').trim())));
  });
});
