// 浏览器级 E2E：聊天完整流程
// 场景：打开前端 → 输入并发送消息 → mock 后端经 WS 推回 assistant 消息 → 验证回复上屏
import { test, expect } from '@playwright/test';

test.describe('chat-flow', () => {
  test.beforeEach(async ({ request }) => {
    // 清空上一用例捕获的 REST 请求
    await request.delete('/api/__e2e/requests');
  });

  test('发送消息后收到助手回复（经 WS chat_message 推送）', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '已连接', exact: true })).toBeVisible();

    // 聊天输入框可见
    const input = page.locator('textarea').first();
    await expect(input).toBeVisible();

    // 发送用户消息（Enter 发送）
    await input.fill('你好，这是 chat-flow E2E 用户消息');
    await input.press('Enter');

    // 用户消息上屏
    await expect(page.getByText('这是 chat-flow E2E 用户消息')).toBeVisible();

    // mock 后端在 POST /chat/send 时经 WS 广播 assistant chat_message
    await expect(page.getByText('E2E-MOCK 后端的自动回复内容')).toBeVisible({ timeout: 15_000 });
    // Wait for history reconciliation, then ensure both delivery channels produced one card.
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect(page.locator('.wing-user-text')).toHaveCount(1);
    await expect(page.getByText('E2E-MOCK 后端的自动回复内容')).toHaveCount(1);
  });

  test('消息发送走 POST /chat/send 且携带会话', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '已连接', exact: true })).toBeVisible();

    const input = page.locator('textarea').first();
    await expect(input).toBeVisible();
    await input.fill('验证请求链路');
    await input.press('Enter');

    await expect(page.getByText('E2E-MOCK 后端的自动回复内容')).toBeVisible({ timeout: 15_000 });

    const reqs = (await (await request.get('/api/__e2e/requests')).json()).data as Array<{
      method: string;
      path: string;
      body: Record<string, unknown>;
    }>;
    const chatSend = reqs.find((r) => r.method === 'POST' && r.path === '/api/chat/send');
    expect(chatSend).toBeTruthy();
    expect(chatSend.body['message']).toBe('验证请求链路');
    expect(typeof chatSend.body['session']).toBe('string');
  });
});
