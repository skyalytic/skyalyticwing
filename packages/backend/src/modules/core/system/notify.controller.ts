import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WsEvent } from '@skyalyticwing/shared';
import { WebSocketService } from '../websocket/websocket.service.js';
import { NotifyDto } from '../../channels/wechat/dto/wechat.dto.js';

const execFileAsync = promisify(execFile);

/** 桌面通知超时（5s，对齐旧版） */
const NOTIFY_TIMEOUT_MS = 5000;

/** 通知投递渠道结果 */
interface NotifyChannelResult {
  channel: string;
  sent: boolean;
  error?: string;
}

/** 通知发送结果（结构对齐旧版 NotifySystem.send） */
interface NotifyResult {
  notified: boolean;
  channels: NotifyChannelResult[];
}

/** 清理通知文本（去除引号与换行，防止命令注入，对齐旧版行为） */
function sanitizeNotifyText(text: string): string {
  return String(text || '').replace(/"/g, '').replace(/'/g, '').replace(/\n/g, ' ');
}

/**
 * Notify / WS 状态 REST API（路由前缀 /api）
 *
 * 暴露端点（对齐旧版 start.cjs）：
 *   POST /api/notify     - 系统通知（WebSocket 广播 + 平台桌面通知）
 *   GET  /api/ws/status  - WebSocket 连接状态
 */
@Controller()
export class NotifyController {
  constructor(private readonly ws: WebSocketService) {}

  /** POST /notify — 发送系统通知 */
  @Post('notify')
  @HttpCode(HttpStatus.OK)
  async notify(@Body() dto: NotifyDto): Promise<NotifyResult> {
    const title = dto?.title || 'SkyalyticWing';
    const message = dto?.message || '';
    const level = dto?.level || 'info';
    const results: NotifyChannelResult[] = [];

    // 1. WebSocket 广播（对齐旧版 broadcast）
    try {
      const event: WsEvent = {
        type: 'notification',
        data: {
          title,
          message,
          level,
          ...(dto?.sessionId ? { sessionId: dto.sessionId } : {}),
        },
      };
      this.ws.broadcast(event);
      results.push({ channel: 'websocket', sent: true });
    } catch (e) {
      results.push({
        channel: 'websocket',
        sent: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // 2. 平台桌面通知（数组参数 + timeout，对齐旧版 NotifySystem）
    const platformResult = await this.sendDesktopNotification(title, message);
    results.push(platformResult);

    return {
      notified: results.some((r) => r.sent),
      channels: results,
    };
  }

  /** GET /ws/status — WebSocket 连接状态（对齐旧版） */
  @Get('ws/status')
  wsStatus(): { connected: number; server: boolean } {
    return {
      connected: this.ws.getConnectionCount(),
      server: true,
    };
  }

  /** 发送平台桌面通知（Windows toast / macOS osascript / Linux notify-send） */
  private async sendDesktopNotification(title: string, message: string): Promise<NotifyChannelResult> {
    const safeTitle = sanitizeNotifyText(title);
    const safeMessage = sanitizeNotifyText(message);
    try {
      if (process.platform === 'win32') {
        const psScript =
          `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ` +
          `try { $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); ` +
          `$text = $template.GetElementsByTagName("text").Item(0); ` +
          `$text.AppendChild($template.CreateTextNode("${safeMessage}")) | Out-Null; ` +
          `$toast = [Windows.UI.Notifications.ToastNotification]::new($template); ` +
          `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("SkyalyticWing").Show($toast) } catch {}`;
        await execFileAsync(
          'powershell',
          ['-NoProfile', '-Command', psScript],
          { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true },
        );
        return { channel: 'windows', sent: true };
      }
      if (process.platform === 'darwin') {
        await execFileAsync(
          'osascript',
          ['-e', `display notification "${safeMessage}" with title "${safeTitle}"`],
          { timeout: NOTIFY_TIMEOUT_MS },
        );
        return { channel: 'macos', sent: true };
      }
      await execFileAsync('notify-send', [safeTitle, safeMessage], {
        timeout: NOTIFY_TIMEOUT_MS,
      });
      return { channel: 'linux', sent: true };
    } catch (e) {
      return {
        channel: process.platform,
        sent: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
