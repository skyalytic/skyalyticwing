import { test, expect } from '@playwright/test';

test('a fresh browser connects with the service token without changing server configuration', async ({ page }) => {
  const credential = 'test-only-service-token-not-a-provider-key';
  let mutations = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.url().includes('/api/auth/capabilities')) { await route.continue(); return; }
    if (request.url().includes('/config') && request.method() !== 'GET') mutations++;
    if (request.headers()['authorization'] !== 'Bearer ' + credential) {
      await route.fulfill({ status: 401, json: { success: false, error: 'Unauthorized' } }); return;
    }
    await route.continue();
  });
  await page.goto('/tools');
  const field = page.getByRole('textbox', { name: '服务访问令牌' });
  await field.fill('incorrect'); await page.getByRole('button', { name: '连接服务', exact: true }).click();
  await expect(page.getByRole('alert').filter({hasText: '访问令牌不正确'})).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('skyalyticwing.auth.token'))).toBeNull();
  await field.fill(credential); await page.getByRole('button', { name: '连接服务', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加工具' })).toBeVisible();
  expect(mutations).toBe(0);
});
