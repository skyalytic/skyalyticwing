import { Module } from '@nestjs/common';
import { LlmModule } from '../ai/llm/llm.module.js';
import { DesktopService } from './desktop.service.js';
import { UiaService } from './uia.service.js';
import { DesktopControlService } from './desktop-control.service.js';
import { VisualDesktopDriver } from './visual-desktop-driver.js';
import { DesktopControlController } from './desktop-control.controller.js';
import { BrowserService } from './browser.service.js';
import { ImageProviderService } from './image-provider.service.js';
import { VideoProviderService } from './video-provider.service.js';
import { MediaService } from './media.service.js';
import { OcrService } from './ocr.service.js';
import { AppLaunchService } from './app-launch.service.js';
import { AutomationController } from './automation.controller.js';
import { ComputerUseController } from './computer-use.controller.js';
import { VideoTaskService } from './video-task.service.js';
import { VideoTaskController } from './video-task.controller.js';

/**
 * AutomationModule - 自动化域模块
 *
 * 包含 Desktop / UIA / Browser / ImageProvider / VideoProvider / Media / OCR / AppLaunch 子服务。
 * 依赖 LoggerService / HttpClientService / ConfigService / SecurityManagerService（由各自全局模块提供）。
 * （旧媒体套件的 VoiceService（TTS/STT）已清理移除；本地 OCR 属文字识别能力
 *  与媒体无关故保留，现仅承载统一模型体系的图片/视频 API 生成。）
 *
 * Controllers:
 *   - AutomationController: /api/automation/*（桌面/浏览器/媒体生成）
 *   - ComputerUseController: /api/computer-use/*、/api/browser/*（旧版兼容路由）
 */
@Module({
  imports: [LlmModule],
  providers: [
    DesktopService,
    UiaService,
    DesktopControlService,
    VisualDesktopDriver,
    BrowserService,
    ImageProviderService,
    VideoProviderService,
    MediaService,
    OcrService,
    AppLaunchService,
    VideoTaskService,
  ],
  controllers: [AutomationController, ComputerUseController, VideoTaskController, DesktopControlController],
  exports: [
    DesktopService,
    UiaService,
    DesktopControlService,
    BrowserService,
    ImageProviderService,
    VideoProviderService,
    MediaService,
    OcrService,
    AppLaunchService,
    VideoTaskService,
  ],
})
export class AutomationModule {}
