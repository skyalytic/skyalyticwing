import { test, expect } from '@playwright/test';
for (const transport of ['ssh', 'wsl', 'docker']) {
  test(
    transport + ' workspace picker, editing and review use remote endpoints',
    async ({ page }, info) => {
      await page.addInitScript(() => localStorage.setItem('app.language', 'zh-CN'));
      const workspace = {
        id: 'remote-fixture',
        name: '远程测试',
        transport,
        target: 'fixture.invalid',
        root: '/workspace',
      };
      let saved = false,
        bound: string | null = null,
        content = '原始内容',
        revision = 'r1';
      const writes: any[] = [];
      let officeSaved = 0;
      await page.route('**/api/office-native/**', async (route) => {
        const url = new URL(route.request().url()),
          body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
        let data: any;
        if (url.pathname.endsWith('/status')) data = { available: true };
        else if (url.pathname.endsWith('/open')) {
          expect(body).toEqual({ path: '/workspace/报告.docx', remoteWorkspaceId: workspace.id });
          data = {
            id: 'canvas-fixture',
            url: 'http://127.0.0.1:19499/edit/canvas-fixture#capability',
            name: '报告.docx',
          };
        } else if (url.pathname.endsWith('/command')) {
          expect(body.action).toBe('save');
          if (!officeSaved) writes.push({ op: 'canvas-save' });
          officeSaved = Date.now();
          data = { queued: true };
        } else data = { ready: true, dirty: false, savedAt: officeSaved, error: '' };
        await route.fulfill({ json: { success: true, data } });
      });
      await page.route('**/api/files/project?*', (route) =>
        route.fulfill({ json: { success: true, data: { path: '', source: '' } } }),
      );
      await page.route('**/api/remote-workspaces**', async (route) => {
        const req = route.request(),
          url = new URL(req.url()),
          body = req.method() === 'POST' ? req.postDataJSON() : null;
        let data: any;
        if (url.pathname.endsWith('/operation')) {
          const { op, args } = body;
          if (op === 'list')
            data = {
              entries: [
                { name: '文宇.txt', path: '/workspace/文宇.txt' },
                { name: '报告.docx', path: '/workspace/报告.docx' },
              ],
            };
          else if (op === 'office-read')
            data = {
              format: 'docx',
              revision: 'doc-r1',
              sections: [{ name: '正文', fields: [{ id: 'p:0', value: '远程文档原文' }] }],
            };
          else if (op === 'office-edit') {
            expect(args.path).toBe('/workspace/报告.docx');
            expect(args.revision).toBe('doc-r1');
            expect(args.changes).toEqual([{ id: 'p:0', value: '远程文档修改' }]);
            writes.push(body);
            data = { revision: 'doc-r2' };
          } else if (op === 'read') data = { content, revision };
          else if (op === 'write') {
            expect(args.revision).toBe(revision);
            content = args.content;
            revision = 'r2';
            writes.push(body);
            data = { revision };
          } else if (op === 'git-status') data = { entries: [{ status: ' M', path: '文宇.txt' }] };
          else if (op === 'git-diff')
            data = { stdout: '-原始内容\n+修改后的内容', revision, head: 'fixture-head' };
          else if (op === 'git-stage') {
            expect(args.revision).toBe('r2');
            writes.push(body);
            data = { staged: true };
          } else throw Error('Unexpected operation ' + op);
        } else if (url.pathname.endsWith('/bind')) {
          bound = body.id;
          data = { bound };
        } else if (req.method() === 'POST') {
          expect(body.transport).toBe(transport);
          expect(body.port).toBe(transport === 'ssh' ? 22 : undefined);
          saved = true;
          data = workspace;
        } else data = { workspaces: saved ? [workspace] : [], bound };
        await route.fulfill({ json: { success: true, data } });
      });
      await page.goto('/');
      await page.getByTitle(/展开工程面板/).click();
      await page.getByRole('button', { name: 'SSH / WSL / Docker', exact: true }).click();
      await page.getByLabel('工作区名称').fill('远程测试');
      await page.getByLabel('连接方式').selectOption(transport);
      await page.getByLabel('远程目标').fill('fixture.invalid');
      await page.getByLabel('远程项目路径').fill('/workspace');
      await page.getByRole('button', { name: '连接', exact: true }).click();
      const panel = page.getByRole('region', { name: '远程项目' });
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: '文宇.txt', exact: true }).click();
      await expect(panel.getByLabel('远程文件内容')).toHaveValue('原始内容');
      await panel.getByLabel('远程文件内容').fill('修改后的内容');
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0].args.path).toBe('/workspace/文宇.txt');
      await page.screenshot({ path: info.outputPath('remote-editor.png'), fullPage: true });
      await panel.getByRole('button', { name: '报告.docx', exact: true }).click();
      await expect(panel.getByTestId('office-editor')).toBeVisible();
      await expect(panel.getByRole('link', { name: '打开 Office 编辑窗口' })).toHaveAttribute(
        'href',
        'http://127.0.0.1:19499/edit/canvas-fixture#capability',
      );
      await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('已保存到原文件');
      await expect.poll(() => writes.length).toBe(2);
      await page.screenshot({ path: info.outputPath('remote-office.png'), fullPage: true });
      await page.getByRole('button', { name: '打开工作区工具', exact: true }).click();
      await page.locator('.sky-workspace-menu').getByRole('button', { name: /变更/ }).click();
      const review = page.getByRole('region', { name: '远程项目' }).filter({ visible: true });
      await review.getByRole('button', { name: /文宇.txt/ }).click();
      await expect(review.locator('pre')).toContainText('+修改后的内容');
      await review.getByRole('button', { name: '暂存', exact: true }).click();
      await expect.poll(() => writes.length).toBe(3);
    },
  );
}
