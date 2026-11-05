/**
 * Linux 桌面自动化模块 (1.4.0+)
 *
 * 技术栈：
 *   - xdotool: 窗口管理 + 输入注入（X11）
 *   - ydotool: Wayland 输入注入回退（需 ydotoold 服务）
 *   - scrot / import(ImageMagick): 截图
 *   - tesseract: OCR（中文需 tesseract-ocr-chi-sim）
 *   - xclip / xsel: 剪贴板
 *   - pgrep / ps: 进程检测
 *   - wmctrl: 窗口管理（替代/补充 xdotool）
 *
 * X11 vs Wayland:
 *   - X11: xdotool 全功能可用（窗口激活、输入注入、截图等）
 *   - Wayland: 安全模型限制全局输入注入；ydotool 可绕过（需 root + ydotoold）
 *     截图需 gnome-screenshot 或 grim，窗口枚举受限
 *
 * 前置条件（用户安装）：
 *   sudo apt install xdotool scrot tesseract-ocr tesseract-ocr-chi-sim xclip wmctrl
 *   # 或 Fedora/RHEL:
 *   sudo dnf install xdotool scrot tesseract tesseract-langpack-chi_sim xclip wmctrl
 *   # Wayland 回退（可选）:
 *   sudo apt install ydotool   # 然后启用 ydotoold 服务
 *
 * 接口兼容 Windows uia_launch_app / uia_send_message，AI 无需感知平台差异。
 */

"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { execSync, execFileSync, spawnSync } = require("child_process");

module.exports._notTools = true;

// ═══════════════════════════════════════════════════
// 应用名 / 进程名映射
// ═══════════════════════════════════════════════════

var LINUX_APP_MAP = {
  微信: "wechat",
  WeChat: "wechat",
  Weixin: "wechat",
  xwechat: "wechat",
  QQ: "qq",
  企业微信: "wxwork",
  WeCom: "wxwork",
  WXWork: "wxwork",
  钉钉: "dingtalk",
  DingTalk: "dingtalk",
  飞书: "feishu",
  Lark: "feishu",
  Feishu: "feishu",
  Telegram: "telegram-desktop",
  Chrome: "google-chrome",
  谷歌浏览器: "google-chrome",
  Firefox: "firefox",
};

var LINUX_PROCESS_MAP = {
  wechat: ["wechat", "WeChat", "weixin"],
  qq: ["qq", "linuxqq"],
  wxwork: ["wxwork", "WeCom"],
  dingtalk: ["dingtalk", "DingTalk"],
  feishu: ["feishu", "lark", "Lark"],
  "telegram-desktop": ["telegram-desktop", "Telegram"],
  "google-chrome": ["chrome", "google-chrome"],
  firefox: ["firefox"],
};

var LINUX_LOGIN_KEYWORDS = [
  "二维码",
  "扫码",
  "登录",
  "Log in",
  "Sign in",
  "进入微信",
  "切换账号",
  "仅传输文件",
];

// ═══════════════════════════════════════════════════
// 会话类型检测（X11 / Wayland）
// ═══════════════════════════════════════════════════

var _sessionType = null;

/**
 * 获取当前桌面会话类型
 * @returns {"x11"|"wayland"|"unknown"}
 */
