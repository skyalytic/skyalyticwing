import { createComputerUseTool } from '../../computer-use/tool.js';
import { existsSync, statSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import { platform } from 'node:os';
import type { ToolDefinition, ToolResult, ToolContext, WsEvent } from '@skyalyticwing/shared';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import { WebSocketService } from '../../../../modules/core/websocket/websocket.service.js';
import { DesktopService, type CmdResult, type ScreenshotOptions, type LaunchOptions } from '../../../../modules/automation/desktop.service.js';
import { BrowserService, type ActionParams } from '../../../../modules/automation/browser.service.js';
import { UiaService } from '../../../../modules/automation/uia.service.js';
import { DesktopControlService } from '../../../../modules/automation/desktop-control.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';

const IS_WIN = platform() === 'win32';


interface DesktopArgs {
  action: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: string;
  doubleClick?: boolean;
  amount?: number;
  direction?: 'up' | 'down';
  speed?: number;
  duration?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  delay?: number;
  savePath?: string;
  window?: string;
  /** 显式要求前台注入（SendInput 抢占键鼠）。缺省 false：有 window 目标时一律后台 PostMessage */
  foreground?: boolean;
  identifier?: string;
  titleFilter?: string;
  width?: number;
  height?: number;
  posX?: number;
  posY?: number;
  content?: string;
  message?: string;
  title?: string;
  dialogType?: string;
  pidOrName?: string | number;
  force?: boolean;
  command?: string;
  args?: string[];
  workDir?: string;
  admin?: boolean;
  // ---- launch_app_smart（智能启动，旧版 uia_launch_app 语义） ----
  appName?: string;
  exePath?: string;
  processName?: string;
  windowTitle?: string;
  method?: 'auto' | 'desktop' | 'search' | 'exe';
  waitMs?: number;
}

interface DesktopScreenshotArgs {
  savePath?: string;
  window?: string;
  region?: { x: number; y: number; width: number; height: number };
}

interface DesktopWindowArgs {
  action: 'list' | 'focus' | 'close' | 'minimize' | 'maximize' | 'active';
  identifier?: string;
  titleFilter?: string;
}

interface BrowserArgs {
  action: string;
  url?: string;
  targetId?: string;
  kind?: string;
  ref?: string;
  selector?: string;
  text?: string;
  button?: string;
  doubleClick?: boolean;
  fullPage?: boolean;
  format?: string;
  refs?: string;
  key?: string;
  value?: string;
  timeoutMs?: number;
  port?: number;
  // ---- pdf ----
  outputPath?: string;
  landscape?: boolean;
  printBackground?: boolean;
  paperWidth?: number;
  paperHeight?: number;
  scale?: number;
  pageRanges?: string;
  // ---- upload / dialog / console ----
  filePaths?: string[];
  response?: string;
  promptText?: string;
  limit?: number;
  clear?: boolean;
}

/** computer_use 工具参数（截图和原生输入参数） */

interface SendFileArgs {
  filePath: string;
  caption?: string;
}

/** CmdResult → ToolResult */
function cmdResult(r: CmdResult, okMsg: string): ToolResult {
  if (r.success) return { success: true, output: okMsg };
  return { success: false, error: r.error ?? r.stderr ?? r.stdout ?? '操作失败' };
}

/**
 * 自动化域工具：desktop / desktop_screenshot / desktop_windows / browser / send_file_to_user。
 *
 * desktop 与 browser 为统一 action 分发工具（与旧版 misc.cjs 语义一致），
 * 桥接 automation 模块的 DesktopService / BrowserService（执行期懒解析）。
 * send_file_to_user 经 PathGuard 校验后通过 WebSocket 广播文件事件
 * （前端可经 /api/files/serve?path= 拉取）。
 */
export function createAutomationTools(
  security: SecurityManagerService,
  ws: WebSocketService,
  resolve: ServiceResolver,
): ToolDefinition[] {
  /** DesktopService / BrowserService 懒解析（首次执行时解析并缓存） */
  const getControl = () => resolve(DesktopControlService);
  const staleInput = (): ToolResult => ({ success: false, error: 'Use computer_use: list_windows → look with one returned rootRef → act with its lookId and observed target. Unbound legacy input is disabled.' });
  let desktopCache: DesktopService | undefined;
  let desktopResolved = false;
  const getDesktop = (): DesktopService | undefined => {
    if (!desktopResolved) {
      desktopCache = resolve(DesktopService);
      desktopResolved = true;
    }
    return desktopCache;
  };
  let browserCache: BrowserService | undefined;
  let browserResolved = false;
  const getBrowser = (): BrowserService | undefined => {
    if (!browserResolved) {
      browserCache = resolve(BrowserService);
      browserResolved = true;
    }
    return browserCache;
  };
  let uiaCache: UiaService | undefined;
  let uiaResolved = false;
  const getUia = (): UiaService | undefined => {
    if (!uiaResolved) {
      uiaCache = resolve(UiaService);
      uiaResolved = true;
    }
    return uiaCache;
  };

  // dangerous 分级权衡（工具级审批无法按 action 区分，见 tool-executor.service.ts
  // 仅按 tool.dangerous 拦截）：desktop 是统一 action 分发入口，若整体置 true，
  // ask 模式下 screenshot/status/list_windows 等只读操作也会全部触发审批，
  // 可用性显著下降，故保持 false。副作用 action（click/type/press/scroll/drag/
  // clipboard_write/kill_process/launch_app/alert/notification 等）的防护交给
  // SecurityManager 的命令/路径校验（launch_app 命令校验、savePath 白名单等）兜底。
  // desktop_windows/desktop_screenshot 以只读（窗口列举/截图）为主，同样保持 false；
  // browser 的 navigate/open 有副作用但已有 SSRF/URL 校验，保持 false。
  // 本次唯一新增 dangerous: true 的是 computer_use（截图定位后的真实点击/输入）。
  const desktopTool: ToolDefinition = {
    name: 'desktop',
    description: 'Desktop diagnostics, screenshots and process utilities. Physical mouse/keyboard/window actions must use computer_use with a selected window and fresh observation. Launching an app does not authorize interacting with it.',
    category: 'interactive',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'screenshot',
            'get_position', 'get_color', 'get_screen_size', 'list_windows', 'get_active_window',
            'clipboard_write', 'clipboard_read', 'alert',
            'notification', 'list_processes', 'kill_process', 'launch_app',
          ],
          description: '要执行的桌面操作类型',
        },
        x: { type: 'number', description: 'X坐标（move/click/drag/get_color）' },
        y: { type: 'number', description: 'Y坐标（move/click/drag/get_color）' },
        toX: { type: 'number', description: '拖拽目标X坐标' },
        toY: { type: 'number', description: '拖拽目标Y坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键' },
        doubleClick: { type: 'boolean', description: '是否双击' },
        amount: { type: 'number', description: '滚动量' },
        direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
        speed: { type: 'number', description: '鼠标移动速度（0=瞬间）' },
        duration: { type: 'number', description: '拖拽持续时间(ms)' },
        text: { type: 'string', description: '键盘输入文本/对话框消息' },
        key: { type: 'string', description: '按键名称（Enter/Tab/Ctrl+A等）' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键 ["ctrl","alt","shift"]' },
        delay: { type: 'number', description: '打字延迟(ms/字符)' },
        savePath: { type: 'string', description: '截图保存路径（须在白名单内）' },
        window: { type: 'string', description: 'Screenshot target only. Use computer_use for observed input.' },
        foreground: { type: 'boolean', description: 'Legacy input is disabled; use computer_use.' },
        identifier: { type: 'string', description: '窗口标识（标题/PID/应用名）' },
        titleFilter: { type: 'string', description: '窗口标题过滤关键词' },
        width: { type: 'number', description: '窗口宽度（resize）' },
        height: { type: 'number', description: '窗口高度（resize）' },
        posX: { type: 'number', description: '窗口位置X（move_window）' },
        posY: { type: 'number', description: '窗口位置Y（move_window）' },
        content: { type: 'string', description: '剪贴板写入内容' },
        message: { type: 'string', description: '通知内容' },
        title: { type: 'string', description: '对话框标题' },
        dialogType: { type: 'string', enum: ['info', 'warning', 'error', 'question'], description: 'alert类型' },
        pidOrName: { type: 'string', description: '进程PID或名称（kill_process）' },
        force: { type: 'boolean', description: '强制杀死进程' },
        command: { type: 'string', description: '启动命令（launch_app；Windows 上传微信/QQ等应用名会自动走多开保护智能启动）' },
        args: { type: 'array', items: { type: 'string' }, description: '启动参数' },
        workDir: { type: 'string', description: '工作目录' },
        appName: { type: 'string', description: '应用名称（launch_app_smart：桌面快捷方式匹配/Windows搜索/窗口匹配，如"微信"）' },
        exePath: { type: 'string', description: 'exe路径（launch_app_smart 最后手段）' },
        processName: { type: 'string', description: '进程名（launch_app_smart PID检查，如 Weixin.exe）' },
        windowTitle: { type: 'string', description: '窗口标题关键词（launch_app_smart，默认appName）' },
        method: { type: 'string', enum: ['auto', 'desktop', 'search', 'exe'], description: 'launch_app_smart 启动方式（默认auto逐级尝试）' },
        waitMs: { type: 'number', description: 'launch_app_smart 启动后等待ms（默认5000）' },
      },
      required: ['action'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as DesktopArgs;
      if (!a || typeof a.action !== 'string' || a.action.length === 0) {
        return { success: false, error: 'Parameter "action" is required' };
      }
      if (["click","type","press","scroll","drag","move","focus","close","minimize","maximize","resize","move_window","focus_window","close_window","minimize_window","maximize_window","resize_window","launch_app_smart","show_desktop"].includes(a.action)) return staleInput();
      if (getControl()?.status().paused && !['status', 'screenshot', 'list_windows', 'get_color', 'clipboard_read', 'list_processes'].includes(a.action)) return { success: false, error: 'Desktop paused by user.' };
      const desktop = getDesktop();
      if (!desktop) {
        return { success: false, error: '桌面自动化服务不可用（AutomationModule 未加载）' };
      }
      try {
        const r = dispatchDesktop(desktop, security, a);
        if (r !== undefined) return r;
        return { success: false, error: `不支持的桌面操作: ${a.action}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const desktopScreenshotTool: ToolDefinition = {
    name: 'desktop_screenshot',
    description: '截取屏幕/指定窗口/指定区域截图并保存为文件（PNG）。返回保存路径。',
    category: 'interactive',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        savePath: { type: 'string', description: '保存路径（须在路径白名单内），默认系统临时目录' },
        window: { type: 'string', description: '指定窗口标题关键词（不传则全屏）' },
        region: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          description: '截图区域 {x,y,width,height}',
        },
      },
      required: [],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as DesktopScreenshotArgs;
      const desktop = getDesktop();
      if (!desktop) {
        return { success: false, error: '桌面自动化服务不可用（AutomationModule 未加载）' };
      }
      try {
        const opts: ScreenshotOptions = {
          window: typeof a.window === 'string' ? a.window : null,
          region: a.region ?? null,
        };
        if (typeof a.savePath === 'string' && a.savePath.length > 0) {
          const resolved = resolvePath(a.savePath);
          if (!security.isPathAllowed(resolved, 'write')) {
            return { success: false, error: `保存路径不在白名单内: ${a.savePath}`, blocked: true };
          }
          opts.path = resolved;
        }
        const result = desktop.screenCapture(opts);
        if (!result.success) {
          return { success: false, error: result.error ?? '截图失败' };
        }
        return {
          success: true,
          output: `截图已保存: ${result.path}`,
          data: { path: result.path, width: result.width, height: result.height, window: result.window },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const desktopWindowsTool: ToolDefinition = {
    name: 'desktop_windows',
    description: '窗口管理：列出系统窗口(list)、获取活动窗口(active)、聚焦/最小化/最大化/关闭指定窗口。',
    category: 'interactive',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'active', 'focus', 'minimize', 'maximize', 'close'],
          description: '窗口操作',
        },
        identifier: { type: 'string', description: '窗口标识（标题关键词/PID/应用名，focus等操作必填）' },
        titleFilter: { type: 'string', description: 'list 时的标题过滤关键词' },
      },
      required: ['action'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as DesktopWindowArgs;
      if (!a || !a.action) {
        return { success: false, error: 'Parameter "action" is required' };
      }
      if (!['list', 'active'].includes(a.action)) return staleInput();
      const desktop = getDesktop();
      if (!desktop) {
        return { success: false, error: '桌面自动化服务不可用（AutomationModule 未加载）' };
      }
      try {
        if (a.action === 'list') {
          const r = desktop.windowList(
            typeof a.titleFilter === 'string' && a.titleFilter ? { titleFilter: a.titleFilter } : {},
          );
          return {
            success: r.success,
            output: `共 ${r.count} 个窗口`,
            data: { windows: r.windows, count: r.count },
            ...(r.error ? { error: r.error } : {}),
          };
        }
        if (a.action === 'active') {
          const info = desktop.windowGetActive();
          return {
            success: !!info,
            output: info ? `活动窗口: ${info.title ?? ''} (${info.appName ?? ''})` : '未获取到活动窗口',
            data: info ?? null,
          };
        }
        if (!a.identifier) {
          return { success: false, error: 'focus/minimize/maximize/close 操作需要 identifier 参数' };
        }
        const r =
          a.action === 'focus'
            ? desktop.windowFocus(a.identifier)
            : a.action === 'minimize'
              ? desktop.windowMinimize(a.identifier)
              : a.action === 'maximize'
                ? desktop.windowMaximize(a.identifier)
                : desktop.windowClose(a.identifier);
        return cmdResult(r, `窗口${a.action}完成: ${a.identifier}`);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const browserTool: ToolDefinition = {
    name: 'browser',
    description:
      '控制浏览器（CDP 连接 Chrome/Edge）。操作：status/start/stop/tabs/open/navigate/snapshot/screenshot/act/extract/pdf/upload/dialog/console/close。先用 snapshot 获取元素引用(ref)，再用 act+ref 操作元素。pdf 导出页面为 PDF 文件；upload 向文件输入框上传本地白名单文件；dialog 查询/处理 JS 对话框；console 读取页面日志。execute(执行任意JS)因安全限制已禁用。',
    category: 'interactive',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop', 'tabs', 'open', 'navigate', 'snapshot', 'screenshot', 'act', 'extract', 'pdf', 'upload', 'dialog', 'console', 'execute', 'close'],
          description: '要执行的操作',
        },
        url: { type: 'string', description: '导航/打开的URL' },
        targetId: { type: 'string', description: '目标标签页ID（从tabs/open获取）' },
        kind: { type: 'string', description: 'act子类型：click/type/press/scroll/hover/wait/select/focus/close' },
        ref: { type: 'string', description: '元素引用（snapshot获取，如e12）' },
        selector: { type: 'string', description: 'CSS选择器（ref替代）' },
        text: { type: 'string', description: '输入的文字' },
        key: { type: 'string', description: '按键（press）' },
        value: { type: 'string', description: 'select选项值' },
        fullPage: { type: 'boolean', description: '是否全页截图' },
        format: { type: 'string', enum: ['text', 'links', 'tables', 'all'], description: 'extract格式' },
        refs: { type: 'string', enum: ['role', 'aria'], description: 'snapshot的ref模式' },
        port: { type: 'number', description: 'CDP端口（start用，默认自动探测）' },
        timeoutMs: { type: 'number', description: '超时毫秒' },
        outputPath: { type: 'string', description: 'pdf 保存路径（须在白名单内），默认临时目录' },
        landscape: { type: 'boolean', description: 'pdf 横向打印' },
        printBackground: { type: 'boolean', description: 'pdf 是否打印背景（默认 true）' },
        paperWidth: { type: 'number', description: 'pdf 纸张宽（英寸，默认 8.5）' },
        paperHeight: { type: 'number', description: 'pdf 纸张高（英寸，默认 11）' },
        scale: { type: 'number', description: 'pdf 缩放（0.1-2，默认 1）' },
        pageRanges: { type: 'string', description: 'pdf 页码范围，如 1-5' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'upload 的本地文件路径列表（须存在且在读取白名单内）' },
        response: { type: 'string', enum: ['accept', 'dismiss'], description: 'dialog 处理方式（不传则查询当前对话框状态）' },
        promptText: { type: 'string', description: 'dialog prompt 输入文本' },
        limit: { type: 'number', description: 'console 返回最近 N 条（默认 50）' },
        clear: { type: 'boolean', description: 'console 读取后清空缓冲' },
      },
      required: ['action'],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = args as BrowserArgs;
      if (!a || typeof a.action !== 'string' || a.action.length === 0) {
        return { success: false, error: 'Parameter "action" is required' };
      }
      const browser = getBrowser();
      if (!browser) {
        return { success: false, error: '浏览器自动化服务不可用（AutomationModule 未加载）' };
      }
      try {
        switch (a.action) {
          case 'status': {
            const st = await browser.browserStatus();
            return {
              success: st.ok,
              output: st.connected
                ? `浏览器已连接 (cdp=${st.cdpUrl}, ${st.tabs.length}个标签页)`
                : '浏览器未连接，请先 action=start',
              data: st,
            };
          }
          case 'start': {
            const r = await browser.connectBrowser(
              typeof a.port === 'number' && a.port > 0 ? { port: a.port } : undefined,
            );
            return { success: !!r, output: '浏览器已连接', data: r };
          }
          case 'stop':
          case 'close': {
            const r = await browser.close();
            return { success: r.ok, output: '浏览器连接已关闭' };
          }
          case 'tabs': {
            const r = await browser.browserTabs();
            return {
              success: r.ok,
              output: `${r.tabs.length} 个标签页`,
              data: r.tabs,
            };
          }
          case 'open': {
            if (!a.url) return { success: false, error: 'open 需要 url 参数' };
            const r = await browser.browserOpenTab(a.url);
            if (!r.ok) return { success: false, error: r.error ?? '打开标签页失败' };
            return { success: true, output: `已打开: ${r.url ?? a.url}`, data: r };
          }
          case 'navigate': {
            if (!a.url) return { success: false, error: 'navigate 需要 url 参数' };
            const r = await browser.navigate(a.url, a.targetId);
            if (!r.ok) return { success: false, error: r.error ?? '导航失败' };
            return { success: true, output: `已导航: ${r.url ?? a.url} (title=${r.title ?? ''})`, data: r };
          }
          case 'snapshot': {
            const r = await browser.browserSnapshot(
              typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : undefined,
            );
            if (!r.ok) return { success: false, error: r.error ?? '快照失败（浏览器是否已连接？）' };
            return {
              success: true,
              output: (r.text ?? '').slice(0, 50_000),
              data: { refs: r.refs, url: r.url, title: r.title },
            };
          }
          case 'screenshot': {
            const r = await browser.browserScreenshot({
              ...(typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : {}),
              ...(a.fullPage !== undefined ? { fullPage: a.fullPage } : {}),
            });
            if (!r.ok) return { success: false, error: r.error ?? '截图失败（浏览器是否已连接？）' };
            return { success: true, output: `截图已保存: ${r.path ?? ''}`, data: r };
          }
          case 'act': {
            if (!a.kind) return { success: false, error: 'act 需要 kind 参数（click/type/press/...）' };
            const params: ActionParams = { kind: a.kind };
            if (typeof a.ref === 'string' && a.ref) params.ref = a.ref;
            if (typeof a.selector === 'string' && a.selector) params.selector = a.selector;
            if (typeof a.text === 'string' && a.text) params.text = a.text;
            if (typeof a.key === 'string' && a.key) params.key = a.key;
            if (typeof a.value === 'string' && a.value) params.value = a.value;
            if (typeof a.timeoutMs === 'number' && a.timeoutMs > 0) params.timeoutMs = a.timeoutMs;
            const r = await browser.browserAct(params, a.targetId);
            if (!r.ok) return { success: false, error: r.error ?? `act(${a.kind}) 失败` };
            return { success: true, output: `act(${a.kind}) 完成`, data: r };
          }
          case 'extract': {
            const r = await browser.browserExtract({
              ...(typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : {}),
              ...(typeof a.format === 'string' && a.format ? { format: a.format } : {}),
            });
            if (!r.ok) return { success: false, error: r.error ?? '提取失败' };
            return {
              success: true,
              output: (r.text ?? '').slice(0, 50_000),
              data: { links: r.links, tables: r.tables, truncated: r.truncated },
            };
          }
          case 'pdf': {
            // 保存路径白名单校验（与 screenshot 保存一致），未传则落临时目录
            let outputPath: string | undefined;
            if (typeof a.outputPath === 'string' && a.outputPath.length > 0) {
              const resolved = resolvePath(a.outputPath);
              if (!security.isPathAllowed(resolved, 'write')) {
                return { success: false, error: `保存路径不在白名单内: ${a.outputPath}`, blocked: true };
              }
              outputPath = resolved;
            }
            const r = await browser.browserPdf({
              ...(typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : {}),
              ...(outputPath ? { outputPath } : {}),
              ...(a.landscape !== undefined ? { landscape: a.landscape } : {}),
              ...(a.printBackground !== undefined ? { printBackground: a.printBackground } : {}),
              ...(typeof a.paperWidth === 'number' ? { paperWidth: a.paperWidth } : {}),
              ...(typeof a.paperHeight === 'number' ? { paperHeight: a.paperHeight } : {}),
              ...(typeof a.scale === 'number' ? { scale: a.scale } : {}),
              ...(typeof a.pageRanges === 'string' && a.pageRanges ? { pageRanges: a.pageRanges } : {}),
            });
            if (!r.ok) return { success: false, error: r.error ?? 'PDF 导出失败' };
            return {
              success: true,
              output: `PDF 已导出: ${r.path ?? ''}`,
              data: { file: r.path, kind: 'file', ...(r.size !== undefined ? { size: r.size } : {}) },
            };
          }
          case 'upload': {
            const selector = (typeof a.selector === 'string' && a.selector ? a.selector : '') || a.ref;
            if (!selector) return { success: false, error: 'upload 需要 selector 或 ref 参数（文件输入框定位）' };
            if (!Array.isArray(a.filePaths) || a.filePaths.length === 0) {
              return { success: false, error: 'upload 需要 filePaths 数组参数（至少一个文件路径）' };
            }
            // 本地文件须存在且在读取白名单内
            const resolvedFiles: string[] = [];
            for (const fp of a.filePaths) {
              if (typeof fp !== 'string' || fp.length === 0) {
                return { success: false, error: 'filePaths 数组元素必须为非空字符串' };
              }
              const resolved = resolvePath(fp);
              if (!security.isPathAllowed(resolved, 'read')) {
                return { success: false, error: `文件路径不在白名单内: ${fp}`, blocked: true };
              }
              if (!existsSync(resolved)) {
                return { success: false, error: `文件不存在: ${fp}` };
              }
              resolvedFiles.push(resolved);
            }
            const r = await browser.browserUpload({
              ...(typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : {}),
              selector,
              filePaths: resolvedFiles,
            });
            if (!r.ok) return { success: false, error: r.error ?? '文件上传失败' };
            return { success: true, output: `已上传 ${resolvedFiles.length} 个文件到 ${selector}`, data: r };
          }
          case 'dialog': {
            // response 缺省=查询最近对话框状态；accept/dismiss=主动处理（Page.handleJavaScriptDialog 语义）
            const response = a.response === 'accept' || a.response === 'dismiss' ? a.response : undefined;
            const r = await browser.browserDialog({
              ...(typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : {}),
              ...(response ? { response } : {}),
              ...(typeof a.promptText === 'string' && a.promptText ? { promptText: a.promptText } : {}),
            });
            if (!r.ok) return { success: false, error: r.error ?? '对话框处理失败' };
            if (response) {
              return { success: true, output: `对话框已 ${response === 'accept' ? '接受' : '拒绝'}`, data: r };
            }
            const d = r.dialog ?? null;
            return {
              success: true,
              output: d && !d.handled
                ? `待处理对话框 [${d.type}]: ${d.message}`
                : d
                  ? `最近对话框（已处理） [${d.type}]: ${d.message}`
                  : '当前没有待处理的 JS 对话框',
              data: d,
            };
          }
          case 'console': {
            const r = await browser.browserConsole({
              ...(typeof a.targetId === 'string' && a.targetId ? { targetId: a.targetId } : {}),
              ...(typeof a.limit === 'number' && a.limit > 0 ? { limit: a.limit } : {}),
              ...(a.clear !== undefined ? { clear: a.clear } : {}),
            });
            if (!r.ok) return { success: false, error: r.error ?? '读取 console 日志失败' };
            return {
              success: true,
              output: `console: ${r.logs.length} 条日志 / ${r.errors.length} 条页面错误${a.clear === true ? '（已清空）' : ''}`,
              data: { logs: r.logs, errors: r.errors },
            };
          }
          case 'execute': {
            return {
              success: false,
              error: 'execute 已禁用：出于安全考虑不允许在页面中执行任意 JavaScript（可用 act/extract 完成常见操作）',
              blocked: true,
            };
          }
          default:
            return { success: false, error: `不支持的浏览器操作: ${a.action}` };
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const computerUseTool = createComputerUseTool(resolve);

  const sendFileTool: ToolDefinition = {
    name: 'send_file_to_user',
    description:
      '通过当前会话向用户发送文件/图片。先准备好文件路径，再用本工具发送（客户端会收到文件事件，可经 /api/files/serve 下载）。支持 png/jpg/gif/webp/pdf/doc/xls/ppt/txt/zip 等格式。',
    category: 'session',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要发送的文件绝对路径' },
        caption: { type: 'string', description: '随文件附带的文字说明' },
      },
      required: ['filePath'],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const a = args as SendFileArgs;
      if (!a || typeof a.filePath !== 'string' || a.filePath.length === 0) {
        return { success: false, error: 'Parameter "filePath" is required and must be a non-empty string' };
      }
      const absPath = resolvePath(a.filePath);
      if (absPath.includes('\0')) {
        return { success: false, error: 'filePath must not contain null bytes' };
      }
      if (!security.isPathAllowed(absPath, 'read')) {
        return { success: false, error: `文件路径不在白名单内: ${absPath}`, blocked: true };
      }
      if (!existsSync(absPath)) {
        return { success: false, error: `文件不存在: ${a.filePath}` };
      }
      try {
        const stat = statSync(absPath);
        const payload = {
          file: absPath,
          filename: basename(absPath),
          ext: extname(absPath).toLowerCase().replace('.', ''),
          size: stat.size,
          caption: typeof a.caption === 'string' ? a.caption : '',
          url: `/api/files/serve?path=${encodeURIComponent(absPath)}`,
          sessionId: ctx.sessionId,
        };
        // 事件广播：ToolContext.broadcast（agent 循环转发）+ WebSocket 通知兜底
        ctx.broadcast('file_offer', payload);
        const evt: WsEvent = {
          type: 'notification',
          data: {
            title: '文件发送',
            message: `${payload.filename} (${Math.round(stat.size / 1024)}KB) ${payload.caption}`,
            level: 'info',
            sessionId: ctx.sessionId,
          },
        };
        ws.broadcast(evt);
        ctx.log('info', `send_file_to_user: ${absPath}`);
        return {
          success: true,
          output: `文件已发送: ${payload.filename} (${stat.size} bytes)，下载地址 ${payload.url}`,
          data: payload,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  // ────────────────────────────────────────────────────────────
  // uia_diagnostics：UIA 桥接诊断
  // （原 ocr-voice-tools.ts 同名工具迁移——该文件的 OCR/语音/音乐/媒体分析
  //  工具已随旧媒体套件清理移除，UIA 诊断属桌面自动化域故迁入此处）
  // ────────────────────────────────────────────────────────────
  const uiaDiagnosticsTool: ToolDefinition = {
    name: 'uia_diagnostics',
    description:
      'UIA（Windows UI Automation）桥接诊断。检查 windows-bridge.exe 是否可用、' +
      '协议版本、helper 进程状态。computer_use 工具报"bridge 不可用"时先用本工具排查。',
    category: 'automation',
    dangerous: false,
    parameters: { type: 'object', properties: {} },
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const uia = getUia();
      if (!uia) return { success: false, error: 'UIA 服务不可用（AutomationModule 未加载）' };
      try {
        const r = await uia.diagnostics();
        return {
          success: true,
          output: JSON.stringify(r).slice(0, 20_000),
          data: r as Record<string, unknown>,
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return [
    desktopTool,
    desktopScreenshotTool,
    desktopWindowsTool,
    browserTool,
    computerUseTool,
    sendFileTool,
    uiaDiagnosticsTool,
  ];
}

/** desktop 统一工具的 action 分发；返回 undefined 表示 action 未被处理 */
function dispatchDesktop(
  desktop: DesktopService,
  security: SecurityManagerService,
  a: DesktopArgs,
): ToolResult | undefined {
  switch (a.action) {
    case 'status':
      return { success: true, output: JSON.stringify(desktop.getStatus()), data: desktop.getStatus() };
    case 'screenshot': {
      const opts: ScreenshotOptions = { window: a.window ?? null, region: null };
      if (typeof a.savePath === 'string' && a.savePath.length > 0) {
        const resolved = resolvePath(a.savePath);
        if (!security.isPathAllowed(resolved, 'write')) {
          return { success: false, error: `保存路径不在白名单内: ${a.savePath}`, blocked: true };
        }
        opts.path = resolved;
      }
      const r = desktop.screenCapture(opts);
      return r.success
        ? { success: true, output: `截图已保存: ${r.path}`, data: r }
        : { success: false, error: r.error ?? '截图失败' };
    }
    case 'move': {
      if (typeof a.x !== 'number' || typeof a.y !== 'number') {
        return { success: false, error: 'move 需要 x/y 数值参数' };
      }
      return cmdResult(
        desktop.mouseMove(a.x, a.y, typeof a.speed === 'number' ? { speed: a.speed } : undefined),
        `鼠标已移动到 (${a.x},${a.y})`,
      );
    }
    case 'click': {
      // 后台优先：给了 window（或给了坐标）且未显式 foreground → PostMessage 后台点击，
      // 不抢焦点不干扰用户键鼠；其余情况保持原前台路径
      const wantBackground = a.foreground !== true && (IS_WIN && (!!a.window || (typeof a.x === 'number' && typeof a.y === 'number')));
      if (wantBackground) {
        const r = desktop.bgClick({
          ...(a.window ? { window: a.window } : {}),
          ...(typeof a.x === 'number' ? { x: a.x } : {}),
          ...(typeof a.y === 'number' ? { y: a.y } : {}),
          ...(a.button ? { button: a.button } : {}),
          ...(a.doubleClick ? { double: true } : {}),
        });
        return cmdResult(r, `后台点击完成（不抢焦点）(${a.button ?? 'left'}${a.doubleClick ? ',double' : ''})`);
      }
      return cmdResult(
        desktop.mouseClick(a.button, {
          double: a.doubleClick === true,
          ...(typeof a.x === 'number' ? { x: a.x } : {}),
          ...(typeof a.y === 'number' ? { y: a.y } : {}),
        }),
        `点击完成 (${a.button ?? 'left'}${a.doubleClick ? ',double' : ''})`,
      );
    }
    case 'scroll': {
      // 后台优先：指定 window 时滚动直接投递到目标窗口
      if (a.foreground !== true && IS_WIN && a.window) {
        const r = desktop.bgScroll(a.window, a.amount ?? 1, a.direction ?? 'down');
        return cmdResult(r, `后台滚动完成（不抢焦点）${a.amount ?? 1} ${a.direction ?? 'down'}`);
      }
      return cmdResult(
        desktop.mouseScroll(a.amount ?? 1, a.direction ?? 'down'),
        `滚动完成 ${a.amount ?? 1} ${a.direction ?? 'down'}`,
      );
    }
    case 'drag': {
      if (typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.toX !== 'number' || typeof a.toY !== 'number') {
        return { success: false, error: 'drag 需要 x/y/toX/toY 数值参数' };
      }
      return cmdResult(
        desktop.mouseDrag(a.x, a.y, a.toX, a.toY, typeof a.duration === 'number' ? { duration: a.duration } : undefined),
        `拖拽完成 (${a.x},${a.y})→(${a.toX},${a.toY})`,
      );
    }
    case 'type': {
      if (!a.text) return { success: false, error: 'type 需要 text 参数' };
      // 后台优先：指定 window 时文本直达目标窗口消息队列（中文走 GBK WM_CHAR）
      if (a.foreground !== true && IS_WIN && a.window) {
        const r = desktop.bgType(a.window, a.text, typeof a.delay === 'number' ? { delay: a.delay } : undefined);
        return r.success
          ? { success: true, output: `已后台输入 ${a.text.length} 个字符到「${a.window}」（不抢焦点）` }
          : { success: false, error: r.error ?? '后台输入失败（可用 list_windows 确认标题，或改用 foreground:true 前台输入）' };
      }
      const r = desktop.keyType(a.text, typeof a.delay === 'number' ? { delay: a.delay } : undefined);
      return r.success
        ? { success: true, output: `已输入 ${r.chars ?? a.text.length} 个字符 (${r.method ?? ''})` }
        : { success: false, error: r.error ?? '输入失败' };
    }
    case 'press': {
      if (!a.key) return { success: false, error: 'press 需要 key 参数' };
      // 后台优先：指定 window 时组合键投递到目标窗口
      if (a.foreground !== true && IS_WIN && a.window) {
        const r = desktop.bgKey(a.window, a.key, a.modifiers);
        return cmdResult(r, `后台按键完成（不抢焦点）: ${a.key}`);
      }
      return cmdResult(desktop.keyPress(a.key, a.modifiers), `按键完成: ${a.key}`);
    }
    case 'get_position': {
      const p = desktop.mouseGetPosition();
      return p
        ? { success: true, output: `鼠标位置: (${p.x},${p.y})`, data: p }
        : { success: false, error: '未获取到鼠标位置' };
    }
    case 'get_color': {
      if (typeof a.x !== 'number' || typeof a.y !== 'number') {
        return { success: false, error: 'get_color 需要 x/y 数值参数' };
      }
      const c = desktop.screenGetColor(a.x, a.y);
      return c
        ? { success: true, output: `颜色: rgb(${c.r},${c.g},${c.b}) #${c.hex}`, data: c }
        : { success: false, error: '取色失败' };
    }
    case 'get_screen_size': {
      const s = desktop.screenGetSize();
      return { success: true, output: `屏幕尺寸: ${s.width}x${s.height}`, data: s };
    }
    case 'list_windows': {
      const r = desktop.windowList(
        typeof a.titleFilter === 'string' && a.titleFilter ? { titleFilter: a.titleFilter } : {},
      );
      return {
        success: r.success,
        output: `共 ${r.count} 个窗口`,
        data: { windows: r.windows, count: r.count },
        ...(r.error ? { error: r.error } : {}),
      };
    }
    case 'get_active_window': {
      const info = desktop.windowGetActive();
      return {
        success: !!info,
        output: info ? `活动窗口: ${info.title ?? ''}` : '未获取到活动窗口',
        data: info ?? null,
      };
    }
    case 'focus_window':
      return windowCmd(desktop, 'focus', a.identifier);
    case 'minimize_window':
      return windowCmd(desktop, 'minimize', a.identifier);
    case 'maximize_window':
      return windowCmd(desktop, 'maximize', a.identifier);
    case 'close_window':
      return windowCmd(desktop, 'close', a.identifier);
    case 'resize_window': {
      if (!a.identifier || typeof a.width !== 'number' || typeof a.height !== 'number') {
        return { success: false, error: 'resize_window 需要 identifier/width/height' };
      }
      return cmdResult(
        desktop.windowResize(a.identifier, a.width, a.height),
        `窗口已调整: ${a.identifier} ${a.width}x${a.height}`,
      );
    }
    case 'move_window': {
      if (!a.identifier || typeof a.posX !== 'number' || typeof a.posY !== 'number') {
        return { success: false, error: 'move_window 需要 identifier/posX/posY' };
      }
      return cmdResult(
        desktop.windowSetPosition(a.identifier, a.posX, a.posY),
        `窗口已移动: ${a.identifier} → (${a.posX},${a.posY})`,
      );
    }
    case 'show_desktop':
      return cmdResult(desktop.windowShowDesktop(), '已显示桌面');
    case 'clipboard_write': {
      if (typeof a.content !== 'string') return { success: false, error: 'clipboard_write 需要 content 参数' };
      return cmdResult(desktop.clipboardWrite(a.content), '剪贴板已写入');
    }
    case 'clipboard_read': {
      const text = desktop.clipboardRead();
      return text !== null
        ? { success: true, output: text.slice(0, 20_000) }
        : { success: false, error: '剪贴板读取失败或为空' };
    }
    case 'alert': {
      if (!a.message) return { success: false, error: 'alert 需要 message 参数' };
      return cmdResult(
        desktop.dialogAlert(a.message, a.title, { type: a.dialogType ?? 'info' }),
        '对话框已显示',
      );
    }
    case 'notification': {
      if (!a.message) return { success: false, error: 'notification 需要 message 参数' };
      return cmdResult(desktop.dialogNotification(a.message, a.title ?? '通知'), '通知已发送');
    }
    case 'list_processes': {
      const r = desktop.processList();
      return {
        success: r.success,
        output: `共 ${r.count} 个进程`,
        data: { processes: r.processes.slice(0, 200), count: r.count },
        ...(r.error ? { error: r.error } : {}),
      };
    }
    case 'kill_process': {
      if (a.pidOrName === undefined || a.pidOrName === null || a.pidOrName === '') {
        return { success: false, error: 'kill_process 需要 pidOrName 参数' };
      }
      const r = desktop.processKill(a.pidOrName, a.force !== false);
      return r.success
        ? { success: true, output: `进程已终止: ${a.pidOrName}` }
        : { success: false, error: r.error ?? r.stderr ?? `终止进程失败: ${a.pidOrName}` };
    }
    case 'launch_app': {
      if (!a.command) return { success: false, error: 'launch_app 需要 command 参数' };
      const opts: LaunchOptions = {};
      if (Array.isArray(a.args)) opts.args = a.args;
      if (typeof a.workDir === 'string' && a.workDir) opts.cwd = a.workDir;
      if (a.admin === true) opts.admin = true;
      const r = desktop.processLaunch(a.command, opts);
      return r.success
        ? { success: true, output: `已启动: ${a.command}${r.pid ? ` (pid=${r.pid})` : ''}` }
        : { success: false, error: r.error ?? r.stderr ?? '启动失败' };
    }
    default:
      return undefined;
  }
}

/** 窗口命令（focus/minimize/maximize/close） */
function windowCmd(
  desktop: DesktopService,
  kind: 'focus' | 'minimize' | 'maximize' | 'close',
  identifier?: string,
): ToolResult {
  if (!identifier) return { success: false, error: `${kind}_window 需要 identifier 参数` };
  const r =
    kind === 'focus'
      ? desktop.windowFocus(identifier)
      : kind === 'minimize'
        ? desktop.windowMinimize(identifier)
        : kind === 'maximize'
          ? desktop.windowMaximize(identifier)
          : desktop.windowClose(identifier);
  return cmdResult(r, `窗口${kind}完成: ${identifier}`);
}
