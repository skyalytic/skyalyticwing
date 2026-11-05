import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { ApiResponse } from '@skyalyticwing/shared';
import { DesktopService, type WindowInfo } from './desktop.service.js';
import { BrowserService } from './browser.service.js';
import { MediaService } from './media.service.js';
import { type ImageGenerateRequest, type ImageGenerateResult } from './image-provider.service.js';
import { type VideoGenerateRequest } from './video-provider.service.js';
import { VideoTaskService } from './video-task.service.js';

/**
 * 自动化 REST API
 *
 * 全局前缀已由 main.ts 设置为 /api，因此 @Controller('automation') 实际路由为 /api/automation。
 *
 * 暴露端点（桌面/浏览器/媒体生成）：
 *   POST /api/automation/desktop/screenshot    - 截图（危险）
 *   GET  /api/automation/desktop/windows        - 列出窗口
 *   POST /api/automation/desktop/focus          - 聚焦窗口
 *   POST /api/automation/desktop/close          - 关闭窗口
 *   POST /api/automation/browser/open           - 打开 URL（危险）
 *   POST /api/automation/browser/screenshot     - 网页截图
 *   POST /api/automation/media/generate-image   - 图片生成
 *   POST /api/automation/media/generate-video   - 视频生成
 *
 * （旧媒体套件的 voice/tts、voice/stt、media/generate-music、media/analyze-image
 *  端点已随语音/音乐/媒体理解链路清理移除——现仅保留统一模型体系的图片/视频 API 生成。）
 */
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly desktop: DesktopService,
    private readonly browser: BrowserService,
    private readonly media: MediaService,
    private readonly videoTasks: VideoTaskService,
  ) {}

  @Post('desktop/screenshot')
  @HttpCode(HttpStatus.OK)
  async screenshot(): Promise<
    ApiResponse<{ success: boolean; path?: string; error?: string }>
  > {
    try {
      const result = await this.desktop.screenshot();
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Get('desktop/windows')
  listWindows(): ApiResponse<WindowInfo[]> {
    return { success: true, data: this.desktop.listWindows() };
  }

  @Post('desktop/focus')
  @HttpCode(HttpStatus.OK)
  async focusWindow(@Body('title') title: string): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      void title;
      return { success: false, error: 'Use computer_use focus_window with a fresh lookId. Title-based input is disabled.' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('desktop/close')
  @HttpCode(HttpStatus.OK)
  async closeWindow(@Body('title') title: string): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      void title;
      return { success: false, error: 'Use computer_use to observe the window and its close control before acting.' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('browser/open')
  @HttpCode(HttpStatus.OK)
  async openUrl(@Body('url') url: string): Promise<ApiResponse<{ ok: boolean }>> {
    try {
      await this.browser.openUrl(url);
      return { success: true, data: { ok: true } };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('browser/screenshot')
  @HttpCode(HttpStatus.OK)
  async browserScreenshot(
    @Body('url') url: string,
  ): Promise<ApiResponse<{ success: boolean; path?: string }>> {
    try {
      const result = await this.browser.screenshot(url);
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('media/generate-image')
  @HttpCode(HttpStatus.OK)
  async generateImage(
    @Body() body: { prompt: string; options?: Omit<ImageGenerateRequest, 'prompt'> },
  ): Promise<ApiResponse<ImageGenerateResult>> {
    try {
      const result = await this.media.generateImage({
        prompt: body.prompt,
        ...body.options,
      });
      return { success: true, data: result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @Post('media/generate-video')
  @HttpCode(HttpStatus.ACCEPTED)
  async generateVideo(
    @Body() body: { prompt: string; options?: Omit<VideoGenerateRequest, 'prompt'> },
    @Headers('idempotency-key') key: string,
  ) {
    return { success: true, data: this.videoTasks.create({ ...body.options, prompt: body.prompt }, key) };
  }
}
