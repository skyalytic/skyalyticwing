import { expect, type Page } from '@playwright/test';

export async function selectCanvasElement(page: Page, selector: string) {
  const iframe = page.locator('iframe[title="设计画布"]');
  const element = iframe.contentFrame().locator(selector);
  await expect(element).toBeVisible();
  // Convert the inner frame coordinates through its displayed CSS scale.
  // Keep this a browser mouse click so selection and hit testing remain exercised.
  const inner = await element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  const outer = await iframe.boundingBox();
  expect(outer).not.toBeNull();
  await page.keyboard.down('Control');
  try {
    await page.mouse.click(
      outer!.x + (inner.x * outer!.width) / inner.width,
      outer!.y + (inner.y * outer!.height) / inner.height,
    );
  } finally {
    await page.keyboard.up('Control');
  }
}