function getSessionType() {
  if (_sessionType !== null) return _sessionType;
  try {
    var st = execSync('echo "$XDG_SESSION_TYPE"', {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (st === "x11" || st === "wayland") {
      _sessionType = st;
    } else {
      // 回退：检查 WAYLAND_DISPLAY 环境变量
      _sessionType = process.env.WAYLAND_DISPLAY ? "wayland" : "x11";
    }
  } catch (e) {
    _sessionType = "unknown";
  }
  return _sessionType;
}

/**
 * 检查命令是否存在
 */
function commandExists(cmd) {
  try {
    execSync('which ' + cmd + ' 2>/dev/null', {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 检查工具依赖
 */
function checkDependencies() {
  var deps = {
    xdotool: commandExists("xdotool"),
    scrot: commandExists("scrot"),
    import: commandExists("import"), // ImageMagick
    tesseract: commandExists("tesseract"),
    xclip: commandExists("xclip"),
    xsel: commandExists("xsel"),
    wmctrl: commandExists("wmctrl"),
    ydotool: commandExists("ydotool"), // Wayland 回退
    gnomeScreenshot: commandExists("gnome-screenshot"),
    grim: commandExists("grim"), // Wayland 截图
  };
  deps.screenshot = deps.scrot || deps.import || deps.gnomeScreenshot || deps.grim;
  deps.clipboard = deps.xclip || deps.xsel;
  deps.sessionType = getSessionType();
  return deps;
}

// ═══════════════════════════════════════════════════
// 核心函数
// ═══════════════════════════════════════════════════

/**
 * 检查进程是否运行
 */
function isProcessRunning(processNames) {
  if (!Array.isArray(processNames)) processNames = [processNames];
  for (var i = 0; i < processNames.length; i++) {
    try {
      var out = execFileSync('pgrep', ['-f', processNames[i]], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (out.trim().length > 0) return true;
    } catch (e) {}
  }
  return false;
}

/**
 * 获取运行中进程列表
 */
function getRunningApps() {
  try {
    return execSync("ps aux", { encoding: "utf8", timeout: 5000 });
  } catch (e) {
    return "";
  }
}

/**
 * 截图
 * X11: scrot 或 import
 * Wayland: grim 或 gnome-screenshot
 */
function screenshot(savePath) {
  var session = getSessionType();

  // Wayland: 优先 grim，回退 gnome-screenshot
  if (session === "wayland") {
    if (commandExists("grim")) {
      try {
        // 改用 execFileSync + 数组参数，避免 shell 注入
        execFileSync('grim', [savePath], { encoding: "utf8", timeout: 10000 });
        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 100) {
          return { ok: true, path: savePath };
        }
      } catch (e) {}
    }
    if (commandExists("gnome-screenshot")) {
      try {
        execFileSync('gnome-screenshot', ['-f', savePath], {
          encoding: "utf8",
          timeout: 10000,
        });
        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 100) {
          return { ok: true, path: savePath };
        }
      } catch (e) {}
    }
  }

  // X11: 优先 scrot，回退 import(ImageMagick)
  if (commandExists("scrot")) {
    try {
      execFileSync('scrot', [savePath], { encoding: "utf8", timeout: 10000 });
      if (fs.existsSync(savePath) && fs.statSync(savePath).size > 100) {
        return { ok: true, path: savePath };
      }
    } catch (e) {}
  }

  if (commandExists("import")) {
    try {
      execFileSync('import', ['-window', 'root', savePath], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (fs.existsSync(savePath) && fs.statSync(savePath).size > 100) {
        return { ok: true, path: savePath };
      }
    } catch (e) {}
  }

  return { ok: false, error: "截图失败：未找到可用的截图工具（scrot/import/grim/gnome-screenshot）" };
}

/**
 * OCR 文字识别（tesseract）
 */
function ocr(imagePath) {
  try {
    var out = execSync(
      'tesseract "' + imagePath + '" stdout -l chi_sim+eng 2>/dev/null',
      { encoding: "utf8", timeout: 30000 }
    );
    return { ok: true, engine: "tesseract", results: [], text: out.trim() };
  } catch (e) {
    return { ok: false, error: "OCR 失败：tesseract 未安装或执行失败。" };
  }
}

/**
 * 设置剪贴板
 */
function setClipboard(text) {
  if (commandExists("xclip")) {
    try {
      var proc = require("child_process").spawn("xclip", ["-selection", "clipboard"]);
      proc.stdin.write(text);
      proc.stdin.end();
      return true;
    } catch (e) {}
  }
  if (commandExists("xsel")) {
    try {
      var proc2 = require("child_process").spawn("xsel", ["--clipboard", "--input"]);
      proc2.stdin.write(text);
      proc2.stdin.end();
      return true;
    } catch (e) {}
  }
  // Wayland: wl-copy
  if (commandExists("wl-copy")) {
    try {
      var proc3 = require("child_process").spawn("wl-copy");
      proc3.stdin.write(text);
      proc3.stdin.end();
      return true;
    } catch (e) {}
  }
  return false;
}

/**
 * 获取剪贴板
 */
function getClipboard() {
  if (commandExists("xclip")) {
    try {
      return execSync("xclip -selection clipboard -o", {
        encoding: "utf8",
        timeout: 5000,
      });
    } catch (e) {}
  }
  if (commandExists("xsel")) {
    try {
      return execSync("xsel --clipboard --output", {
        encoding: "utf8",
        timeout: 5000,
      });
    } catch (e) {}
  }
  if (commandExists("wl-paste")) {
    try {
      return execSync("wl-paste", { encoding: "utf8", timeout: 5000 });
    } catch (e) {}
  }
  return "";
}

/**
 * 输入文字
 * X11: xdotool type（支持 Unicode，但中文可能需要剪贴板粘贴）
 * Wayland: ydotool 或 wtype，回退到剪贴板粘贴
 */
function typeText(text) {
  if (!text) return false;
  var session = getSessionType();

  // X11: xdotool type
  if (session === "x11" && commandExists("xdotool")) {
    // 中文用剪贴板粘贴更可靠（xdotool type 对中文 IME 支持不稳定）
    setClipboard(text);
    return pressKey("ctrl+v");
  }

  // Wayland: wtype（原生 Wayland 输入工具）
  if (session === "wayland" && commandExists("wtype")) {
    try {
      // C-B3: 改用 execFileSync + 数组参数，避免 shell 注入
      execFileSync('wtype', [text], {
        encoding: "utf8",
        timeout: 5000,
      });
      return true;
    } catch (e) {}
  }

  // Wayland 回退: ydotool type
  if (session === "wayland" && commandExists("ydotool")) {
    try {
      execFileSync('ydotool', ['type', text], {
        encoding: "utf8",
        timeout: 5000,
      });
      return true;
    } catch (e) {}
  }

  // 通用回退：剪贴板 + 粘贴
  setClipboard(text);
  return pressKey("ctrl+v");
}

/**
 * 按键
 * X11: xdotool key
 * Wayland: ydotool key / wtype -k
 *
 * key 格式: "Return", "Tab", "Escape", "ctrl+v", "shift+Return", "alt+F4" 等
 */
function pressKey(key) {
  var session = getSessionType();

  // 标准化 key 格式：xdotool 使用小写修饰键名
  var xdotoolKey = key.replace(/ctrl/gi, "ctrl").replace(/shift/gi, "shift")
    .replace(/alt/gi, "alt").replace(/cmd/gi, "ctrl").replace(/meta/gi, "super");

  // X11: xdotool key
  if (session === "x11" && commandExists("xdotool")) {
    try {
      execFileSync('xdotool', ['key', xdotoolKey], { encoding: "utf8", timeout: 5000 });
      return true;
    } catch (e) {}
  }

  // Wayland: wtype -k
  if (session === "wayland" && commandExists("wtype")) {
    try {
      // wtype -k 使用 evdev 键码，这里做简单映射
      var keyMap = {
        Return: "28", Enter: "28", Tab: "15", Space: "57",
        Escape: "1", Esc: "1", BackSpace: "14", Delete: "111",
        Left: "105", Right: "106", Down: "108", Up: "103",
      };
      var parts = xdotoolKey.split("+");
      var mainKey = parts[parts.length - 1];
      var keyCode = keyMap[mainKey] || mainKey;
      // C-B3: 改用 execFileSync + 数组参数，避免 shell 注入
      var wtypeArgs = ['-k', keyCode];
      // 修饰键简化处理
      for (var i = 0; i < parts.length - 1; i++) {
        if (parts[i] === "ctrl") wtypeArgs = ['-M', 'leftctrl', '-k', keyCode];
        if (parts[i] === "shift") wtypeArgs = ['-M', 'leftshift', '-k', keyCode];
        if (parts[i] === "alt") wtypeArgs = ['-M', 'leftalt', '-k', keyCode];
      }
      execFileSync('wtype', wtypeArgs, { encoding: "utf8", timeout: 5000 });
      return true;
    } catch (e) {}
  }

  // Wayland 回退: ydotool key
  if (session === "wayland" && commandExists("ydotool")) {
    try {
      // ydotool key 使用 evdev 键码
      var keyMap2 = {
        Return: "28", Enter: "28", Tab: "15", Space: "57",
        Escape: "1", Esc: "1", BackSpace: "14", Delete: "111",
        Left: "105", Right: "106", Down: "108", Up: "103",
      };
      var parts2 = xdotoolKey.split("+");
      var mainKey2 = parts2[parts2.length - 1];
      var keyCode2 = keyMap2[mainKey2] || mainKey2;
      execFileSync('ydotool', ['key', keyCode2 + ':1', keyCode2 + ':0'], {
        encoding: "utf8",
        timeout: 5000,
      });
      return true;
    } catch (e) {}
  }

  return false;
}

/**
 * 点击坐标
 * X11: xdotool click/mousemove
 * Wayland: ydotool click/mousemove
 */
function clickAt(x, y) {
  var session = getSessionType();
  // C-B3: 对坐标做数字校验，防止命令注入
  var nx = parseInt(x, 10);
  var ny = parseInt(y, 10);
  if (!isFinite(nx) || !isFinite(ny)) return false;
  var sx = String(nx);
  var sy = String(ny);

  // X11: xdotool
  if (session === "x11" && commandExists("xdotool")) {
    try {
      execFileSync('xdotool', ['mousemove', sx, sy, 'click', '1'], {
        encoding: "utf8",
        timeout: 5000,
      });
      return true;
    } catch (e) {}
  }

  // Wayland: ydotool
  if (session === "wayland" && commandExists("ydotool")) {
    try {
      execFileSync('ydotool', ['mousemove', '--absolute', sx, sy], {
        encoding: "utf8",
        timeout: 5000,
      });
      execFileSync('ydotool', ['click', '0xC0'], { encoding: "utf8", timeout: 5000 });
      return true;
    } catch (e) {}
  }

  // 通用回退: xdotool（某些 Wayland 兼容层也支持）
  if (commandExists("xdotool")) {
    try {
      execFileSync('xdotool', ['mousemove', sx, sy, 'click', '1'], {
        encoding: "utf8",
        timeout: 5000,
      });
      return true;
    } catch (e) {}
  }

  return false;
}

/**
 * 激活应用窗口
 */
function activateApp(appName) {
  var session = getSessionType();

  // X11: wmctrl -a（按标题激活）
  if (commandExists("wmctrl")) {
    try {
      // C-B3: 改用 execFileSync + 数组参数，避免 shell 注入
      execFileSync('wmctrl', ['-a', appName], { encoding: "utf8", timeout: 5000 });
      return true;
    } catch (e) {}
  }

  // X11: xdotool search + windowactivate
  if (session === "x11" && commandExists("xdotool")) {
    try {
      execFileSync('xdotool', ['search', '--name', appName, 'windowactivate'], {
        encoding: "utf8",
        timeout: 5000,
      });
      return true;
    } catch (e) {}
  }

  return false;
}

/**
 * 启动应用
 */
function launchAppByName(appName) {
  // C-B3: 对 appName 做白名单校验，防止命令注入
  if (!appName || !/^[A-Za-z0-9_\-\.\/\s]+$/.test(appName)) return false;
  var spawn = require('child_process').spawn;
  try {
    var parts = appName.trim().split(/\s+/);
    var cmd = parts[0];
    var args = parts.slice(1);
    var child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) {
    // 尝试 xdg-open（对于 .desktop 文件）
    try {
      execFileSync('xdg-open', [appName], { encoding: "utf8", timeout: 5000 });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * 获取前台窗口标题
 */
function getActiveWindowTitle() {
  var session = getSessionType();

  // X11: xdotool getactivewindow getwindowname
  if (session === "x11" && commandExists("xdotool")) {
    try {
      return execSync("xdotool getactivewindow getwindowname", {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch (e) {}
  }

  // wmctrl 回退
  if (commandExists("wmctrl")) {
    try {
      var out = execSync("wmctrl -l", { encoding: "utf8", timeout: 5000 });
      var lines = out.trim().split("\n");
      // wmctrl -l 输出中带 "*" 的是活跃窗口
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("*") >= 0) {
          var parts = lines[i].split(/\s+/);
          return parts.slice(3).join(" ");
        }
      }
    } catch (e) {}
  }

  return "";
}

/**
 * 枚举所有窗口
 */
function listWindows() {
  if (commandExists("wmctrl")) {
    try {
      var out = execSync("wmctrl -l", { encoding: "utf8", timeout: 5000 });
      var lines = out.trim().split("\n");
      var wins = [];
      for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].split(/\s+/);
        if (parts.length >= 4) {
          wins.push({
            id: parts[0],
            owner: parts[2],
            title: parts.slice(3).join(" "),
          });
        }
      }
      return wins;
    } catch (e) {}
  }

  if (commandExists("xdotool")) {
    try {
      var out2 = execSync("xdotool search --name '' getwindowname", {
        encoding: "utf8",
        timeout: 5000,
      });
      return out2
        .trim()
        .split("\n")
        .map(function (t) {
          return { owner: "", title: t.trim(), id: 0 };
        });
    } catch (e) {}
  }

  return [];
}

// ═══════════════════════════════════════════════════
// 高级功能：launchApp / sendMessage
// ═══════════════════════════════════════════════════

function resolveAppName(inputName) {
  if (!inputName) return null;
  if (LINUX_APP_MAP[inputName]) return LINUX_APP_MAP[inputName];
  var inputLower = inputName.toLowerCase();
  for (var key in LINUX_APP_MAP) {
    if (key.toLowerCase() === inputLower || LINUX_APP_MAP[key].toLowerCase() === inputLower) {
      return LINUX_APP_MAP[key];
    }
  }
  return inputName;
}

function getProcessNames(appName) {
  if (LINUX_PROCESS_MAP[appName]) return LINUX_PROCESS_MAP[appName];
  return [appName];
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * launchApp — 启动/激活桌面应用
 */
async function launchApp(args, ctx) {
  var ctxFs = ctx.fs || fs;
  var ctxPath = ctx.path || path;
  var broadcast = ctx.broadcast || function () {};
  var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;

  var appNameInput = args.appName || args.name || "";
  if (!appNameInput) {
    return { ok: false, error: "必须提供 appName 参数（应用名称）" };
  }

  var linuxAppName = resolveAppName(appNameInput);
  var processNames = args.processName ? [args.processName] : getProcessNames(linuxAppName);
  var waitMs = parseInt(args.waitMs) || 5000;

  var logs = [];
  var shots = [];
  var t0 = Date.now();

  function logAdd(msg) {
    logs.push("[+" + ((Date.now() - t0) / 1000).toFixed(1) + "s] " + msg);
  }
  function progress(msg) {
    logAdd(msg);
    try {
      broadcast({ type: "system_notification", message: "🚀 " + msg, level: "info" });
    } catch (e) {}
  }
  function takeShot(stepLabel) {
    try {
      var sp = getWorkspaceOutputPath
        ? getWorkspaceOutputPath("linux-launch-" + stepLabel + "-" + Date.now() + ".png")
        : path.join(os.tmpdir(), "linux-launch-" + stepLabel + "-" + Date.now() + ".png");
      var sr = screenshot(sp);
      if (sr.ok) {
        shots.push({ step: stepLabel, path: sr.path });
        logAdd("截图[" + stepLabel + "]: " + sr.path);
        return sr.path;
      }
    } catch (e) {
      logAdd("截图[" + stepLabel + "]异常: " + e.message);
    }
    return null;
  }
  function attachShots(ret, finalPath) {
    ret.screenshots = shots;
    var p = finalPath || (shots.length ? shots[shots.length - 1].path : null);
    if (p) {
      try {
        var buf = ctxFs.readFileSync(p);
        if (buf.length <= 2 * 1024 * 1024) {
          ret._inlineImage = "data:image/png;base64," + buf.toString("base64");
        }
      } catch (e) {}
    }
    return ret;
  }

  try {
    // 依赖检查
    var deps = checkDependencies();
    logAdd("会话类型: " + deps.sessionType);
    logAdd("依赖: xdotool=" + deps.xdotool + " scrot=" + deps.scrot + " tesseract=" + deps.tesseract + " xclip=" + deps.xclip);

    if (!deps.screenshot) {
      return attachShots({
        ok: false,
        error: "缺少截图工具，请安装: sudo apt install scrot",
        logs: logs,
      });
    }

    // Step 0: 初始截图
    progress("Step 0: 初始截图");
    takeShot("step0-init");

    // Step 1: 进程检测
    progress("Step 1: 检测 " + linuxAppName + " 进程 (" + processNames.join("/") + ")");
    var running = isProcessRunning(processNames);
    logAdd("进程检测结果: " + (running ? "运行中" : "未运行"));

    if (running) {
      // Step 2: 已运行 → 激活窗口
      progress("Step 2: " + linuxAppName + " 已运行，激活窗口");
      activateApp(linuxAppName);
      await sleep(1500);
      takeShot("step2-activated");

      var winTitle = getActiveWindowTitle();
      logAdd("当前窗口: " + winTitle);

      // 登录界面检测
      var needsLogin = false;
      if (winTitle) {
        for (var li = 0; li < LINUX_LOGIN_KEYWORDS.length; li++) {
          if (winTitle.indexOf(LINUX_LOGIN_KEYWORDS[li]) >= 0) {
            needsLogin = true;
            break;
          }
        }
      }

      if (needsLogin) {
        progress("⚠️ 检测到登录界面");
        return attachShots({
          ok: false,
          needsLogin: true,
          alreadyRunning: true,
          error: linuxAppName + " 需要登录。请用户手动登录后重试",
          logs: logs,
        });
      }

      return attachShots({
        ok: true,
        alreadyRunning: true,
        needsLogin: false,
        windowTitle: winTitle,
        logs: logs,
      });
    }

    // Step 3: 未运行 → 启动
    progress("Step 3: " + linuxAppName + " 未运行，启动中...");
    var launched = launchAppByName(linuxAppName);
    if (!launched) {
      return attachShots({
        ok: false,
        error: "无法启动 " + linuxAppName + "，请检查应用是否已安装",
        logs: logs,
      });
    }

    // Step 4: 等待窗口
    progress("Step 4: 等待 " + linuxAppName + " 窗口出现...");
    var waitDeadline = Date.now() + waitMs;
    var windowFound = false;
    while (Date.now() < waitDeadline) {
      await sleep(1000);
      if (isProcessRunning(processNames)) {
        windowFound = true;
        break;
      }
    }

    if (!windowFound) {
      takeShot("step4-timeout");
      return attachShots({
        ok: false,
        error: "启动 " + linuxAppName + " 超时",
        logs: logs,
      });
    }

    activateApp(linuxAppName);
    await sleep(1500);
    takeShot("step4-activated");

    // Step 5: 登录检测
    progress("Step 5: 检测登录界面");
    var winTitle2 = getActiveWindowTitle();
    logAdd("窗口标题: " + winTitle2);

    var needsLogin2 = false;
    if (winTitle2) {
      for (var li2 = 0; li2 < LINUX_LOGIN_KEYWORDS.length; li2++) {
        if (winTitle2.indexOf(LINUX_LOGIN_KEYWORDS[li2]) >= 0) {
          needsLogin2 = true;
          break;
        }
      }
    }

    // OCR 兜底
    if (!needsLogin2 && shots.length > 0) {
      var lastShot = shots[shots.length - 1].path;
      var ocrResult = ocr(lastShot);
      if (ocrResult.ok && ocrResult.text) {
        for (var li3 = 0; li3 < LINUX_LOGIN_KEYWORDS.length; li3++) {
          if (ocrResult.text.indexOf(LINUX_LOGIN_KEYWORDS[li3]) >= 0) {
            needsLogin2 = true;
            break;
          }
        }
      }
    }

    if (needsLogin2) {
      progress("⚠️ 检测到登录界面");
      return attachShots({
        ok: false,
        needsLogin: true,
        alreadyRunning: false,
        error: linuxAppName + " 需要登录。请用户手动登录后重试",
        logs: logs,
      });
    }

    progress("✅ " + linuxAppName + " 启动成功");
    return attachShots({
      ok: true,
      alreadyRunning: false,
      needsLogin: false,
      windowTitle: winTitle2,
      logs: logs,
    });
  } catch (e) {
    logAdd("异常: " + e.message);
    return attachShots({ ok: false, error: "启动应用异常: " + e.message, logs: logs });
  }
}

/**
 * sendMessage — 通过桌面应用发送消息
 */
async function sendMessage(args, ctx) {
  var ctxFs = ctx.fs || fs;
  var ctxPath = ctx.path || path;
  var broadcast = ctx.broadcast || function () {};
  var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;

  var appNameInput = args.appName || "QQ";
  var contactName = args.contactName || "";
  var message = args.messageText || args.message || "";

  if (!contactName) return { ok: false, error: "必须提供 contactName 参数" };
  if (!message) return { ok: false, error: "必须提供 message 或 messageText 参数" };

  var linuxAppName = resolveAppName(appNameInput);
  var processNames = getProcessNames(linuxAppName);

  var logs = [];
  var shots = [];
  var t0 = Date.now();
  var watchdog = null;

  function logAdd(msg) {
    logs.push("[+" + ((Date.now() - t0) / 1000).toFixed(1) + "s] " + msg);
  }
  function progress(msg) {
    logAdd(msg);
    try {
      broadcast({ type: "system_notification", message: "📨 " + msg, level: "info" });
    } catch (e) {}
  }
  function takeShot(stepLabel) {
    try {
      var sp = getWorkspaceOutputPath
        ? getWorkspaceOutputPath("linux-send-" + stepLabel + "-" + Date.now() + ".png")
        : path.join(os.tmpdir(), "linux-send-" + stepLabel + "-" + Date.now() + ".png");
      var sr = screenshot(sp);
      if (sr.ok) {
        shots.push({ step: stepLabel, path: sr.path });
        logAdd("截图[" + stepLabel + "]: " + sr.path);
        return sr.path;
      }
    } catch (e) {
      logAdd("截图[" + stepLabel + "]异常: " + e.message);
    }
    return null;
  }
  function attachShots(ret, finalPath) {
    watchdog = null;
    ret.screenshots = shots;
    var p = finalPath || (shots.length ? shots[shots.length - 1].path : null);
    if (p) {
      try {
        var buf = ctxFs.readFileSync(p);
        if (buf.length <= 2 * 1024 * 1024) {
          ret._inlineImage = "data:image/png;base64," + buf.toString("base64");
        }
      } catch (e) {}
    }
    return ret;
  }
  function checkTimeout() {
    if (watchdog === null) return;
    if (Date.now() - t0 > 240000) {
      throw new Error("操作总超时(240s)已中止");
    }
  }

  try {
    watchdog = true;

    // Step 1: 启动/激活应用
    progress("Step 1: 启动/激活 " + linuxAppName);
    var launchResult = await launchApp(
      { appName: appNameInput, processName: args.processName, waitMs: args.waitMs || 8000 },
      ctx
    );
    logAdd("launchApp 结果: ok=" + launchResult.ok);

    if (!launchResult.ok) {
      if (launchResult.needsLogin) {
        return attachShots({
          ok: false,
          needsLogin: true,
          error: launchResult.error,
          logs: logs.concat(launchResult.logs || []),
        });
      }
      return attachShots({
        ok: false,
        error: "启动应用失败: " + (launchResult.error || "未知错误"),
        logs: logs.concat(launchResult.logs || []),
      });
    }

    takeShot("step1-app-ready");
    checkTimeout();

    // Step 2: 搜索联系人（Ctrl+F）
    progress("Step 2: 搜索联系人「" + contactName + "」");
    pressKey("ctrl+f");
    await sleep(800);
    takeShot("step2-search-focused");
    checkTimeout();

    // 输入联系人名（剪贴板粘贴更可靠）
    progress("  输入联系人名字");
    typeText(contactName);
    await sleep(1500);
    takeShot("step2-search-results");
    checkTimeout();

    // Enter 选择
    progress("  按 Enter 选择搜索结果");
    pressKey("Return");
    await sleep(1500);
    takeShot("step2-chat-opened");
    checkTimeout();

    // Step 3: 验证聊天页
    progress("Step 3: 验证聊天页");
    var chatVerified = false;
    var winTitle = getActiveWindowTitle();
    logAdd("窗口标题: " + winTitle);

    if (winTitle && winTitle.indexOf(contactName) >= 0) {
      chatVerified = true;
      logAdd("✅ 窗口标题包含联系人名");
    }

    if (!chatVerified && shots.length > 0) {
      var lastShot = shots[shots.length - 1].path;
      var ocrResult = ocr(lastShot);
      if (ocrResult.ok && ocrResult.text) {
        logAdd("OCR: " + ocrResult.text.substring(0, 200));
        if (ocrResult.text.indexOf(contactName) >= 0) {
          chatVerified = true;
          logAdd("✅ OCR 包含联系人名");
        }
        if (!chatVerified && contactName.length > 0) {
          var firstChar = contactName.charAt(0);
          if (ocrResult.text.indexOf(firstChar) >= 0) {
            chatVerified = true;
            logAdd("✅ OCR 包含首字");
          }
        }
      }
    }

    checkTimeout();

    // Step 4: 输入消息
    progress("Step 4: 输入消息");
    typeText(message);
    await sleep(500);
    takeShot("step4-message-typed");
    checkTimeout();

    // Step 5: 发送
    progress("Step 5: 按 Enter 发送");
    pressKey("Return");
    await sleep(1000);
    takeShot("step5-sent");
    checkTimeout();

    // Step 6: 验证
    progress("Step 6: 验证发送结果");
    var finalWinTitle = getActiveWindowTitle();
    logAdd("最终窗口: " + finalWinTitle);

    progress("✅ 消息发送完成");
    return attachShots({
      ok: true,
      sent: true,
      contact: contactName,
      messageLength: message.length,
      windowTitle: finalWinTitle,
      chatVerified: chatVerified,
      logs: logs,
    });
  } catch (e) {
    logAdd("异常: " + e.message);
    return attachShots({ ok: false, error: "发送消息异常: " + e.message, logs: logs });
  }
}

// ═══════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════

module.exports = {
  _notTools: true,

  // 核心函数
  isProcessRunning: isProcessRunning,
  getRunningApps: getRunningApps,
  screenshot: screenshot,
  ocr: ocr,
  setClipboard: setClipboard,
  getClipboard: getClipboard,
  typeText: typeText,
  pressKey: pressKey,
  clickAt: clickAt,
  activateApp: activateApp,
  launchAppByName: launchAppByName,
  getActiveWindowTitle: getActiveWindowTitle,
  listWindows: listWindows,
  checkDependencies: checkDependencies,
  getSessionType: getSessionType,

  // 高级功能
  launchApp: launchApp,
  sendMessage: sendMessage,

  // 辅助
  resolveAppName: resolveAppName,
  getProcessNames: getProcessNames,
  commandExists: commandExists,

  // 常量
  LINUX_APP_MAP: LINUX_APP_MAP,
  LINUX_PROCESS_MAP: LINUX_PROCESS_MAP,
};
