import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../src/modules/tools/files/database.service';
import { PythonEnvService } from '../../src/modules/core/python/python-env.service';
describe('built-in SQLite workspace',()=>{
  let dir:string,path:string;const prior=process.env['SKYALYTICWING_DATA_DIR'];
  const security={isPathAllowed:jest.fn(()=>true)};const service=new DatabaseService(security as never,new PythonEnvService());
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'wing-db-'));path=join(dir,'office.sqlite');process.env['SKYALYTICWING_DATA_DIR']=dir;security.isPathAllowed.mockReturnValue(true);});
  afterEach(()=>{if(prior===undefined)delete process.env['SKYALYTICWING_DATA_DIR'];else process.env['SKYALYTICWING_DATA_DIR']=prior;rmSync(dir,{recursive:true,force:true});});
  it('creates, writes, reads schema/data and backs up the pre-write database',async()=>{
    await service.run({path,create:true});
    const saved=await service.run({path,write:true,sql:'INSERT INTO wing_notes(title,content) VALUES (?,?)',params:['中文标题','Content']});expect(saved['backup']).toBeTruthy();
    expect((await service.run({path,schema:true}))['tables']).toEqual(expect.arrayContaining([expect.objectContaining({name:'wing_notes'})]));
    expect((await service.run({path,sql:'SELECT title FROM wing_notes'}))['rows']).toEqual([['中文标题']]);
    expect((await service.run({path:String(saved['backup']),sql:'SELECT count(*) FROM wing_notes'}))['rows']).toEqual([[0]]);
  });
  it('rejects writes in read mode, outside paths and SQL database attachment',async()=>{
    await service.run({path,create:true});
    await expect(service.run({path,sql:'DELETE FROM wing_notes'})).rejects.toThrow();
    await expect(service.run({path,sql:"ATTACH DATABASE ':memory:' AS other",write:true})).rejects.toThrow();
    await expect(service.run({path,sql:'PRAGMA writable_schema=ON',write:true})).rejects.toThrow();
    security.isPathAllowed.mockReturnValue(false);await expect(service.run({path,schema:true})).rejects.toThrow('授权');
  });
});
