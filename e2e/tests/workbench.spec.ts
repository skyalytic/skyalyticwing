import { test, expect } from '@playwright/test';

test('task starters create editable drafts without starting model requests', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat/send') sent.push(request.postData() || '');
  });
  await page.goto('/');
  const input = page.locator('textarea').first();
  for (const title of ['日常办公', '全通道协同', '网页代办', '设计创作']) {
    await input.fill('');
    await page.getByRole('button', { name: new RegExp(title) }).click();
    await expect(input).not.toHaveValue('');
    await expect(input).toBeFocused();
    expect(sent).toHaveLength(0);
  }
  await input.fill('验证新工作台的编辑和发送');
  await input.press('Enter');
  await expect(page.getByText('E2E-MOCK 后端的自动回复内容')).toBeVisible();
  expect(sent).toHaveLength(1);
});

test('sidebar order, keyboard navigation and secondary actions remain available', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '工作台' });
  const history = page.getByRole('textbox',{name:'搜索会话',exact:true});
  await expect(history).toBeVisible();
  await expect(nav.getByRole('button',{name:'对话',exact:true})).toBeVisible();
  await expect(nav.getByRole('button', { name: '会话管理' })).toHaveCount(0);
  await page.getByRole('button', { name: '收起聊天栏' }).click();
  await expect(history).toHaveCount(0);
  await page.getByRole('button', { name: '展开聊天栏' }).click();
  await expect(history).toBeVisible();
  const more = page.locator('.sky-composer-more summary');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '压缩对话上下文' })).toBeVisible();
  await expect(page.getByRole('button', { name: '清空对话' })).toBeVisible();
  await page.getByRole('button', { name: '模型配置', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?tab=models$/);
});

test('workbench remains usable on a laptop and supports reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今天，一起完成什么？' })).toBeVisible();
  await expect(page.locator('textarea')).toBeInViewport();
  const composer = (await page.locator('.sky-composer').boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(720);
  expect(await page.locator('.sky-task-home').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: '../.test-runtime-data/workbench-dark.png' });
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); });
  await page.screenshot({ path: '../.test-runtime-data/workbench-light.png' });
});
