import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCodeVideoTool} from '../../src/modules/tools/executor/built-in/code-video.js';
import {validateVideoSvg} from '../../src/modules/tools/executor/built-in/code-video-worker.js';
import {runShell} from '../../src/extensions/bundled/shared/tools/shell-runner.js';
jest.mock('../../src/extensions/bundled/shared/tools/shell-runner.js',()=>({runShell:jest.fn()}));
describe('code video publishing',()=>{
  let root:string;
  beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'wing-code-video-'));jest.resetAllMocks();writeFileSync(join(root,'draw.js'),'() => `<svg xmlns="http://www.w3.org/2000/svg"/>`')});
  afterEach(()=>rmSync(root,{recursive:true,force:true}));
  const ctx=()=>({workspace:root,sessionId:'code-video',config:{},log:()=>{},broadcast:()=>{}});
  const tool=(allowed=true)=>createCodeVideoTool({isPathAllowed:()=>allowed} as never,{getAll:()=>({})} as never);
  const args=()=>({script_path:'draw.js',output:'result.mp4',duration_seconds:1,width:320,height:180,fps:24});
  it('publishes one video attachment without overwriting output and cleans owned temp files',async()=>{
    jest.mocked(runShell).mockImplementation(async(_exe,argv,options)=>{
      const job=JSON.parse(readFileSync(argv[1]!,'utf8'));
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');expect(options.env).not.toHaveProperty('NODE_OPTIONS');
      writeFileSync(job.output,'fixture video bytes');writeFileSync(job.report,JSON.stringify({method:'code'}));return {success:true};
    });
    const result=await tool().execute(args(),ctx());
    expect(result.success).toBe(true);expect(result.data).toMatchObject({file:join(root,'result.mp4'),kind:'video',method:'code',videoModelCalls:0});
    expect(readdirSync(root).some(name=>name.startsWith('.wing-code-video-'))).toBe(false);
    expect((await tool().execute(args(),ctx())).success).toBe(false);expect(runShell).toHaveBeenCalledTimes(1);
  });
  it('rejects denied paths, invalid geometry and cancellation without executing',async()=>{
    expect((await tool(false).execute(args(),ctx())).success).toBe(false);
    expect((await tool().execute({...args(),width:321},ctx())).success).toBe(false);
    const stop=new AbortController();stop.abort();expect((await tool().execute(args(),{...ctx(),signal:stop.signal})).success).toBe(false);
    expect(runShell).not.toHaveBeenCalled();
  });
  it('failed rendering leaves no output or temporary assets',async()=>{
    jest.mocked(runShell).mockImplementation(async(_exe,argv)=>{const job=JSON.parse(readFileSync(argv[1]!,'utf8'));writeFileSync(job.output,'partial');return {success:false,error:'cancelled'}});
    expect((await tool().execute(args(),ctx())).success).toBe(false);expect(readdirSync(root)).toEqual(['draw.js']);
  });
  it('accepts internal SVG references but rejects external resources',()=>{
    expect(()=>validateVideoSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#gradient)"/></svg>')).not.toThrow();
    for(const svg of ['<svg><image href="https://example.com/a.png"/></svg>','<svg><image href="file:///private.png"/></svg>','<!DOCTYPE svg><svg/>','<svg><script/></svg>','<html/>'])expect(()=>validateVideoSvg(svg)).toThrow();
  });
});
