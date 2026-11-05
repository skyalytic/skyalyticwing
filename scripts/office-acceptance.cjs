// Real generator -> OOXML -> HTTP -> right panel -> autosave -> reload/conflict.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
module.exports = async function officeAcceptance({ app, page, url, request, cookie, sessionId, dir, expect, passed }) {
  const { createDocTools } = require('../packages/backend/dist/modules/tools/executor/built-in/doc-tools.js');
  const { SecurityManagerService } = require('../packages/backend/dist/modules/core/security/security-manager.service.js');
  const folder = path.join(dir, 'office'); fs.mkdirSync(folder, { recursive: true });
  assert.equal((await request('/api/files/project', 'POST', {path:folder, sessionId}, cookie)).response.status, 200);
  const generator = createDocTools(app.get(SecurityManagerService))[0];
  for (const format of ['docx','xlsx','pptx']) {
    const file = path.join(folder, 'office.' + format);
    const generated = await generator.execute({format,title:'Wing & 办公验收',sections:[{heading:'销售',content:'可编辑的办公正文',rows:[['项目','数值'],['销售',73]]}],outputPath:file}, {workspace:folder});
    assert.equal(generated.success,true,generated.error);
    const loaded = (await request('/api/files/office?path='+encodeURIComponent(file),'GET',undefined,cookie)).data;
    assert(loaded.sections.flatMap(s=>s.fields).some(f=>f.value==='73'));
    assert(loaded.sections.flatMap(s=>s.fields).some(f=>f.value.includes('Wing &')) || format==='xlsx');
  }
  await page.goto(url);
  await page.getByText('我的第一个任务',{exact:true}).first().click();
  await page.getByTitle('展开工程面板（Ctrl+Alt+B）').click();
  for (const format of ['docx','xlsx','pptx']) {
    await page.getByText('office.'+format,{exact:true}).click();
    await page.getByRole('button',{name:'临时使用基础内容编辑'}).click();
    const preview = page.getByTestId('office-preview');
    if(format==='pptx') await preview.getByRole('button',{name:'幻灯片 2',exact:true}).click();
    const input = preview.getByRole('textbox').filter({visible:true});
    await expect(input.first()).toBeVisible();
    const all = await input.all(); let target;
    for (const field of all) if(await field.inputValue()==='73') target=field;
    assert(target,'Numeric table value should be editable in '+format);
    await target.fill('85');
    await expect(preview.getByRole('status')).toHaveText('已保存',{timeout:10000});
    const file=path.join(folder,'office.'+format);
    const loaded=(await request('/api/files/office?path='+encodeURIComponent(file),'GET',undefined,cookie)).data;
    const field=loaded.sections.flatMap(s=>s.fields).find(f=>f.value==='85'); assert(field);
    await page.screenshot({path:path.join(dir,'office-'+format+'.png')});
    // External save must not be overwritten by the UI's stale revision.
    const external=await request('/api/files/office','POST',{path:file,revision:loaded.revision,changes:[{id:field.id,value:'90'}]},cookie);
    assert.equal(external.response.ok,true);
    await target.fill('95');
    await expect(preview.getByRole('alert')).toContainText('修改',{timeout:10000});
    const final=(await request('/api/files/office?path='+encodeURIComponent(file),'GET',undefined,cookie)).data;
    assert.equal(final.sections.flatMap(s=>s.fields).find(f=>f.id===field.id).value,'90');
    await page.getByTitle('返回文件树').click();
    passed(format+' real generation, right-panel editing, autosave, reload and conflict protection');
  }
};
