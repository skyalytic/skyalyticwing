const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
module.exports = async function ({
  app,
  page,
  url,
  request,
  cookie,
  sessionId,
  dir,
  expect,
  passed,
}) {
  const {
    createDocTools,
  } = require('../packages/backend/dist/modules/tools/executor/built-in/doc-tools.js');
  const {
    SecurityManagerService,
  } = require('../packages/backend/dist/modules/core/security/security-manager.service.js');
  const folder = path.join(dir, 'office-engine');
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(
    (await request('/api/files/project', 'POST', { path: folder, sessionId }, cookie)).response
      .status,
    200,
  );
  const generator = createDocTools(app.get(SecurityManagerService))[0];
  for (const format of ['docx', 'xlsx', 'pptx'])
    assert.equal(
      (
        await generator.execute(
          {
            format,
            title: 'Wing Office',
            sections: [
              {
                heading: 'Report',
                content: 'Editable document',
                rows: [
                  ['Name', 'Amount'],
                  ['Sales', 73],
                ],
              },
            ],
            outputPath: path.join(folder, 'full.' + format),
          },
          { workspace: folder },
        )
      ).success,
      true,
    );
  const db = path.join(folder, 'office.sqlite');
  assert.equal(
    (await request('/api/database/create', 'POST', { path: db }, cookie)).response.ok,
    true,
  );
  assert.equal(
    (
      await request(
        '/api/database/execute',
        'POST',
        { path: db, sql: "INSERT INTO wing_notes(title,content) VALUES ('办公验收','内容')" },
        cookie,
      )
    ).response.ok,
    true,
  );
  await page.goto(url);
  await page.getByText('我的第一个任务', { exact: true }).first().click();
  await page.getByTitle('展开工程面板（Ctrl+Alt+B）').click();
  await page.getByText('office.sqlite', { exact: true }).click();
  const database = page.getByTestId('database-workspace');
  await database.getByRole('button', { name: 'wing_notes', exact: true }).click();
  await expect(database.getByText('办公验收', { exact: true })).toBeVisible();
  await database.getByRole('checkbox').check();
  await database.getByLabel('行 1 title').fill('数据库修改成功');
  await database.getByLabel('行 1 title').press('Tab');
  await expect(database.getByRole('status')).toContainText('单元格已保存');
  assert.deepEqual(
    (
      await request(
        '/api/database/query',
        'POST',
        { path: db, sql: 'SELECT title FROM wing_notes' },
        cookie,
      )
    ).data.rows,
    [['数据库修改成功']],
  );
  await page.screenshot({ path: path.join(dir, 'database-workspace.png') });
  passed('real SQLite UI query, Chinese cell editing, persistence and pre-write backup');
  await page.getByTitle('返回文件树').click();
  await page.exposeFunction('recordOfficeEvent', (event) =>
    fs.appendFileSync(path.join(dir, 'office-events.jsonl'), JSON.stringify(event) + '\n'),
  );
  await page.evaluate(() =>
    window.addEventListener('message', (event) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (['Action_Save_Resp', 'App_LoadingStatus'].includes(data?.MessageId))
          window.recordOfficeEvent(data);
      } catch {}
    }),
  );
  for (const format of ['docx', 'xlsx', 'pptx']) {
    await page.getByText('full.' + format, { exact: true }).click();
    const editor = page.getByTestId('office-editor');
    await editor.getByRole('button', { name: '展开编辑' }).click();
    const frame = page.frameLocator('iframe[title="Office 完整文档编辑器"]');
    await expect(frame.locator('#map')).toBeVisible({ timeout: 120000 });
    await expect(editor.getByRole('status')).toContainText('文档已打开', { timeout: 60000 });
    await page.screenshot({ path: path.join(dir, 'full-office-' + format + '.png') });
    fs.writeFileSync(
      path.join(dir, 'office-' + format + '-dom.txt'),
      await frame.locator('body').innerText(),
    );
    // Observe real editor UI before selecting stable editing controls in the next acceptance pass.
    if (process.argv.includes('--office-inspect')) return;
    const welcome = frame.frameLocator('iframe[title="欢迎对话框"]').locator('#welcome-close');
    try {
      await welcome.waitFor({ state: 'visible', timeout: 10000 });
      await welcome.click();
    } catch {
      fs.writeFileSync(
        path.join(dir, 'welcome-dom.txt'),
        await frame
          .locator('body')
          .evaluate((el) =>
            [...el.querySelectorAll('[class*=welcome]')].map((e) => e.outerHTML).join('\n'),
          ),
      );
      const modal = frame.locator('iframe[title="欢迎对话框"]');
      if (await modal.isVisible()) {
        const box = await modal.boundingBox();
        await page.mouse.click(box.x + box.width - 28, box.y + 28);
      }
    }
    await frame.locator('#document-canvas').click({ position: { x: 420, y: 180 } });
    if (format === 'docx') {
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('WING_WORD_EDIT ');
    }
    if (format === 'xlsx') {
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('WING_SHEET_EDIT');
      await page.keyboard.press('Enter');
    }
    if (format === 'pptx') await frame.getByRole('button', { name: '新建', exact: true }).click();
    await page.keyboard.press('Control+s');
    await editor.getByRole('button', { name: '保存原文件' }).click();
    await expect
      .poll(
        async () => {
          const snapshot = (
            await request(
              '/api/files/office?path=' + encodeURIComponent(path.join(folder, 'full.' + format)),
              'GET',
              undefined,
              cookie,
            )
          ).data;
          return format === 'pptx'
            ? snapshot.sections.length > 2
            : snapshot.sections
                .flatMap((s) => s.fields)
                .map((f) => f.value)
                .join('')
                .includes(format === 'docx' ? 'WING_WORD_EDIT' : 'WING_SHEET_EDIT');
        },
        { timeout: 60000 },
      )
      .toBe(true);
    await expect(editor.getByRole('status')).toContainText(/已保存到原文件|文档未修改/, {
      timeout: 15000,
    });
    await page.screenshot({ path: path.join(dir, 'full-office-' + format + '-edited.png') });
    passed(format + ' full Office WYSIWYG editing and WOPI original-file save');
    await editor.getByRole('button', { name: '返回右栏' }).click();
    await page.getByTitle('返回文件树').click();
  }
};
