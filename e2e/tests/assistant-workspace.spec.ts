import { test, expect } from '@playwright/test';
import { selectCanvasElement } from './canvas-pointer';

test('AI design file appears, edits undo/redo, survives tab changes, saves and exports clean HTML', async ({
  page,
}) => {
  let source =
    '<html><head><style>body{padding:20px;background:#fff8ed}h1{color:#153050}</style></head><body><h1 id="headline">AI 生成的海报</h1><p>可编辑图层</p></body></html>';
  let frameHtml = '';
  let exists = false;
  let saves = 0;
  await page.route(/\/api\/files\/project(?:\?|$)/, (r) =>
    r.fulfill({ json: { path: '/design', source: 'session' } }),
  );
  await page.route('**/api/files/tree**', (r) =>
    r.fulfill({
      json: {
        name: 'design',
        type: 'dir',
        children: exists ? [{ name: 'poster.html', type: 'file' }] : [],
      },
    }),
  );
  await page.route('**/api/files/read**', (r) => r.fulfill({ json: { content: source } }));
  await page.route('**/api/files/design-save', (r) => {
    const body = r.request().postDataJSON();
    expect(body.expectedContent).toBe(source);
    source = body.content;
    saves++;
    return r.fulfill({ json: { path: body.path } });
  });
  await page.route('**/api/files/design-frame**', (r) => {
    if (r.request().method() === 'POST') {
      frameHtml = r.request().postDataJSON().html;
      return r.fulfill({ json: { id: 'canvas-test', renderToken: 'cap' } });
    }
    return r.fulfill({
      body: frameHtml,
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': "sandbox allow-scripts; connect-src 'none'" },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '设计画布', exact: true }).click();
  await page.getByRole('button', { name: 'AI 生成 / 改稿' }).click();
  await expect(page.locator('textarea').first()).toHaveValue(/独立 HTML/);
  exists = true;
  const frame = page.frameLocator('iframe[title="设计画布"]');
  await expect(frame.locator('#headline')).toHaveText('AI 生成的海报');
  await selectCanvasElement(page, '#headline');
  await page.getByLabel('元素文字', { exact: true }).fill('用户修改后的标题');
  await page.getByRole('button', { name: '应用文字', exact: true }).click();
  await expect(frame.locator('#headline')).toHaveText('用户修改后的标题');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(frame.locator('#headline')).toHaveText('AI 生成的海报');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(frame.locator('#headline')).toHaveText('用户修改后的标题');
  await page
    .getByRole('complementary', { name: '图层列表' })
    .getByRole('button', { name: 'h1 用户修改后的标题' })
    .click();
  await page.getByLabel('文字颜色', { exact: true }).fill('#123456');
  await expect(frame.locator('#headline')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await page.getByLabel('字号', { exact: true }).fill('42');
  await page.getByLabel('字号', { exact: true }).press('Enter');
  await expect(frame.locator('#headline')).toHaveCSS('font-size', '42px');
  await expect(frame.locator('#headline')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await page.getByTitle('编辑器', { exact: true }).click();
  await page.getByTitle('画布', { exact: true }).click();
  await expect(frame.locator('#headline')).toHaveText('用户修改后的标题');
  await expect(page.getByLabel('宽度', { exact: true })).not.toHaveValue('0');
  await expect(page.getByLabel('高度', { exact: true })).not.toHaveValue('0');
  await expect(page.getByLabel('文字颜色', { exact: true })).toHaveValue('#123456');
  await expect(frame.locator('#headline')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await page.getByRole('button', { name: '专注画布', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const parts: Buffer[] = [];
  for await (const chunk of stream!) parts.push(Buffer.from(chunk));
  const exported = Buffer.concat(parts).toString();
  expect(exported).toContain('用户修改后的标题');
  expect(exported).not.toContain('data-sky-editor');
  expect(exported).not.toContain('__sky_canvas_layer');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(() => saves).toBe(1);
  expect(source).toContain('用户修改后的标题');
  expect(source).not.toContain('data-sky-editor');
  await page.screenshot({ path: '../.test-runtime-data/canvas-editable.png' });
});

test('inbox filters tasks and requires exact recipient/content preview before sending', async ({
  page,
}) => {
  let sends = 0;
  const item = {
    id: 'feishu:1',
    channelId: '飞书',
    peer: '客户 A',
    thread: '项目群',
    content: '请确认设计稿',
    timestamp: Date.now(),
    direction: 'inbound',
    unread: true,
    task: 'none',
  };
  const drafts: Array<{ id: string; itemId: string; content: string; status: string }> = [];
  await page.route('**/api/inbox**', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (r.request().method() === 'GET') return r.fulfill({ json: { items: [item], drafts } });
    const body = r.request().postDataJSON();
    if (path.includes('/items/')) {
      Object.assign(item, body);
      return r.fulfill({ json: { updated: true } });
    }
    if (path.endsWith('/send')) {
      expect(body.confirmedContent).toBe(drafts[0]!.content);
      drafts[0]!.status = 'sent';
      sends++;
      return r.fulfill({ json: drafts[0] });
    }
    drafts.push({ id: 'draft-1', itemId: item.id, content: body.content, status: 'draft' });
    return r.fulfill({ json: drafts[0] });
  });
  await page.goto('/inbox');
  await page.getByRole('button', { name: /飞书 · 客户 A/ }).click();
  await page.getByRole('button', { name: '设为待办' }).click();
  await expect.poll(() => item.task).toBe('todo');
  await page.getByRole('textbox', { name: '回复草稿' }).fill('设计稿已完成，请查收。');
  await page.getByRole('button', { name: '保存草稿并预览发送' }).click();
  expect(sends).toBe(0);
  const dialog = page.getByRole('dialog', { name: '确认发送回复' });
  await expect(dialog).toContainText('收件人：客户 A');
  await dialog.getByRole('button', { name: '确认，发送给此收件人' }).click();
  await expect.poll(() => sends).toBe(1);
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: '../.test-runtime-data/unified-inbox.png' });
});
