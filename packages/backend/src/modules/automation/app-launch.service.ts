import { Injectable, Optional } from '@nestjs/common';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { LoggerService } from '../core/logger/logger.service.js';
import { UiaService } from './uia.service.js';

/** 平台标识 */
const IS_WIN = platform() === 'win32';

/** launch_app 参数 */
export interface LaunchAppOptions {
  /** 应用名称（桌面快捷方式匹配/Windows 搜索/窗口匹配），如 "企业微信"、"微信"、"QQ" */
  appName?: string;
  /** exe 路径（最后手段：直接启动与进程名推断） */
  exePath?: string;
  /** 进程名（PID 检查），如 "WXWork.exe"、"WeChat.exe" */
  processName?: string;
  /** 窗口标题关键词（UIA 查找窗口），默认 appName */
  windowTitle?: string;
  /** 启动方式：'desktop' | 'search' | 'exe' | 'auto'（默认 auto 逐级尝试） */
  method?: 'desktop' | 'search' | 'exe' | 'auto';
  /** 启动后等待时间 ms（默认 5000） */
  waitMs?: number;
}

/** launch_app 结果 */
export interface LaunchAppResult {
  ok: boolean;
  /** 已在运行时激活既有窗口（未重新启动） */
  activated?: boolean;
  /** 本次真实启动了应用 */
  launched?: boolean;
  alreadyRunning?: boolean;
  /** 启动方式：desktop / search / exe */
  method?: string;
  processName?: string;
  windowTitle?: string;
  /** 多开防护触发：检测到多个有窗口的实例，拒绝启动 */
  multiInstance?: boolean;
  windowCount?: number;
  /** 从托盘恢复了隐藏窗口 */
  restoredFromTray?: boolean;
  /** 检测到登录界面（需用户手动扫码/登录） */
  needsLogin?: boolean;
  loginType?: 'qr_code' | 'login' | 'wechat_account_login';
  shortcut?: string;
  nowRunning?: boolean;
  error?: string;
  log: string[];
  hint?: string;
}

/** 常见应用多候选进程名（防止传错 processName 导致检测失效而多开） */
const APP_PROC_CANDIDATES: Record<string, string[]> = {
  微信: ['Weixin.exe', 'WeChat.exe', 'xwechat.exe'],
  WeChat: ['Weixin.exe', 'WeChat.exe', 'xwechat.exe'],
  Weixin: ['Weixin.exe', 'WeChat.exe', 'xwechat.exe'],
  QQ: ['QQ.exe'],
  企业微信: ['WXWork.exe'],
  WXWork: ['WXWork.exe'],
  钉钉: ['DingTalk.exe'],
  DingTalk: ['DingTalk.exe'],
  飞书: ['Lark.exe', 'Feishu.exe'],
  Lark: ['Lark.exe', 'Feishu.exe'],
};

/** 快捷方式模糊匹配排除关键词（"微信"不匹配"微信开发助手"等） */
const EXCLUDE_KEYWORDS = [
  '开发', 'dev', '助手', 'helper', 'tools', 'tool', 'beta', '调试', 'debug',
  'uninstall', '卸载', '更新', 'update', '电脑管家', '安全卫士', 'tray', '托盘',
];

/** 标题歧义排除：标题属于"其他应用"（"企业微信"不匹配"微信"目标） */
const APP_TITLE_GROUPS: Array<{ apps: string[]; names: string[] }> = [
  { apps: ['微信', 'WeChat', 'Weixin'], names: ['企业微信', 'WXWork', '钉钉', 'DingTalk', '飞书', 'Lark', 'Feishu', 'QQ'] },
  { apps: ['企业微信', 'WXWork'], names: ['微信', 'WeChat', 'Weixin', '钉钉', 'DingTalk', '飞书', 'Lark', 'Feishu', 'QQ'] },
];

