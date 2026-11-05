const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const {NativeOfficeService}=require('../packages/backend/dist/modules/tools/files/native-office.service.js');
const {OfficeService}=require('../packages/backend/dist/modules/tools/files/office.service.js');
const dir=path.resolve('build/editor-2.0.1-work/qa');process.env.SKYALYTICWING_DATA_DIR=path.join(dir,'data');
const security={isPathAllowed:p=>(path.resolve(p)===dir||path.resolve(p).startsWith(dir+path.sep))};
const service=new NativeOfficeService(security),office=new OfficeService(security);let browser;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,timeout=90000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await sleep(200);}throw Error('Timed out');}
(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});
 for(const format of ['docx','xlsx','pptx']){
  const file=await office.create(dir,'Human and AI '+format,format),session=await service.open(file.path),page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',e=>console.log('page error',e.message));page.on('console',m=>{if(m.text().includes('Office menu:'))console.log(m.text());});
  await page.goto(session.url,{waitUntil:'commit'});await waitFor(()=>service.state(session.id).ready);console.log(format+' ready');
  assert.ok(await page.locator('#menus').isVisible(),'Chinese menu visible');
  if(format==='docx'){
   await service.live(file.path,'insert_text',{text:'人工与 AI 共用编辑器。'});
   await sleep(3000);await page.locator('#qtcanvas').click({position:{x:390,y:230}});console.log('click focus',await page.evaluate(()=>document.activeElement.tagName));await sleep(400);await page.keyboard.press('Control+End');await sleep(200);await page.keyboard.type(' Manual keyboard edit.',{delay:80});
   const ime=await page.context().newCDPSession(page);await ime.send('Input.imeSetComposition',{text:'zhongwen',selectionStart:8,selectionEnd:8});await ime.send('Input.insertText',{text:'中文输入验证'});await page.keyboard.press('Control+s');await page.screenshot({path:path.join(dir,'office-manual-input.png')});
  }else if(format==='xlsx'){
   await service.live(file.path,'set_cell',{row:0,column:0,value:'12'});await service.live(file.path,'set_cell',{row:1,column:0,value:'8'});await service.live(file.path,'set_cell',{row:2,column:0,value:'=SUM(A1:A2)'});await sleep(2000);await page.locator('#qtcanvas').click({position:{x:138,y:152}});await sleep(400);await page.keyboard.type('9',{delay:80});await page.keyboard.press('Enter');
  }else{
   await service.live(file.path,'insert_text',{text:'手动与 AI 编辑的演示文稿'});await service.live(file.path,'insert_slide');await service.live(file.path,'insert_text',{text:'第二页方案'});await sleep(2000);await page.locator('#qtcanvas').dblclick({position:{x:316,y:296}});await sleep(400);await page.keyboard.press('End');await page.keyboard.type(' Manual slide edit',{delay:80});await page.keyboard.press('Escape');
  }
  await sleep(1500);const before=service.state(session.id).savedAt;service.command(session.id,'save');await waitFor(()=>service.state(session.id).savedAt>before,20000);
  await sleep(2000);if(format==='docx')await waitFor(async()=>JSON.stringify(await office.read(file.path)).includes('Manual keyboard edit.'),20000);const contents=await office.read(file.path);fs.writeFileSync(path.join(dir,format+'-readback.json'),JSON.stringify(contents,null,2));
  if(format==='docx'){assert.ok(JSON.stringify(contents).includes('Manual keyboard edit.'),'manual keyboard text saved');assert.ok(JSON.stringify(contents).includes('人工'));assert.ok(JSON.stringify(contents).includes('中文输入验证'),'Chinese composition input saved');}
  if(format==='xlsx'){const XLSX=require('../packages/backend/node_modules/xlsx');const workbook=XLSX.readFile(file.path);const sheet=workbook.Sheets[workbook.SheetNames[0]];assert.equal(sheet.A3.v,20,'real formula calculation');assert.equal(sheet.B1.v,9,'manual cell edit');}
  if(format==='pptx'){assert.ok(JSON.stringify(contents).includes('第二页方案'));assert.equal(contents.sections.length,2);assert.ok(JSON.stringify(contents).includes('Manual slide edit'),'manual slide text');}
  await page.screenshot({path:path.join(dir,'office-'+format+'-verified.png')});
  if(format==='docx'){
   const cp=path.join(dir,'Menu saved copy.docx');const existing=fs.existsSync(cp);await page.locator('#menus > details').first().locator('summary').first().click();console.log('File menu:',(await page.locator('#menus > details').first().innerText()).slice(0,1000));
   const saveAs=page.locator('#menus button').filter({hasText:/^另存为\(/}).first();await saveAs.click();await page.locator('dialog input').fill('Menu saved copy.docx');await page.locator('dialog button').filter({hasText:'保存'}).click();await waitFor(()=>page.locator('#error').innerText().then(t=>t.includes('副本已保存')),20000);assert.ok(fs.existsSync(cp)||existing,'save copy persisted');
  }
  await page.close();console.log(format+' PASS');
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();service.onModuleDestroy();});
