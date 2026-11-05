import { test, expect } from '@playwright/test';

test('generation history pauses and resumes the original task across reload without resubmitting', async ({
  page,
}) => {
  const job = {
    id: 'video-fixture',
    request: { prompt: 'blue cube' },
    status: 'running',
    providerTaskId: 'provider-fixture',
    artifactReady: false,
  };
  let created = true;
  const keys: string[] = [];
  await page.route('**/api/automation/media/video-tasks**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (pathname.endsWith('/artifact')) {
      await route.fulfill({
        contentType: 'video/mp4',
        body: Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]),
      });
      return;
    }
    if (req.method() === 'POST' && pathname.endsWith('video-tasks')) {
      keys.push(req.headers()['idempotency-key']);
      created = true;
    }
    if (pathname.endsWith('/pause')) job.status = 'paused';
    if (pathname.endsWith('/resume')) {
      job.status = 'succeeded';
      job.artifactReady = true;
    }
    await route.fulfill({
      json: { success: true, data: req.method() === 'GET' ? (created ? [job] : []) : job },
    });
  });
  await page.goto('/');
  await page.getByRole('button',{name:'生成记录',exact:true}).click();
  const panel = page.getByRole('region', { name: '视频生成任务' });
  await expect(panel.getByText('生成中', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(0);
  await panel.getByRole('button', { name: '暂停查询', exact: true }).click();
  await expect(panel.getByText('已暂停查询', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'生成记录',exact:true}).click();
  await expect(panel.getByText('已暂停查询', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '继续查询', exact: true }).click();
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: '下载视频', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('video-fixture.mp4');
  expect(keys).toHaveLength(0);
});
