import { createReadStream } from 'node:fs';
import type { Response } from 'express';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { BuiltInBrowserService } from './browser.service.js';

/** 导航/刷新等需要 url 的请求体 */
interface NavigateDto {
  sessionId?: string;
  url: string;
  pageId?: string;
}

/** 快照/关闭等仅带页面 id 的请求体 */
interface PageDto {
  sessionId?: string;
  pageId?: string;
}

/** 坐标点选元素请求体 */
interface ElementAtDto {
  sessionId?: string;
  pageId: string;
  x: number;
  y: number;
}

/** 按索引取元素请求体 */
interface ElementByIndexDto {
  sessionId?: string;
  pageId: string;
  index: number;
}

/** 统一操作请求体（click/fill/select/key/scroll/hover） */
interface ActionDto {
  sessionId?: string;
  pageId: string;
  action: string;
  index?: number;
  text?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
}

/** 导航历史请求体 */
interface HistoryDto {
  sessionId?: string;
  pageId: string;
  dir: 'back' | 'forward';
}

/**
 * 内置浏览器 REST API（前端"浏览器"面板）
 *
 *   GET  /api/builtin-browser/status          - 运行状态
 *   POST /api/builtin-browser/navigate        - 导航（首次自动拉起浏览器）→ 快照
 *   POST /api/builtin-browser/snapshot        - 当前快照（截图+元素清单+console）
 *   POST /api/builtin-browser/element         - 坐标点选元素详情（截图上点选取元素）
 *   POST /api/builtin-browser/element-index   - 按索引取元素详情
 *   POST /api/builtin-browser/action          - 统一操作（操作后返回最新快照）
 *   POST /api/builtin-browser/history         - 后退/前进
 *   POST /api/builtin-browser/reload          - 刷新
 *   POST /api/builtin-browser/close           - 关闭页面（all=true 关闭整个浏览器）
 */
@Controller('builtin-browser')
export class BrowserController {
  constructor(private readonly browser: BuiltInBrowserService) {}

  @Post('native/connect') nativeConnect(@Body() dto: { owner: string }) {
    return this.browser.native.connect(dto.owner);
  }
  @Post('native/poll') nativePoll(
    @Body() dto: { owner: string; states?: Record<string, unknown> },
  ) {
    return this.browser.native.poll(dto.owner, dto.states);
  }
  @Post('native/result') nativeResult(
    @Body() dto: { owner: string; id: string; result?: unknown; error?: string },
  ) {
    return this.browser.native.finish(dto.owner, dto.id, dto.result, dto.error);
  }
  @Post('native/claim') nativeClaim(@Body() dto: { owner: string; id: string }) {
    return this.browser.native.claim(dto.owner, dto.id);
  }

  @Get('status')
  status(@Query('sessionId') sessionId?: string) {
    return this.browser.forSession(sessionId).status();
  }

  @Post('control') control(@Body() dto: PageDto & { manual: boolean }) {
    return this.browser.forSession(dto?.sessionId).setControl(dto.manual);
  }
  @Post('tabs') newTab(@Body() dto: NavigateDto) {
    const b = this.browser.forSession(dto?.sessionId);
    return b.runOperation('user', () => b.newTab(dto.url));
  }
  @Post('activate') activate(@Body() dto: PageDto) {
    const b = this.browser.forSession(dto?.sessionId);
    return b.runOperation('user', () => b.activate(dto.pageId!));
  }
  @Post('upload') upload(
    @Body() dto: PageDto & { index: number; name: string; mimeType: string; base64: string },
  ) {
    const b = this.browser.forSession(dto?.sessionId);
    return b.runOperation('user', () =>
      b.upload(dto.pageId!, dto.index, dto.name, dto.mimeType, dto.base64),
    );
  }
  @Get('downloads/:id') async download(
    @Param('id') id: string,
    @Query('sessionId') sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.browser.forSession(sessionId).download(id);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    return new StreamableFile(createReadStream(file.path));
  }
  @Post('save-download') saveDownload(@Body() dto: PageDto & { downloadId: string; path: string }) {
    const b = this.browser.forSession(dto?.sessionId);
    return b.runOperation('user', () => b.saveDownload(dto.downloadId, dto.path));
  }

  @Post('navigate')
  @HttpCode(HttpStatus.OK)
  navigate(@Body() dto: NavigateDto) {
    const browser = this.browser.forSession(dto?.sessionId);
    return browser.runOperation('user', () => browser.navigate(dto.url, dto.pageId));
  }

  @Post('snapshot')
  @HttpCode(HttpStatus.OK)
  snapshot(@Body() dto: PageDto) {
    return this.browser.forSession(dto?.sessionId).snapshot(dto?.pageId);
  }

  @Post('element')
  @HttpCode(HttpStatus.OK)
  elementAt(@Body() dto: ElementAtDto) {
    return this.browser.forSession(dto?.sessionId).elementAt(dto.pageId, dto.x, dto.y);
  }

  @Post('element-index')
  @HttpCode(HttpStatus.OK)
  elementByIndex(@Body() dto: ElementByIndexDto) {
    return this.browser.forSession(dto?.sessionId).elementByIndex(dto.pageId, dto.index);
  }

  @Post('action')
  @HttpCode(HttpStatus.OK)
  action(@Body() dto: ActionDto) {
    const { pageId, action, ...args } = dto;
    const browser = this.browser.forSession(dto?.sessionId);
    return browser.runOperation('user', () => browser.action(pageId, action, args));
  }

  @Post('history')
  @HttpCode(HttpStatus.OK)
  history(@Body() dto: HistoryDto) {
    const browser = this.browser.forSession(dto?.sessionId);
    return browser.runOperation('user', () => browser.history(dto.pageId, dto.dir));
  }

  @Post('reload')
  @HttpCode(HttpStatus.OK)
  reload(@Body() dto: PageDto) {
    const browser = this.browser.forSession(dto?.sessionId);
    return browser.runOperation('user', () => browser.reload(dto?.pageId));
  }

  @Post('close')
  @HttpCode(HttpStatus.OK)
  close(@Body() dto: PageDto & { all?: boolean }) {
    const browser = this.browser.forSession(dto?.sessionId);
    return browser.runOperation('user', () =>
      dto?.all === true ? browser.closeAll() : browser.closePage(dto?.pageId),
    );
  }
}
