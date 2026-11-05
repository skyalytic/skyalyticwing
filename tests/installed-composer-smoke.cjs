// Full production UI served by the installed backend, using an isolated local profile.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  net = require('node:net'),
  assert = require('node:assert/strict');
const { spawn } = require('node:child_process'),
  { randomBytes, createHash } = require('node:crypto'),
  { chromium } = require('playwright-core');
const install = 'D:/skyalyticwing',
  deploy = path.join(install, '_up_/packages/backend/deploy'),
  qa = path.resolve(process.env.WING_COMPOSER_QA_DIR || 'build/composer-2.0.1-qa');
fs.mkdirSync(qa, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-installed-composer-')),
  project = path.join(data, 'project');
fs.mkdirSync(project);
const file = path.join(project, 'example.ts');
fs.writeFileSync(file, 'const title = "实际安装版引用";\nconst count = 7;\n');
fs.writeFileSync(
  path.join(data, 'config.json'),
  JSON.stringify({
    security: { yolo: 'ask', allowedPaths: [data] },
    general: { projectDir: project },
  }),
);
const token = randomBytes(32).toString('hex'),
  headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
let child,
  browser,
  page,
  base,
  logs = '';
const ownedTerminals = [];
const checks = [],
  errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(route, method = 'GET', body) {
  const r = await fetch(base + '/api' + route, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const v = await r.json();
  if (!r.ok || v.success === false) throw Error(route + ': ' + JSON.stringify(v));
  return 'success' in v ? v.data : v;
}
(async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  base = 'http://127.0.0.1:' + port;
  child = spawn(
    path.join(install, 'node.exe'),
    [path.join(deploy, 'desktop-main.cjs'), '--port', String(port)],
    {
      cwd: data,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SKYALYTICWING_DATA_DIR: data,
        SKYALYTICWING_WEB_DATA_DIR: data,
        APPDATA: data,
        LOCALAPPDATA: data,
        XDG_CONFIG_HOME: data,
        SKYALYTICWING_AUTH_TOKEN: token,
      },
    },
  );
  child.stdout.on('data', (b) => (logs = (logs + b).slice(-12000)));
  child.stderr.on('data', (b) => (logs = (logs + b).slice(-12000)));
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw Error('Installed server exited');
    if (
      await fetch(base + '/health')
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  assert.ok(ready);
  const html = await fetch(base).then((r) => r.text()),
    asset = html.match(/src="([^"\s]+\.js)"/);
  assert.ok(asset);
  const bytes = Buffer.from(await (await fetch(new URL(asset[1], base))).arrayBuffer());
  const expected = fs.readFileSync(path.join(deploy, 'frontend', asset[1].replace(/^\//, '')));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    createHash('sha256').update(expected).digest('hex'),
  );
  await call('/skills', 'POST', {
    name: 'qa-reference',
    description: '安装目录实测技能',
    content: '请读取文档并检查保存后的结果。',
  });
  await call('/files/write', 'POST', {
    path: file,
    content: 'const title = "实际安装版引用";\nconst count = 8;\n',
  });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => {
    if (new URL(r.url()).pathname === '/api/terminal/open') {
      const v = await r.json().catch(() => null);
      const id = v?.data?.id || v?.id;
      if (id) ownedTerminals.push(id);
    }
  });
  await page.addInitScript(
    ({ token }) => {
      localStorage.setItem('skyalyticwing.auth.token', token);
      localStorage.setItem('app.language', 'zh-CN');
      if (!localStorage.getItem('app.settings'))
        localStorage.setItem(
          'app.settings',
          JSON.stringify({ theme: 'light', interfaceLang: 'zh-CN' }),
        );
    },
    { token },
  );
  await page.goto(base);
  const composer = page.locator('.sky-composer'),
    input = composer.locator('textarea'),
    picker = () => page.locator('.wing-composer-picker');
  await composer.waitFor({ timeout: 45000 });
  if (process.env.WING_TOOLBAR_ONLY === '1') {
    const toolbar = composer.locator('.sky-composer-toolbar');
    const permission = toolbar.locator('.sky-permission-picker > button');
    await permission.waitFor();
    await permission.click();
    await page.getByRole('menuitemradio', { name: /完全访问/ }).click();
    await permission.filter({hasText:'完全访问'}).waitFor();
    for (const width of [1440, 1100, 800]) {
      await page.setViewportSize({width,height:960});
      const row = await toolbar.boundingBox(), control = await permission.boundingBox();
      assert.ok(Math.abs(control.y + control.height/2 - row.y - row.height/2) < 2, 'permission must share toolbar row');
      assert.ok(row.height < 40, 'toolbar must stay on one row');
      const items = await toolbar.locator(':scope > *').evaluateAll(nodes => nodes.map(node => {
        const r=node.getBoundingClientRect();return {left:r.left,right:r.right};
      }));
      assert.ok(items.every((item,index) => index === 0 || item.left >= items[index-1].right - 1), 'toolbar controls do not overlap');
      assert.ok(items.at(-1).right <= row.x + row.width + 1, 'toolbar stays inside composer');
      await permission.click();
      const menu = page.getByRole('menu', {name:'操作审批方式'});
      await menu.waitFor();
      const bounds = await menu.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'permission menu stays within window');
      await page.keyboard.press('Escape');
      await page.screenshot({path:path.join(qa,`toolbar-${width}.png`),animations:'disabled'});
    }
    checks.push('安装版 1440/1100/800 窗口：完全访问与其他控件同排，菜单可切换且不超出窗口');
    fs.writeFileSync(path.join(qa,'installed-ui.json'),JSON.stringify({checks,errors,install},null,2));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks,errors},null,2));
    return;
  }
  assert.equal(await composer.getByRole('button', { name: '引用文件', exact: true }).count(), 0);
  assert.equal(await composer.getByRole('button', { name: '计划', exact: true }).count(), 0);
  assert.equal(await composer.getByRole('button', { name: '添加引用', exact: true }).count(), 0);
  assert.equal(await composer.getByRole('button', { name: '命令、技能与插件', exact: true }).count(), 0);
  await composer.getByRole('button',{name:'选择文件夹',exact:true}).click();
  await page.getByPlaceholder('D:\\projects\\my-app').fill(project);
  await page.getByRole('button',{name:'确定',exact:true}).click();
  await composer.getByRole('button',{name:'project',exact:true}).waitFor();
  const trigger = async (text) => {
    await input.fill('');
    await input.pressSequentially(text);
    await picker().getByRole('option').first().waitFor();
  };
  const option = (label) =>
    picker()
      .getByRole('option')
      .filter({ has: page.locator('strong').filter({ hasText: new RegExp('^' + label + '$') }) });
  await trigger('@');
  await option('文件').click();
  await option('example.ts').click();
  await composer.getByRole('button', { name: '查看引用：example.ts', exact: true }).click();
  await page.getByRole('button', { name: '打开来源', exact: true }).click();
  await page.locator('.cm-content').filter({ hasText: '实际安装版引用' }).waitFor();
  await composer.getByRole('button', { name: '移除引用', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.down('Shift');
  await page.keyboard.press('End');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+u');
  await composer.getByRole('button', { name: '查看引用：example.ts 1–1' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /实际安装版引用/);
  await page.screenshot({ path: path.join(qa, 'installed-selection.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await composer.locator('.wing-composer-input .sky-browser-annotation-chip').waitFor();
  await page.screenshot({ path: path.join(qa, 'installed-composer.png'), animations: 'disabled' });
  await composer.getByRole('button', { name: '移除引用', exact: true }).click();
  checks.push('安装版完整界面：真实文件接口 → 打开来源 → 编辑器选区 Ctrl+U → 引用详情 → 移除');
  await trigger('/qa-reference');
  await option('qa-reference').click();
  await composer.getByRole('button', { name: '查看引用：qa-reference' }).click();
  assert.match(await page.locator('.wing-context-detail').innerText(), /读取文档/);
  await page.keyboard.press('Escape');
  await composer.getByRole('button', { name: '移除引用', exact: true }).click();
  await trigger('/');
  await picker().getByRole('button', { name: '管理技能', exact: true }).click();
  await page.waitForURL('**/skills');
  await page.getByText('安装目录实测技能', { exact: true }).waitFor();
  await page.goto(base);
  await composer.waitFor();
  await trigger('/');
  await picker().getByRole('button', { name: '管理插件', exact: true }).click();
  await page.waitForURL('**/plugins?tab=local');
  checks.push('安装版技能真实读写及完整技能/插件管理页面跳转');
  await page.goto(base + '/settings?tab=personalize');
  const plan = page.getByRole('switch', { name: '任务先规划，确认后执行' });
  await plan.click();
  assert.equal(await plan.getAttribute('aria-checked'), 'true');
  await page.reload();
  assert.equal(await plan.getAttribute('aria-checked'), 'true');
  await plan.click();
  checks.push('安装版设置计划开关持久化');
  await page.goto(base);
  await composer.waitFor();
  await composer.getByRole('button',{name:'选择文件夹',exact:true}).click();
  await page.getByPlaceholder('D:\\projects\\my-app').fill(project);
  await page.getByRole('button',{name:'确定',exact:true}).click();
  await composer.getByRole('button',{name:'project',exact:true}).waitFor();
  await trigger('/changes');
  await picker().getByRole('option').click();
  await page.locator('.sky-changes').getByText('example.ts', { exact: true }).first().waitFor();
  await page.getByRole('button',{name:'撤销此变更',exact:true}).click();
  await page.getByRole('button',{name:'确认恢复',exact:true}).click();
  await page.getByRole('button',{name:'重做此变更',exact:true}).waitFor();
  assert.match(fs.readFileSync(file,'utf8'),/count = 7/);
  await page.getByRole('button',{name:'重做此变更',exact:true}).click();
  await page.getByRole('button',{name:'确认恢复',exact:true}).click();
  await page.getByRole('button',{name:'撤销此变更',exact:true}).waitFor();
  assert.match(fs.readFileSync(file,'utf8'),/count = 8/);
  await trigger('/terminal');
  await picker().getByRole('option').click();
  await page.locator('.xterm').waitFor();
  let sessions = 0;
  for (let i = 0; i < 40; i++) {
    sessions = (await call('/terminal/status')).sessions;
    if (sessions) break;
    await sleep(100);
  }
  assert.equal(sessions, 1);
  checks.push('安装版 / 文档变更、实际文件撤销/重做和真实终端会话');
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(qa, 'installed-ui.json'),
    JSON.stringify({ checks, errors, install, data, at: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
})()
  .catch(async (e) => {
    console.error(e.stack);
    console.error(logs.slice(-1500));
    if (page)
      await page
        .screenshot({ path: path.join(qa, 'installed-failure.png'), animations: 'disabled' })
        .catch(() => {});
    fs.writeFileSync(
      path.join(qa, 'installed-failure.json'),
      JSON.stringify({ error: e.message, checks, errors, data }, null, 2),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    for (const id of ownedTerminals)
      await call('/terminal/' + id + '/close', 'POST', {}).catch(() => {});
    if (ownedTerminals.length) await sleep(3500);
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
  });
