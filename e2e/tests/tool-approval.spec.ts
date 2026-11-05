// 浏览器级 E2E：工具审批流程
// 场景：WS 推送 approval_request → ApprovalInlineCard 审批卡出现 → 点击"批准一次"
//       → POST /api/approvals/{id} 提交决策 → mock 后端推回工具执行结果消息
import { test, expect } from '@playwright/test';

test.describe('tool-approval', () => {
  test('工具页面也能审批，无需切回聊天', async ({ page, request }) => {
    await page.goto('/tools');
    await expect(page.getByText('已连接', { exact: true })).toBeVisible();
    await request.post('/api/__e2e/push', { data: {
      type: 'approval_request', data: { id: 'appr-tools-page', toolName: 'bash', sessionId: 'api',
        reason: 'Manual tool approval', timestamp: Date.now(), args: { command: 'echo fixture' } },
    } });
    const card = page.getByRole('region', { name: '工具审批请求' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(card).toBeHidden();
    const requests = (await (await request.get('/api/__e2e/requests')).json()).data;
    expect(requests.some((entry: { path: string; body?: { decision?: string } }) =>
      entry.path === '/api/approvals/appr-tools-page' && entry.body?.decision === 'denied')).toBe(true);
  });
  test.beforeEach(async ({ request }) => {
    await request.delete('/api/__e2e/requests');
  });

  test('审批卡出现 → 批准一次 → 决策提交且结果回传', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '已连接', exact: true })).toBeVisible();
    // 等待前端 WS 就绪（心跳/连接建立）
    await expect(page.locator('textarea').first()).toBeVisible();
    // Chat results belong to an existing conversation, not a global approval surface.
    await page.locator('textarea').first().fill('准备审批测试会话');
    await page.locator('textarea').first().press('Enter');
    await expect(page.getByText('E2E-MOCK 后端的自动回复内容')).toBeVisible();

    // 触发需审批工具：经控制端点广播 approval_request
    const push = await request.post('/api/__e2e/push', {
      data: {
        type: 'approval_request',
        data: {
          id: 'appr-e2e-1',
          sessionId: 'sess-e2e-1',
          toolName: 'bash',
          reason: 'E2E 危险命令需审批',
          timestamp: Date.now(),
          args: { command: 'echo e2e-approval', cmdName: 'echo' },
        },
      },
    });
    expect(push.ok()).toBeTruthy();

    // ApprovalInlineCard 出现（Modal role=dialog，标题"命令审批请求"）
    const dialog = page.getByRole('region', { name: '工具审批请求' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // 工具名与执行命令展示
    await expect(dialog.getByText('bash', { exact: true })).toBeVisible();
    await expect(dialog.getByText('echo e2e-approval', { exact: true })).toBeVisible();

    // 点击"批准一次"
    await dialog.getByRole('button', { name: '批准一次' }).click();

    // 审批卡关闭（本地立即移除）
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // mock 后端记录到审批决策
    const reqs = (await (await request.get('/api/__e2e/requests')).json()).data as Array<{
      method: string;
      path: string;
      body: Record<string, unknown>;
    }>;
    const approval = reqs.find((r) => r.method === 'POST' && /^\/api\/approvals\/appr-e2e-1$/.test(r.path));
    expect(approval).toBeTruthy();
    expect(approval.body['decision']).toBe('allow-once');

    // 批准后 mock 后端经 WS 推回工具执行结果
    await expect(page.getByText('工具 bash 已执行完成')).toBeVisible({ timeout: 15_000 });
  });

  test('拒绝路径：审批卡出现 → 拒绝 → 决策为 denied', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '已连接', exact: true })).toBeVisible();
    await expect(page.locator('textarea').first()).toBeVisible();
    await page.locator('textarea').first().fill('准备拒绝测试会话');
    await page.locator('textarea').first().press('Enter');
    await expect(page.getByText('E2E-MOCK 后端的自动回复内容')).toBeVisible();

    const push = await request.post('/api/__e2e/push', {
      data: {
        type: 'approval_request',
        data: {
          id: 'appr-e2e-2',
          sessionId: 'sess-e2e-1',
          toolName: 'bash',
          reason: 'E2E 拒绝路径',
          timestamp: Date.now(),
          args: { command: 'rm -rf /tmp/e2e-nothing' },
        },
      },
    });
    expect(push.ok()).toBeTruthy();

    const dialog = page.getByRole('region', { name: '工具审批请求' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    await dialog.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    const reqs = (await (await request.get('/api/__e2e/requests')).json()).data as Array<{
      method: string;
      path: string;
      body: Record<string, unknown>;
    }>;
    const approval = reqs.find((r) => r.method === 'POST' && /^\/api\/approvals\/appr-e2e-2$/.test(r.path));
    expect(approval?.body['decision']).toBe('denied');

    await expect(page.getByText('工具 bash 未执行')).toBeVisible({ timeout: 15_000 });
  });
});
