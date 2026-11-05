import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createFileReadTool } from '../../src/modules/tools/executor/built-in/file-read.js';
import { repairBinaryFileReadContent } from '../../src/modules/tools/files/file-content-kind.js';
import { visualObservation } from '../../src/modules/ai/agent/visual-observation.js';

describe('binary files never become model text',()=>{
  let directory:string;
  beforeEach(async()=>{ directory=await mkdtemp(join(tmpdir(),'wing-file-read-')); });
  afterEach(async()=>{ await rm(directory,{recursive:true,force:true}); });
  const context={workspace:'',sessionId:'binary-fixture',config:{},log(){},broadcast(){}};
  it('reads actual PNG as an image observation and strips base64 from saved tool text',async()=>{
    const file=join(directory,'frame.png');
    await sharp({create:{width:1920,height:1080,channels:3,background:'#123456'}}).png().toFile(file);
    const tool=createFileReadTool({isPathAllowed:()=>true} as never);
    const result=await tool.execute({path:file},context);
    expect(result.success).toBe(true);
    const converted=visualObservation(result,'gpt-4o','openai');
    expect(Array.isArray(converted.message?.content)).toBe(true);
    expect(JSON.stringify(converted.result).length).toBeLessThan(1000);
    expect(JSON.stringify(converted.result)).not.toContain('base64');
    expect(result.output).not.toContain('\uFFFD');
  });
  it('binary format detection precedes byte pagination and does not affect long valid UTF-8',async()=>{
    const tool=createFileReadTool({isPathAllowed:()=>true} as never);
    const zip=join(directory,'data.txt');await writeFile(zip,Buffer.from([80,75,3,4,0,10,255]));
    const result=await tool.execute({path:zip,byteOffset:0},context);
    expect(result.success).toBe(false);expect(result.data).toMatchObject({binary:true});
    const text=join(directory,'valid.txt'),value='正常中文 🛶\n'.repeat(20000);
    await writeFile(text,value);
    expect((await tool.execute({path:text},context)).output).toBe(value);
  });
  it('only replaces corrupt binary reads in the request, preserving originals and valid text',()=>{
    const corrupt=JSON.stringify({success:true,output:'PNG'+ '\uFFFD'.repeat(1000),data:{path:'E:/frame.png'}});
    const cleaned=repairBinaryFileReadContent(corrupt,'file-read');
    expect(JSON.parse(cleaned).data).toMatchObject({path:'E:/frame.png',recovered:true});
    expect(corrupt).toContain('\uFFFD');
    expect(repairBinaryFileReadContent(corrupt,'powershell')).toBe(corrupt);
    const valid=JSON.stringify({success:true,output:'normal text',data:{path:'E:/frame.png'}});
    expect(repairBinaryFileReadContent(valid,'file-read')).toBe(valid);
    expect(repairBinaryFileReadContent('null','file-read')).toBe('null');
  });
});