/**
 * AppLaunchService - 智能应用启动（多开保护）
 *
 * 全量移植旧版 start.cjs uia_launch_app（20565-21665 行）语义：
 *   1. 桌面快捷方式查找（支持桌面重定向 + 模糊匹配排除干扰项）
 *   2. 进程 PID 检查（多候选进程名，微信 4.x/3.x 全覆盖）
 *      - 在运行 → UIA listRoots + Win32 API 激活窗口（绝不重启，防多开）
 *      - 托盘隐藏 → manage-window.ps1 restorehidden 恢复
 *      - 多开（>1 个有窗口实例）→ 拒绝启动并告知用户
 *   3. 未运行 → 桌面快捷方式启动（等同双击）→ Win 搜索 → exePath（最后手段）
 *   4. 启动/激活后登录界面检测（二维码/登录/微信"进入微信"等）
 *
 * 非托管 exe（计算器/记事本等系统应用）应继续走 DesktopService.processLaunch，
 * 本服务面向"桌面应用"（微信/QQ/企业微信等有窗口、怕多开的应用）。
 */
@Injectable()
export class AppLaunchService {
  private manageWindowScriptPath: string | null | undefined;

  constructor(
    @Optional() private readonly logger?: LoggerService,
    @Optional() private readonly uia?: UiaService,
  ) {}

