const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {NativeOfficeService}=require('../packages/backend/dist/modules/tools/files/native-office.service.js');
const qa=path.resolve('build/file-workspace-2.0.1/qa');
process.env.SKYALYTICWING_DATA_DIR=path.join(qa,'data');
const service=new NativeOfficeService({isPathAllowed:p=>p.startsWith(qa+path.sep)});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn){const until=Date.now()+90000;while(Date.now()<until){if(await fn())return;await sleep(200);}throw Error('Office fixture timed out');}
let browser,page;
(async()=>{
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const name of ['新建 DOCX 文档.docx','新建 PPT 演示文稿.ppt','新建 XLSX 工作表.xlsx']){
  const original=path.join('D:/新建文件夹',name),before=fs.readFileSync(original),file=path.join(qa,'副本-'+Date.now()+'-'+name);
  fs.copyFileSync(original,file,fs.constants.COPYFILE_EXCL);
  let s=await service.open(file);page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto(s.url,{waitUntil:'commit'});await wait(()=>{const state=service.state(s.id);if(state.error)throw Error(state.error);return state.ready;});
  await sleep(2000);await page.screenshot({path:path.join(qa,'actual-'+path.extname(name).slice(1)+'-opened.png')});
  if(name.endsWith('.xlsx'))await service.live(file,'set_cell',{row:0,column:0,value:'20'});
  else await service.live(file,'insert_text',{text:'Wing 文件副本编辑验证'});
  const prior=service.state(s.id).savedAt;service.command(s.id,'save');await wait(()=>{const state=service.state(s.id);if(state.error)throw Error(state.error);return state.savedAt>prior&&!state.dirty;});
  await page.close();service.release(s.id);s=await service.open(file);page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto(s.url,{waitUntil:'commit'});await wait(()=>{const state=service.state(s.id);if(state.error)throw Error(state.error);return state.ready;});
  await sleep(2000);await page.screenshot({path:path.join(qa,'actual-'+path.extname(name).slice(1)+'-verified.png')});
  assert.ok(fs.readFileSync(original).equals(before),'original unchanged');
  await page.close();service.release(s.id);console.log(name+' copy open/edit/save/reopen PASS; original preserved');
 }
})().catch(async e=>{console.error(e);if(page&&!page.isClosed())await page.screenshot({path:path.join(qa,'actual-failure.png')});process.exitCode=1;}).finally(async()=>{await browser?.close();service.onModuleDestroy();});
