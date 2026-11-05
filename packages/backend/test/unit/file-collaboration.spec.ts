import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileReadTool } from '../../src/modules/tools/executor/built-in/file-read';
import { createFileWriteTool } from '../../src/modules/tools/executor/built-in/file-write';
import { createFileEditTool } from '../../src/modules/tools/executor/built-in/file-edit';
describe('expert file conflict detection',()=>{
  let root:string;const prior=process.env['SKYALYTICWING_DATA_DIR'];
  const security={isPathAllowed:()=>true};const read=createFileReadTool(security as never),write=createFileWriteTool(security as never);
  beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'wing-conflict-'));process.env['SKYALYTICWING_DATA_DIR']=root;writeFileSync(join(root,'plan.txt'),'original');});
  afterEach(()=>{if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(root,{recursive:true,force:true});});
  it('rejects stale expert writes and succeeds after reading and merging',async()=>{
    const a={sessionId:'sub-a',workspace:root} as never,b={sessionId:'sub-b',workspace:root} as never;
    await read.execute({path:'plan.txt'},a);await read.execute({path:'plan.txt'},b);
    expect((await write.execute({path:'plan.txt',content:'A change'},a)).success).toBe(true);
    const conflict=await write.execute({path:'plan.txt',content:'B stale change'},b);expect(conflict.success).toBe(false);expect(conflict.error).toContain('另一位专家');
    expect(readFileSync(join(root,'plan.txt'),'utf8')).toBe('A change');
    await read.execute({path:'plan.txt'},b);expect((await write.execute({path:'plan.txt',content:'A + B merged'},b)).success).toBe(true);
  });
  it('requires a subagent to inspect an existing file before replacing it',async()=>{
    expect((await write.execute({path:'plan.txt',content:'blind overwrite'},{sessionId:'sub-new',workspace:root} as never)).success).toBe(false);
  });
  it('local edits use the workspace, reject stale reads and refresh their observed version', async () => {
    const edit = createFileEditTool(security as never);
    const ctx = { sessionId: 'sub-edit', workspace: root } as never;
    await read.execute({ path: 'plan.txt' }, ctx);
    writeFileSync(join(root, 'plan.txt'), 'external original');
    expect((await edit.execute({ path: 'plan.txt', oldText: 'original', newText: 'changed' }, ctx)).success).toBe(false);
    expect(readFileSync(join(root, 'plan.txt'), 'utf8')).toBe('external original');
    await read.execute({ path: 'plan.txt' }, ctx);
    expect((await edit.execute({ path: 'plan.txt', oldText: 'original', newText: 'changed' }, ctx)).success).toBe(true);
    expect((await edit.execute({ path: 'plan.txt', oldText: 'changed', newText: 'final' }, ctx)).success).toBe(true);
    expect(readFileSync(join(root, 'plan.txt'), 'utf8')).toBe('external final');
  });
});