  /** 智能启动/激活应用 */
  async launchApp(opts: LaunchAppOptions): Promise<LaunchAppResult> {
    const appName = opts.appName || '';
    let exePath = opts.exePath || '';
    let processName = opts.processName || (exePath ? basename(exePath) : '');
    const windowTitle = opts.windowTitle || appName;
    const method = opts.method || 'auto';
    const waitMs = opts.waitMs ?? 5000;
    const log: string[] = [];
    const t0 = Date.now();
    const logAdd = (msg: string) => log.push(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

    if (!appName && !exePath) {
      return { ok: false, error: '必须提供 appName（应用名称）或 exePath 参数', log };
    }
    if (!IS_WIN) {
      // 非 Windows：无多开保护语义，直接 exePath/appName 启动
      return this.launchNonWindows(opts, log);
    }

    // ===== 1. 桌面快捷方式查找 =====
    let desktopShortcut: string | null = null;
    if (appName) {
      desktopShortcut = this.findDesktopShortcut(appName, logAdd);
      logAdd(`桌面快捷方式: ${desktopShortcut ?? '未找到'}`);
    }

    // 从快捷方式推断 processName/exePath
    if (!processName && desktopShortcut) {
      const target = this.readShortcutTarget(desktopShortcut, logAdd);
      if (target) {
        processName = basename(target);
        if (!exePath) exePath = target;
        logAdd(`从快捷方式推断: processName=${processName}, exePath=${exePath}`);
      }
    }

    // ===== 2. 进程检查（多候选） =====
    const candidates: string[] = [];
    const addCandidate = (n: string) => {
      if (n && !candidates.some((x) => x.toLowerCase() === n.toLowerCase())) candidates.push(n);
    };
    for (const n of APP_PROC_CANDIDATES[appName] ?? []) addCandidate(n);
    if (processName) addCandidate(processName);

    let matchedProcs: string[] = [];
    let windowCount = 0;
    for (const name of candidates) {
      const r = this.checkProcRunning(name);
      logAdd(`进程检查: ${name} → ${r.running ? `在运行(${r.count}个)` : '未运行'}`);
      if (r.running) matchedProcs.push(name);
    }
    const isRunning = matchedProcs.length > 0;
    if (matchedProcs.length > 0) processName = matchedProcs[0];
    else if (candidates.length > 0) processName = candidates[0];

    // 有窗口的进程数（区分 Chromium 子进程——只有主进程有窗口）
    if (isRunning) {
      for (const name of matchedProcs) {
        windowCount += this.countWindowedProcesses(name) ?? 1;
      }
      logAdd(`进程状态: 运行中=[${matchedProcs.join(', ')}], 有窗口: ${windowCount}`);
    }

    // 多开防护：>1 个有窗口实例 = 真正多开，拒绝启动
    if (windowCount > 1) {
      return {
        ok: false,
        alreadyRunning: true,
        multiInstance: true,
        windowCount,
        processName,
        log,
        error: `检测到 ${windowCount} 个 ${processName} 窗口在运行（真正的多开）！绝对不能再次启动。请告知用户：应用已经多开了，请手动关闭多余的窗口（只保留一个），然后重新尝试。`,
        hint: '1.告知用户应用已多开  2.建议用户手动关闭多余窗口  3.绝对不要再次启动应用  4.等待用户确认后再继续',
      };
    }

    // ===== 3. 已在运行 → 激活窗口（绝不重启） =====
    if (isRunning) {
      return this.activateExistingWindow(processName, windowTitle || appName, log, logAdd);
    }

    // ===== 4. 未运行 → 启动（快捷方式 → Win 搜索 → exePath） =====
    // 方法1：桌面快捷方式
    if (desktopShortcut && (method === 'auto' || method === 'desktop')) {
      logAdd(`用桌面快捷方式启动: ${desktopShortcut}`);
      this.shellStart(desktopShortcut);
      await this.sleep(waitMs);
      const nowRunning = processName ? this.checkProcRunning(processName).running : true;
      logAdd(`桌面快捷方式启动完成, 进程运行: ${nowRunning}`);
      if (nowRunning || !processName) {
        return this.afterLaunchResult('desktop', processName, desktopShortcut, nowRunning, log, logAdd);
      }
    }

    // 方法2：Windows 搜索（Win 键 + 应用名 + Enter）
    if ((method === 'auto' || method === 'search') && appName) {
      logAdd(`尝试 Windows 搜索方式: Win + "${appName}" + Enter`);
      const searched = await this.winSearchLaunch(appName, logAdd);
      if (searched) {
        await this.sleep(waitMs);
        const nowRunning = processName ? this.checkProcRunning(processName).running : true;
        if (nowRunning || !processName) {
          return this.afterLaunchResult('search', processName, undefined, nowRunning, log, logAdd);
        }
        logAdd('Windows 搜索后进程未找到，尝试 exePath 方式');
      }
    }

    // 方法3：exePath 直接启动（最后手段）
    if ((method === 'auto' || method === 'exe') && exePath) {
      logAdd(`尝试 exePath 启动（最后手段）: ${exePath}`);
      if (!existsSync(exePath)) {
        return { ok: false, error: `可执行文件不存在: ${exePath}`, log };
      }
      this.shellStart(exePath);
      await this.sleep(waitMs);
      const nowRunning = processName ? this.checkProcRunning(processName).running : true;
      logAdd(`exePath 启动完成, 进程运行: ${nowRunning}`);
      return this.afterLaunchResult('exe', processName, undefined, nowRunning, log, logAdd);
    }

    return { ok: false, error: '无法启动应用，请检查 appName 或 exePath 参数', log };
  }

  // ============================================================
  // 内部实现
  // ============================================================

  /** 非 Windows 启动（mac open -a / linux 直接执行） */
  private async launchNonWindows(opts: LaunchAppOptions, log: string[]): Promise<LaunchAppResult> {
    const target = opts.exePath || opts.appName;
    if (!target) return { ok: false, error: 'appName 或 exePath 必填', log };
    try {
      if (platform() === 'darwin') {
        execFile('open', ['-a', target], () => undefined);
      } else {
        spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
      }
      await this.sleep(opts.waitMs ?? 3000);
      return { ok: true, launched: true, method: 'unix', log };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), log };
    }
  }

  /** 桌面快捷方式查找：精确匹配 → 模糊匹配（排除干扰项，最短优先） */
  private findDesktopShortcut(appName: string, logAdd: (m: string) => void): string | null {
    const desktopDirs: string[] = [];
    try {
      const userDesktop = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      ).trim();
      if (userDesktop) desktopDirs.push(userDesktop);
    } catch {
      // 忽略
    }
    const homeDesktop = join(homedir(), 'Desktop');
    if (!desktopDirs.includes(homeDesktop)) desktopDirs.push(homeDesktop);
    desktopDirs.push('C:\\Users\\Public\\Desktop');

    for (const dir of desktopDirs) {
      try {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir);
        // 精确匹配
        for (const f of files) {
          if (f.toLowerCase().endsWith('.lnk') && f.slice(0, -4) === appName) {
            return join(dir, f);
          }
        }
        // 模糊匹配：包含 appName 且不命中排除词，按文件名长度升序（最短最精确）
        const candidates: Array<{ file: string; dir: string; len: number }> = [];
        for (const f of files) {
          if (!f.toLowerCase().endsWith('.lnk')) continue;
          const base = f.slice(0, -4);
          if (base.includes(appName) && !shouldExcludeCandidate(base, appName)) {
            candidates.push({ file: f, dir, len: base.length });
          }
        }
        candidates.sort((a, b) => a.len - b.len);
        if (candidates.length > 0) {
          logAdd(`模糊匹配: 找到 ${candidates.length} 个候选，选择最短: "${candidates[0].file.slice(0, -4)}"`);
          return join(candidates[0].dir, candidates[0].file);
        }
      } catch {
        // 目录读取失败继续
      }
    }
    return null;
  }

  /** 读 .lnk 目标路径（WScript.Shell COM） */
  private readShortcutTarget(shortcut: string, logAdd: (m: string) => void): string | null {
    try {
      const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${shortcut.replace(/'/g, "''")}');Write-Output $s.TargetPath`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
      if (out && existsSync(out)) return out;
    } catch (e) {
      logAdd(`推断 processName 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }

  /** tasklist 检查进程（数组参数防注入） */
  private checkProcRunning(procName: string): { running: boolean; count: number } {
    try {
      const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${procName}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      if (out.toLowerCase().includes(procName.toLowerCase())) {
        const esc = procName.replace(/\./g, '\\.');
        return { running: true, count: (out.match(new RegExp(esc, 'gi')) ?? []).length };
      }
    } catch (e) {
      try {
        this.logger?.warn('进程检查失败', { procName, error: e instanceof Error ? e.message : String(e) });
      } catch {
        // logger 不可用忽略
      }
    }
    return { running: false, count: 0 };
  }

  /** 有窗口的进程数（Chromium 应用多子进程仅主进程有窗口） */
  private countWindowedProcesses(procName: string): number | null {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Name '${procName.replace(/\.exe$/i, '').replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      ).trim();
      return parseInt(out, 10) || 0;
    } catch {
      return null;
    }
  }

  /** 已在运行：UIA listRoots 找窗口 → Win32 激活 →（托盘恢复兜底）→ 登录检测 */
  private async activateExistingWindow(
    processName: string,
    windowTitle: string,
    log: string[],
    logAdd: (m: string) => void,
  ): Promise<LaunchAppResult> {
    logAdd('应用在运行，用 UIA + Win32 API 激活窗口（不会重新启动，不会多开）');
    try {
      const roots = (await this.uia?.listRoots({})) as { roots?: Array<{ title?: string; rootRef?: string; pid?: number }> } | undefined;
      const rootList = roots?.roots ?? [];
      logAdd(`listRoots 找到 ${rootList.length} 个窗口`);

      let target: { title?: string; rootRef?: string; pid?: number } | null = null;
      if (windowTitle) {
        // 精确匹配优先
        for (const r of rootList) {
          if (r.title && r.title === windowTitle) {
            target = r;
            break;
          }
        }
        // 模糊匹配（排除歧义："企业微信"不算"微信"）
        if (!target) {
          for (const r of rootList) {
            if (r.title && r.title.includes(windowTitle) && !titleBelongsToOtherApp(r.title, windowTitle)) {
              target = r;
              break;
            }
          }
        }
      }

      if (target?.rootRef) {
        logAdd(`找到窗口: "${target.title}" (${target.rootRef})`);
        // Win32 API 激活优先（UIA focusWindow 对 Chromium/Electron 应用会黑屏）
        const fgOk = target.pid ? this.manageWindow('foreground', { pid: target.pid }) : false;
        if (!fgOk) {
          try {
            await this.uia?.focusWindow(target.rootRef);
          } catch {
            // 忽略
          }
        }
        await this.sleep(500);

        // 最小化检测（framePoints x/y = -32000 表示最小化）
        try {
          const look = (await this.uia?.look({ rootRef: target.rootRef, includeImage: false })) as
            | { window?: { framePoints?: { x: number; y: number } } }
            | undefined;
          const frame = look?.window?.framePoints;
          if (frame && (frame.x < -1000 || frame.y < -1000)) {
            logAdd('窗口最小化，恢复中');
            this.manageWindow('restore', { pid: target.pid ?? 0, title: target.title ?? '' });
            await this.sleep(800);
            if (target.pid) this.manageWindow('foreground', { pid: target.pid });
            await this.sleep(500);
          }
        } catch {
          // 检测失败不阻断
        }

        // 激活校验：窗口必须属于目标应用（防"企业微信"冒充"微信"）
        if (target.title && titleBelongsToOtherApp(target.title, windowTitle)) {
          return {
            ok: false,
            alreadyRunning: true,
            windowTitle: target.title,
            log,
            error: `激活的窗口是"${target.title}"，不是目标应用"${windowTitle}"。目标应用可能未运行或未登录。已中止，绝对不要在该窗口内执行任何操作！请告知用户手动打开${windowTitle}并登录后再试。`,
            hint: `1.告知用户当前打开的是${target.title}而非${windowTitle}  2.请用户手动打开并登录${windowTitle}  3.绝对不要在${target.title}窗口里尝试发消息`,
          };
        }

        // 登录界面检测
        const login = await this.detectLogin(target.rootRef, logAdd, target.title);
        return {
          ok: true,
          activated: true,
          alreadyRunning: true,
          processName,
          ...login,
          log,
          ...(login.needsLogin
            ? {
                hint: '应用需要登录！请立即停止操作并告知用户手动登录（扫码或点击"进入微信"），不要尝试再次启动或操作',
              }
            : {}),
        };
      }

      // listRoots 无窗口但进程在运行 → 托盘隐藏，restorehidden 恢复
      logAdd('listRoots 未找到匹配窗口，疑似最小化到托盘，尝试恢复隐藏窗口');
      let restored = false;
      try {
        const out = this.manageWindow('restorehidden', { processName: processName.replace(/\.exe$/i, ''), title: windowTitle });
        restored = typeof out === 'string' ? out.includes('ok') : false;
      } catch {
        restored = false;
      }
      logAdd(`托盘恢复: ${restored ? 'ok' : 'failed'}`);
      if (restored) {
        await this.sleep(1500);
        // 恢复后重新找窗口
        const retry = (await this.uia?.listRoots({})) as { roots?: Array<{ title?: string; rootRef?: string; pid?: number }> } | undefined;
        for (const r of retry?.roots ?? []) {
          if (
            r.title &&
            (r.title === windowTitle || r.title.includes(windowTitle) || windowTitle.includes(r.title)) &&
            !titleBelongsToOtherApp(r.title, windowTitle)
          ) {
            logAdd(`恢复后找到窗口: "${r.title}"`);
            if (r.pid) this.manageWindow('foreground', { pid: r.pid });
            await this.sleep(500);
            const login = await this.detectLogin(r.rootRef ?? '', logAdd);
            return {
              ok: true,
              activated: true,
              alreadyRunning: true,
              restoredFromTray: true,
              processName,
              windowTitle: r.title,
              ...login,
              log,
              ...(login.needsLogin
                ? {
                    hint: '应用需要登录！请立即停止操作并告知用户手动登录（扫码或点击"进入微信"），不要尝试再次启动或操作',
                  }
                : {}),
            };
          }
        }
      }
      return {
        ok: false,
        alreadyRunning: true,
        processName,
        log,
        error: '应用进程在运行但找不到窗口。已尝试托盘恢复仍失败，请用户手动点击托盘图标打开窗口。绝对不要再次启动应用（会导致多开）',
        hint: '1.告知用户应用已在运行但窗口无法自动恢复  2.请用户手动点击系统托盘图标  3.绝对不要再次启动应用',
      };
    } catch (e) {
      return {
        ok: false,
        alreadyRunning: true,
        log,
        error: `UIA 激活失败: ${e instanceof Error ? e.message : String(e)}。应用在运行，不要重新启动`,
      };
    }
  }

  /** 启动后组装结果 + 登录检测 */
  private async afterLaunchResult(
    method: string,
    processName: string,
    shortcut: string | undefined,
    nowRunning: boolean,
    log: string[],
    logAdd: (m: string) => void,
  ): Promise<LaunchAppResult> {
    const login = await this.detectLoginAfterLaunch(logAdd);
    return {
      ok: true,
      launched: true,
      method,
      processName,
      nowRunning,
      ...(shortcut ? { shortcut } : {}),
      ...login,
      log,
      ...(login.needsLogin
        ? {
            hint: '应用需要登录！请立即停止操作并告知用户手动登录（扫码或点击"进入微信"），绝对不要再次启动或操作应用（会导致多开）',
          }
        : {}),
    };
  }

  /** 启动后登录检测：等窗口出现 → listRoots 找目标 → look 检查登录关键词 */
  private async detectLoginAfterLaunch(logAdd: (m: string) => void): Promise<{
    needsLogin: boolean;
    loginType?: 'qr_code' | 'login' | 'wechat_account_login';
    windowTitle?: string;
  }> {
    try {
      await this.sleep(1500);
      const roots = (await this.uia?.listRoots({})) as { roots?: Array<{ title?: string; rootRef?: string }> } | undefined;
      const list = roots?.roots ?? [];
      logAdd(`启动后检测: listRoots 找到 ${list.length} 个窗口`);
      // 取第一个非桌面窗口（启动后新窗口标题可能为空）
      const target = list.find(
        (r) =>
          r.title &&
          r.title.toLowerCase() !== 'desktop' &&
          r.title !== '桌面' &&
          r.title !== 'Program Manager' &&
          !r.title.includes('MSCTFIME'),
      );
      if (!target?.rootRef) return { needsLogin: false };
      logAdd(`启动后检测: 找到窗口 "${target.title}"`);
      try {
        await this.uia?.focusWindow(target.rootRef);
      } catch {
        // 忽略
      }
      await this.sleep(800);
      return await this.detectLogin(target.rootRef, logAdd, target.title);
    } catch (e) {
      logAdd(`启动后登录检测失败: ${e instanceof Error ? e.message : String(e)}`);
      return { needsLogin: false };
    }
  }

  /** 对指定窗口 look 检查登录界面关键词 */
  private async detectLogin(
    rootRef: string,
    logAdd: (m: string) => void,
    windowTitle?: string,
  ): Promise<{
    needsLogin: boolean;
    loginType?: 'qr_code' | 'login' | 'wechat_account_login';
    windowTitle?: string;
  }> {
    const titlePart = windowTitle ? { windowTitle } : {};
    try {
      const look = (await this.uia?.look({ rootRef, includeImage: false })) as unknown;
      const s = JSON.stringify(look ?? '').toLowerCase();
      if (s.includes('二维码') || s.includes('qr') || s.includes('scan') || s.includes('qrcode')) {
        logAdd('检测到登录界面(qr_code)');
        return { needsLogin: true, loginType: 'qr_code', ...titlePart };
      }
      if (isLoginUIText(s)) {
        const loginType: 'wechat_account_login' | 'login' =
          s.includes('进入微信') || s.includes('切换账号') || s.includes('仅传输文件')
            ? 'wechat_account_login'
            : 'login';
        logAdd(`检测到登录界面(${loginType})`);
        return { needsLogin: true, loginType, ...titlePart };
      }
      logAdd('未检测到登录界面');
      return { needsLogin: false, ...titlePart };
    } catch {
      return { needsLogin: false, ...titlePart };
    }
  }

  /** Windows 搜索启动：Win 键 + 应用名 + Enter（键击由 SkyInput 完成，走 DesktopService） */
  private async winSearchLaunch(appName: string, logAdd: (m: string) => void): Promise<boolean> {
    // 键击序列依赖 SkyInput.cs——此处通过 PowerShell SendKeys 简化实现，
    // 保持与旧版 keybd_event 等价的用户可见行为（Win 搜索框弹出→输入→回车）
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^{ESC}'); Start-Sleep -Milliseconds 800; $w.SendKeys('${appName.replace(/'/g, "''")}'); Start-Sleep -Milliseconds 1500; $w.SendKeys('{ENTER}')`,
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true },
      );
      logAdd('Win 搜索键击序列完成');
      return true;
    } catch (e) {
      logAdd(`Windows 搜索失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** start "" "<path>" 启动（快捷方式/exe 通用） */
  private shellStart(path: string): void {
    execFile('cmd.exe', ['/c', 'start', '', path], () => undefined);
  }

  /** 调 manage-window.ps1（WinMgmt.cs 前置依赖已在该脚本内加载） */
  private manageWindow(
    action: 'rect' | 'maximize' | 'restore' | 'foreground' | 'restorehidden',
    opts: { pid?: number; title?: string; processName?: string },
  ): string | null {
    const script = this.resolveManageWindowScript();
    if (!script) return null;
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
      if (opts.pid) args.push('-TargetPid', String(opts.pid));
      if (opts.title) args.push('-Title', opts.title);
      if (opts.processName) args.push('-ProcessName', opts.processName);
      return execFileSync('powershell.exe', args, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      }).trim();
    } catch {
      return null;
    }
  }

  /** manage-window.ps1 路径解析（与 uia.service resolveBridgePath 同一套布局约定） */
  private resolveManageWindowScript(): string | null {
    if (this.manageWindowScriptPath !== undefined) return this.manageWindowScriptPath;
    if (!IS_WIN) {
      this.manageWindowScriptPath = null;
      return null;
    }
    const candidates = [
      join(__dirname, '..', '..', '..', '..', 'web', 'manage-window.ps1'),
      join(__dirname, '..', '..', '..', '..', '..', 'web', 'manage-window.ps1'),
      join(process.cwd(), 'packages', 'web', 'manage-window.ps1'),
      join(process.cwd(), '..', 'web', 'manage-window.ps1'),
      join(process.cwd(), 'web', 'manage-window.ps1'),
      join(process.cwd(), 'manage-window.ps1'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        this.manageWindowScriptPath = p;
        return p;
      }
    }
    this.manageWindowScriptPath = null;
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/** 登录界面关键词（含微信 4.x 无"登录"二字的"进入微信/切换账号/仅传输文件"） */
function isLoginUIText(s: string): boolean {
  if (!s) return false;
  return (
    s.includes('二维码') ||
    s.includes('扫码') ||
    s.includes('登录') ||
    s.includes('login') ||
    s.includes('log in') ||
    s.includes('进入微信') ||
    s.includes('切换账号') ||
    s.includes('仅传输文件')
  );
}

/** 快捷方式候选排除：baseName 中 appName 之外的部分含排除词则排除 */
function shouldExcludeCandidate(baseName: string, appName: string): boolean {
  if (baseName === appName) return false;
  const remaining = baseName.toLowerCase().replace(appName.toLowerCase(), '');
  return EXCLUDE_KEYWORDS.some((kw) => remaining.includes(kw));
}

/** 标题歧义排除：title 属于"其他应用组"而非目标应用 */
function titleBelongsToOtherApp(title: string, targetApp: string): boolean {
  if (!title || !targetApp) return false;
  for (const group of APP_TITLE_GROUPS) {
    if (group.apps.some((a) => a.toLowerCase() === targetApp.toLowerCase())) {
      // 目标在本组 → 组内其他应用名出现即歧义
      return group.names.some((n) => title.includes(n));
    }
  }
  return false;
}
