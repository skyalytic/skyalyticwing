import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { chromium, type Browser } from 'playwright-core';

let rendering = false;
/** Offline export: do not execute document scripts or request internal/external resources. */
export async function renderDesignPng(
  html: string,
  width: number,
  height: number,
): Promise<Buffer> {
  return renderDesignFile(html, width, height, 'png');
}

export async function renderDesignFile(
  html: string, width: number, height: number, format: 'png' | 'pdf',
): Promise<Buffer> {
  if (
    typeof html !== 'string' ||
    Buffer.byteLength(html) > 1536 * 1024 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 100 ||
    height < 100 ||
    width > 2560 ||
    height > 2560
  ) {
    throw new BadRequestException('设计稿或导出尺寸无效');
  }
  if (rendering) throw new ServiceUnavailableException('正在导出，请稍后重试');
  rendering = true;
  let browser: Browser | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const channel of ['msedge', 'chrome']) {
      try {
        browser = await chromium.launch({ channel, headless: true });
        break;
      } catch {
        /* try installed alternative */
      }
    }
    if (!browser) throw new ServiceUnavailableException('画布导出需要服务器安装 Edge 或 Chrome');
    deadline = setTimeout(() => { void browser?.close().catch(() => undefined); }, 20000);
    const context = await browser.newContext({
      viewport: { width, height },
      javaScriptEnabled: false,
    });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
    return format === 'pdf'
      ? await page.pdf({ width: `${width}px`, height: `${height}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } })
      : await page.screenshot({ type: 'png', timeout: 10000 });
  } finally {
    clearTimeout(deadline);
    try {
      await browser?.close();
    } finally {
      rendering = false;
    }
  }
}
