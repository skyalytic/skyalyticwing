import { test, expect } from '@playwright/test';

test('native browser toolbar syncs host state and routes navigation through the desktop bridge contract', async ({page})=>{
  await page.addInitScript(()=>{
    const state={activePageId:'page-test',tabs:[{id:'page-test',url:'https://example.test/',title:'浏览器测试页',zoom:1,loading:false}],downloads:[]};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{invoke:async(name:string,args:{command?:{op:string}})=>{
      if(name==='native_browser_command' && args.command?.op==='state')return state;
      if(name==='get_app_version')return '2.0.1';
      return null;
    }}});
  });
  const navigations:string[]=[];
  await page.route('**/api/builtin-browser/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/navigate'))navigations.push(route.request().postDataJSON().url);
    return route.fulfill({json:path.endsWith('/native/poll')?{commands:[]}:path.endsWith('/navigate')?{pageId:'page-test',url:'https://example.test/new',title:'new'}:{running:true,activePageId:'page-test',manual:false,agentBusy:false}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'内置浏览器',exact:true}).click();
  const address=page.getByRole('textbox',{name:'搜索或输入网址'});
  await expect(address).toHaveValue('https://example.test/');
  await address.fill('https://example.test/new');await address.press('Enter');
  await expect.poll(()=>navigations).toEqual(['https://example.test/new']);
  await expect(page.getByAltText('浏览器测试页')).toHaveCount(0);
});

test('canvas loads a design, selects a real element, rejects foreign messages and adds full path to draft', async ({ page }) => {
  let html = '';
  await page.route(/\/api\/files\/project(?:\?|$)/, route => route.fulfill({ json: { path: '/work/design', source: 'session' } }));
  await page.route('**/api/files/tree**', route => route.fulfill({ json: { name: 'design', type: 'dir', children: [{ name: 'poster.html', type: 'file' }] } }));
  await page.route('**/api/files/read**', route => route.fulfill({ json: { content: '<html><head></head><body><h1 id="headline">设计稿标题</h1></body></html>' } }));
  await page.route('**/api/files/design-frame**', route => {
    if (route.request().method() === 'POST') {
      html = route.request().postDataJSON().html;
      return route.fulfill({ json: { id: 'test-frame', renderToken: 'test-render-capability' } });
    }
    expect(new URL(route.request().url()).searchParams.get('renderToken')).toBe('test-render-capability');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': "sandbox allow-scripts; connect-src 'none'" }, body: html });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设计画布', exact: true }).click();
  await page.getByTitle('选择设计稿（工程目录下的 HTML）').selectOption('/work/design/poster.html');
  const frame = page.frameLocator('iframe[title="设计画布"]');
  await expect(frame.getByText('设计稿标题')).toBeVisible();
  await page.getByTitle('重置视图').click();
  await page.evaluate(() => window.postMessage({ type: 'sky-canvas-select', payload: { tag: 'forged', rect: {} } }, '*'));
  await expect(page.getByRole('button', { name: '添加到对话' })).toHaveCount(0);
  await frame.getByText('设计稿标题').click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: '添加到对话' }).click();
  await expect(page.locator('textarea').first()).toHaveValue('');
  await page.getByRole('button',{name:'查看引用：画布元素 · 设计稿标题'}).click();
  await expect(page.getByRole('dialog')).toContainText('/work/design/poster.html');
  await expect(page.getByRole('dialog')).toContainText('#headline');
  await page.screenshot({ path: '../.test-runtime-data/design-canvas.png' });
});
