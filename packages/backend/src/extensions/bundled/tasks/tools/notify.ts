import type { ToolDefinition, ToolResult, ToolContext, WsEvent } from '@skyalyticwing/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketService } from '../../../../modules/core/websocket/websocket.service.js';

const execFileAsync = promisify(execFile);

/** 系统消息框超时（毫秒） */
const SYS_MSGBOX_TIMEOUT_MS = 15_000;

interface NotifyArgs {
  title: string;
  message: string;
  level?: 'info' | 'warn' | 'error';
  system?: boolean;
}

/** PowerShell 单引号字面量转义（'' 表示一个单引号） */
function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 经 PowerShell -EncodedCommand 执行脚本（base64 UTF-16LE 编码，
 * 免引号/编码转义问题，execFile 数组参数不经 shell）。
 */
function execPowerShell(script: string, timeoutMs: number): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeout: timeoutMs,
    windowsHide: true,
  }).then(() => undefined);
}

/**
 * 仅在调用方明确请求 system 时显示系统消息框：
 * - Windows: PowerShell MessageBox（[System.Windows.Forms.MessageBox]::Show）
 * - macOS: osascript display dialog
 * - Linux: notify-send
 * 返回系统通道是否完成，失败不影响应用内通知。
 */
async function showSystemMessageBox(title: string, message: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        "[System.Windows.Forms.MessageBox]::Show('" + escapePsSingleQuote(message) + "', '" + escapePsSingleQuote(title) + "') | Out-Null",
      ].join('\r\n');
      await execPowerShell(ps, SYS_MSGBOX_TIMEOUT_MS);
    } else if (process.platform === 'darwin') {
      // osascript -e 数组参数传递（不经 shell），双引号/反斜杠转义
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execFileAsync(
        'osascript',
        ['-e', 'display dialog "' + esc(message) + '" with title "' + esc(title) + '"'],
        { timeout: SYS_MSGBOX_TIMEOUT_MS },
      );
    } else {
      await execFileAsync('notify-send', [title, message], {
        timeout: SYS_MSGBOX_TIMEOUT_MS,
        windowsHide: true,
      });
    }
    return true;
  } catch { return false; }
}

/**
 * notify 工具：双通道通知。
 * 1. 通过 WebSocketService 向所有已连接客户端广播通知事件；
 * 2. 在服务端所在系统弹出消息框（Windows MessageBox / macOS display dialog /
 *    Linux notify-send）。
 * 危险：false（仅发送通知，无副作用）。
 */
export function createNotifyTool(ws: WebSocketService): ToolDefinition {
  return {
    name: 'notify',
    description:
      '在 Wing 内显示通知（info/warn/error）。只有用户明确需要系统弹窗时才传 system=true；默认不抢占桌面。',
    category: 'system',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '通知标题' },
        message: { type: 'string', description: '通知正文' },
        system: { type: 'boolean', description: 'Explicitly request an OS dialog; defaults to false.' },
        level: {
          type: 'string',
          enum: ['info', 'warn', 'error'],
          description: '通知级别（默认 info）',
        },
      },
      required: ['title', 'message'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as NotifyArgs;
      if (!a || typeof a.title !== 'string' || a.title.length === 0) {
        return { success: false, error: 'Parameter "title" is required and must be a non-empty string' };
      }
      if (typeof a.message !== 'string' || a.message.length === 0) {
        return { success: false, error: 'Parameter "message" is required and must be a non-empty string' };
      }
      const level = a.level === 'warn' || a.level === 'error' ? a.level : 'info';
      const event: WsEvent = {
        type: 'notification',
        data: { title: a.title, message: a.message, level, sessionId: ctx.sessionId },
      };
      try {
        ws.broadcast(event);
        ctx.log('info', `notify: [${level}] ${a.title}`);
        // 双通道：WS 广播成功后追加系统消息框（失败静默，不影响 WS 广播结果）
        const systemDelivered = a.system === true ? await showSystemMessageBox(a.title, a.message) : false;
        return { success: true, output: `Notification sent in Wing: [${level}] ${a.title}`, data: { inApp: true, systemRequested: a.system === true, systemDelivered } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
