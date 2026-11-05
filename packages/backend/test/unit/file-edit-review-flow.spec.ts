import 'reflect-metadata';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createFileEditTool} from '../../src/extensions/bundled/files/tools/file-edit.js';
import {createFileReadTool} from '../../src/extensions/bundled/files/tools/file-read.js';
import {DocumentHistoryController} from '../../src/modules/tools/files/document-history.controller.js';
import {withDocumentSession} from '../../src/modules/tools/files/document-history.js';

describe('real file-edit → changes → confirmed undo/redo', () => {
  let root: string, project: string, file: string, old: string | undefined, security: any, ctx: any, controller: DocumentHistoryController;
  beforeEach(() => {
    root=realpathSync.native(mkdtempSync(join(tmpdir(),'wing-edit-review-'))); project=join(root,'project'); mkdirSync(project); file=join(project,'方案.txt');
    old=process.env['SKYALYTICWING_DATA_DIR']; process.env['SKYALYTICWING_DATA_DIR']=join(root,'data');
    security={isPathAllowed:(p:string)=>resolve(p)===project || resolve(p).startsWith(project+'\\') || resolve(p).startsWith(project+'/')};
    ctx={sessionId:'review-flow',workspace:project,config:{},log:()=>{},broadcast:()=>{}};
    controller=new DocumentHistoryController(security);
  });
  afterEach(() => {if(old===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=old;rmSync(root,{recursive:true,force:true});});
  const before='第一行\n第二行\n第三行\n';
  async function edit() {
    writeFileSync(file,before);
    const readResult=await createFileReadTool(security).execute({path:file},ctx);
    if(!readResult.success)throw new Error(JSON.stringify(readResult));
    const result=await withDocumentSession(ctx.sessionId,()=>createFileEditTool(security).execute({path:file,oldText:'第一行\n第二行',newText:'替换行\n新增一行\n新增二行'},ctx));
    expect(result.success).toBe(true);
    return result;
  }
  it('records the actual edit, accurate diff, confirms undo and redo, and rejects stale double submission',async()=>{
    const result=await edit();
    const after=readFileSync(file,'utf8');
    expect(after).toBe('替换行\n新增一行\n新增二行\n第三行\n');
    const changes=controller.list(project).changes;
    expect(changes).toHaveLength(1);expect(changes[0].sessionId).toBe('review-flow');
    const id=changes[0].id;
    const detail=await controller.detail(id);
    expect(detail).toMatchObject({state:'applied',added:3,removed:2,compatible:true});
    expect((result.data as any).diff).toContain('-第二行');
    expect((result.data as any).diff).toContain('+新增二行');
    await controller.restore(id,{state:'applied'});expect(readFileSync(file,'utf8')).toBe(before);
    await expect(controller.restore(id,{state:'applied'})).rejects.toThrow('状态已更新');
    expect(readFileSync(file,'utf8')).toBe(before);
    await controller.restore(id,{state:'undone'});expect(readFileSync(file,'utf8')).toBe(after);
    expect(controller.list(project).changes[0].state).toBe('applied');
  });
  it('does not overwrite a subsequent manual edit when undo is confirmed',async()=>{
    await edit(); const id=controller.list(project).changes[0].id;
    writeFileSync(file,'用户后续修改');
    expect((await controller.detail(id)).compatible).toBe(false);
    await expect(controller.restore(id,{state:'applied'})).rejects.toThrow();
    expect(readFileSync(file,'utf8')).toBe('用户后续修改');
  });
});
