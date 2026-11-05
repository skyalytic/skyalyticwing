import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { DesktopService } from './desktop.service.js';
import { BrowserService } from './browser.service.js';
import {
  BrowserNavigateDto,
  ComputerClickDto,
  ComputerTypeDto,
} from '../tools/dto/misc.dto.js';

/**
 * Computer Use / Browser 兼容 REST API
 *
 * 对齐旧版 start.cjs 的 /computer-use/* 与 /browser/* 路由，
 * 实现转发到 automation 域的 DesktopService / BrowserService：
 *
 *   POST /api/computer-use/screenshot - 桌面截图（转发 desktop.screenshot）
 *   POST /api/computer-use/click      - 鼠标点击（转发 desktop.mouseClick）
 *   POST /api/computer-use/type       - 键盘输入（转发 desktop.keyType）
 *   POST /api/browser/navigate        - 打开 URL（转发 browser.openUrl）
 *   POST /api/browser/screenshot      - 网页截图（转发 browser.screenshot）
 */
@Controller()
export class ComputerUseController {
  constructor(
    private readonly desktop: DesktopService,
    private readonly browser: BrowserService,
  ) {}

  /** POST /computer-use/screenshot — 桌面截图 */
  @Post('computer-use/screenshot')
  @HttpCode(HttpStatus.OK)
  async screenshot() {
    return this.desktop.screenshot();
  }

  /** POST /computer-use/click — 鼠标点击（x/y/button） */
  @Post('computer-use/click')
  @HttpCode(HttpStatus.OK)
  click(@Body() dto: ComputerClickDto) {
    void dto;
    return { success: false, error: 'Unobserved input is disabled. Use the computer_use tool: list_windows → look → act with the returned lookId and target.' };
  }

  /** POST /computer-use/type — 键盘输入文本 */
  @Post('computer-use/type')
  @HttpCode(HttpStatus.OK)
  type(@Body() dto: ComputerTypeDto) {
    if (!dto || typeof dto.text !== 'string') {
      return { success: false, error: 'text required' };
    }
    return { success: false, error: 'Unobserved input is disabled. Use computer_use with a fresh lookId and observed target.' };
  }

  /** POST /browser/navigate — 打开 URL */
  @Post('browser/navigate')
  @HttpCode(HttpStatus.OK)
  async navigate(@Body() dto: BrowserNavigateDto) {
    if (!dto?.url) {
      return { success: false, error: 'url required' };
    }
    try {
      await this.browser.openUrl(dto.url);
      return { success: true, url: dto.url };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** POST /browser/screenshot — 网页截图 */
  @Post('browser/screenshot')
  @HttpCode(HttpStatus.OK)
  async browserScreenshot(@Body() dto: BrowserNavigateDto) {
    if (!dto?.url) {
      return { success: false, error: 'url required' };
    }
    return this.browser.screenshot(dto.url);
  }
}
