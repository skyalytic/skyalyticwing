import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileWriteTool } from '../../src/modules/tools/executor/built-in/file-write';
import { createFileEditTool } from '../../src/modules/tools/executor/built-in/file-edit';
import { createFileDeleteTool } from '../../src/modules/tools/executor/built-in/file-delete';
describe('file tools require write access',()=>{
  it('refuses write, edit and delete under a read-only grant, preserving the file',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'wing-readonly-')),path=join(dir,'kept.txt');writeFileSync(path,'original');
    const security={isPathAllowed:(_path:string,mode='read')=>mode==='read'};
    try {
      for(const [tool,args] of [[createFileWriteTool(security as never),{path,content:'overwrite'}],[createFileEditTool(security as never),{path,oldText:'original',newText:'overwrite'}],[createFileDeleteTool(security as never),{paths:[path]}]] as const){
        expect((await tool.execute(args,{workspace:dir} as never)).success).toBe(false);expect(readFileSync(path,'utf8')).toBe('original');
      }
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
