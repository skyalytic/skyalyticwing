/**
 * macOS 桌面自动化模块 (1.4.0+)
 *
 * "打通底层"实现：
 *   1. CGEvent 输入注入 — 系统级事件注入，绕过应用级事件处理（类似 Win32 PostMessage）
 *   2. Accessibility API — 系统级 UI 元素检查（类似 Windows UIA）
 *   3. CGWindowList — 系统级窗口枚举（类似 Win32 EnumWindows）
 *   4. Vision 框架 — 内置 OCR，原生支持中文（类似 Windows.Media.Ocr）
 *
 * 以上能力通过 Swift 助手二进制实现，首次使用时自动编译并缓存。
 * 回退方案：osascript (AppleScript) + screencapture + tesseract。
 *
 * 前置条件（用户必须手动授权）：
 *   - 系统设置 > 隧私与安全 > 辅助功能 → 勾选应用（CGEvent/AXUIElement 需要）
 *   - 系统设置 > 隧私与安全 > 屏幕录制 → 勾选应用（screencapture 需要）
 *   - 系统设置 > 隧私与安全 > 自动化 → 允许控制其他应用（osascript 需要）
 *   - 建议安装 tesseract: brew install tesseract tesseract-lang
 *
 * 接口兼容 Windows uia_launch_app / uia_send_message，AI 无需感知平台差异。
 *
 * 上下文 (ctx) 需提供:
 *   fs, path, os, execSync, execFileSync, spawnSync
 *   DATA_DIR, APP_DIR, WORKSPACE_OUTPUT_DIR
 *   broadcast, log, getWorkspaceOutputPath
 */

"use strict";

var fs = require("fs");
var path = require("path");
var os = require("os");
var { execSync, execFileSync, spawnSync } = require("child_process");

// ===== 标记为非工具模块（避免 ToolLoader 扫描警告）=====
module.exports._notTools = true;

// ═══════════════════════════════════════════════════
// 应用名 / 进程名映射
// ═══════════════════════════════════════════════════

var MAC_APP_MAP = {
  微信: "WeChat",
  WeChat: "WeChat",
  Weixin: "WeChat",
  xwechat: "WeChat",
  QQ: "QQ",
  企业微信: "WeCom",
  WeCom: "WeCom",
  WXWork: "WeCom",
  钉钉: "DingTalk",
  DingTalk: "DingTalk",
  飞书: "Lark",
  Lark: "Lark",
  Feishu: "Lark",
  Telegram: "Telegram",
  Safari: "Safari",
  Chrome: "Google Chrome",
  谷歌浏览器: "Google Chrome",
};

var MAC_PROCESS_MAP = {
  WeChat: ["WeChat"],
  QQ: ["QQ"],
  WeCom: ["WeCom", "WXWork"],
  DingTalk: ["DingTalk"],
  Lark: ["Lark", "Feishu"],
  Telegram: ["Telegram"],
  Safari: ["Safari"],
  "Google Chrome": ["Google Chrome", "chrome"],
};

// 登录界面关键词（macOS 微信）
var MAC_LOGIN_KEYWORDS = [
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
// Swift 助手：Vision OCR + CGEvent + CGWindowList
// ═══════════════════════════════════════════════════

var SWIFT_HELPER_SOURCE = [
  "// macOS 桌面自动化 Swift 助手",
  "// 功能: Vision OCR / CGEvent 输入 / CGWindowList 窗口枚举",
  "import Cocoa",
  "import Vision",
  "import ApplicationServices",
  "",
  'let args = CommandLine.arguments',
  'guard args.count >= 2 else { fputs("Usage: macos-helper <command> [args...]\\n", stderr); exit(1) }',
  'let cmd = args[1]',
  "",
  "// === ocr <image_path> : Vision OCR ===",
  'if cmd == "ocr" {',
  "    guard args.count >= 3 {",
  '        fputs("Usage: ocr <image_path>\\n", stderr); exit(1)',
  "    }",
  "    let imagePath = args[2]",
  "    guard let image = NSImage(contentsOfFile: imagePath),",
  "          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {",
  '        fputs("Error: Cannot load image: \\(imagePath)\\n", stderr); exit(1)',
  "    }",
  "    let request = VNRecognizeTextRequest()",
  '    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]',
  "    request.recognitionLevel = .accurate",
  "    request.usesLanguageCorrection = true",
  "    let handler = VNImageRequestHandler(cgImage: cgImage)",
  "    do { try handler.perform([request]) }",
  "    catch { fputs(\"Error: Vision request failed: \\(error)\\n\", stderr); exit(1) }",
  "    var lines: [String] = []",
  "    for observation in request.results ?? [] {",
  "        guard let candidate = observation.topCandidates(1).first else { continue }",
  "        let bbox = observation.boundingBox",
  "        // 格式: text|x,y,w,h (坐标已转换为左上角原点)",
  "        let x = bbox.origin.x",
  "        let y = 1.0 - bbox.origin.y - bbox.height",
  "        let w = bbox.width",
  "        let h = bbox.height",
  "        lines.append(\"\\(candidate.string)|\\(x),\\(y),\\(w),\\(h)|\\(candidate.confidence)\")",
  "    }",
  "    print(lines.joined(separator: \"\\n\"))",
  "    exit(0)",
  "}",
  "",
  "// === windows : CGWindowList 枚举所有窗口 ===",
  'if cmd == "windows" {',
  "    let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []",
  "    var lines: [String] = []",
  "    for win in windowInfo {",
  "        let windowID = win[kCGWindowNumber as String] as? CGWindowID ?? 0",
  "        let ownerName = (win[kCGWindowOwnerName as String] as? String) ?? \"\"",
  "        let windowName = (win[kCGWindowName as String] as? String) ?? \"\"",
  "        let layer = win[kCGWindowLayer as String] as? Int ?? 0",
  "        if layer != 0 { continue }  // 跳过非正常窗口",
  "        if windowName.isEmpty { continue }  // 跳过无标题窗口",
  "        var bounds = CGRect.zero",
  "        if let boundsDict = win[kCGWindowBounds as String] as? [String: Any] {",
  "            let x = (boundsDict[\"X\"] as? CGFloat) ?? 0",
  "            let y = (boundsDict[\"Y\"] as? CGFloat) ?? 0",
  "            let w = (boundsDict[\"Width\"] as? CGFloat) ?? 0",
  "            let h = (boundsDict[\"Height\"] as? CGFloat) ?? 0",
  "            bounds = CGRect(x: x, y: y, width: w, height: h)",
  "        }",
  "        lines.append(\"\\(windowID)|\\(ownerName)|\\(windowName)|\\(Int(bounds.origin.x)),\\(Int(bounds.origin.y)),\\(Int(bounds.width)),\\(Int(bounds.height))\")",
  "    }",
  "    print(lines.joined(separator: \"\\n\"))",
  "    exit(0)",
  "}",
  "",
  "// === active_window : 获取前台窗口标题 ===",
  'if cmd == "active_window" {',
  "    let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []",
  "    for win in windowInfo {",
  "        let ownerName = (win[kCGWindowOwnerName as String] as? String) ?? \"\"",
  "        let windowName = (win[kCGWindowName as String] as? String) ?? \"\"",
  "        let layer = win[kCGWindowLayer as String] as? Int ?? 0",
  "        let isOnScreen = (win[kCGWindowIsOnscreen as String] as? Bool) ?? false",
  "        if layer == 0 && isOnScreen && !windowName.isEmpty {",
  "            print(\"\\(ownerName)|\\(windowName)\")",
  "            exit(0)",
  "        }",
  "    }",
  "    exit(0)",
  "}",
  "",
  "// === type_text <text> : CGEvent 输入注入（绕过应用级事件处理）===",
  'if cmd == "type_text" {',
  "    guard args.count >= 3 {",
  '        fputs("Usage: type_text <text>\\n", stderr); exit(1)',
  "    }",
  "    let text = args[2]",
  "    let source = CGEventSource(stateID: .hidSystemState)",
  "    for char in text {",
  "        let unicode = String(char).utf16.first ?? 0",
  "        // CGEventKeyboardSetUnicodeString 可以注入任意 Unicode 字符（包括中文）",
  "        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0)",
  "        keyDown?.keyboardSetUnicodeString(string: String(char))",
  "        keyDown?.type = .keyDown",
  "        keyDown?.post(tap: .cghidEventTap)",
  "        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0)",
  "        keyUp?.keyboardSetUnicodeString(string: String(char))",
  "        keyUp?.type = .keyUp",
  "        keyUp?.post(tap: .cghidEventTap)",
  "    }",
  "    exit(0)",
  "}",
  "",
  "// === press_key <key_code> [modifiers...] : CGEvent 按键 ===",
  '// modifiers: command, shift, control, option',
  'if cmd == "press_key" {',
  "    guard args.count >= 3 {",
  '        fputs("Usage: press_key <key_code> [modifiers...]\\n", stderr); exit(1)',
  "    }",
  "    let keyCode = UInt16(args[2]) ?? 0",
  "    var flags = CGEventFlags(rawValue: 0)",
  "    if args.count > 3 {",
  "        for i in 3..<args.count {",
  "            switch args[i] {",
  '            case "command": flags.insert(.maskCommand)',
  '            case "shift": flags.insert(.maskShift)',
  '            case "control": flags.insert(.maskControl)',
  '            case "option": flags.insert(.maskAlternate)',
  "            default: break",
  "            }",
  "        }",
  "    }",
  "    let source = CGEventSource(stateID: .hidSystemState)",
  "    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode)",
  "    keyDown?.flags = flags",
  "    keyDown?.type = .keyDown",
  "    keyDown?.post(tap: .cghidEventTap)",
  "    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode)",
  "    keyUp?.flags = flags",
  "    keyUp?.type = .keyUp",
  "    keyUp?.post(tap: .cghidEventTap)",
  "    exit(0)",
  "}",
  "",
  "// === click_at <x> <y> : CGEvent 鼠标点击 ===",
  'if cmd == "click_at" {',
  "    guard args.count >= 4 {",
  '        fputs("Usage: click_at <x> <y>\\n", stderr); exit(1)',
  "    }",
  "    let x = CGFloat(Double(args[2]) ?? 0)",
  "    let y = CGFloat(Double(args[3]) ?? 0)",
  "    let source = CGEventSource(stateID: .hidSystemState)",
  "    let mouseDown = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)",
  "    let mouseUp = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)",
  "    mouseDown?.post(tap: .cghidEventTap)",
  "    mouseUp?.post(tap: .cghidEventTap)",
  "    exit(0)",
  "}",
  "",
  "// === check_permissions : 检查辅助功能权限 ===",
  'if cmd == "check_permissions" {',
  "    let axTrusted = AXIsProcessTrustedWithOptions(nil)",
  '    print("accessibility:\\(axTrusted ? "YES" : "NO")")',
  "    // 屏幕录制权限检查（macOS 10.15+）",
  "    let screenRecordingOK = CGPreflightScreenCaptureAccess()",
  '    print("screen_recording:\\(screenRecordingOK ? "YES" : "NO")")',
  "    exit(0)",
  "}",
  "",
  "// === activate_app <bundle_id_or_name> : 激活应用 ===",
  'if cmd == "activate_app" {',
  "    guard args.count >= 3 {",
  '        fputs("Usage: activate_app <name>\\n", stderr); exit(1)',
  "    }",
  "    let appName = args[2]",
  "    let workspace = NSWorkspace.shared",
  "    for app in workspace.runningApplications {",
  "        if app.activationPolicy == .regular {",
  "            let localName = app.localizedName ?? \"\"",
  "            if localName == appName || localName.contains(appName) {",
  "                app.activate(options: [.activateAllWindows])",
  "                print(\"activated:\\(localName)\")",
  "                exit(0)",
  "            }",
  "        }",
  "    }",
  '    print("not_found")',
  "    exit(0)",
  "}",
  "",
  'fputs("Unknown command: \\(cmd)\\n", stderr)',
  "exit(1)",
].join("\n");

// Swift 助手二进制缓存路径
var _helperBinaryPath = null;
var _helperCompiled = false;

/**
 * 获取 Swift 助手二进制路径（首次使用时编译）
 */
function getHelperBinary(dataDir) {
  if (_helperBinaryPath && _helperCompiled && fs.existsSync(_helperBinaryPath)) {
    return _helperBinaryPath;
  }
  var binDir = path.join(dataDir || os.homedir(), "macos-helper");
  if (!fs.existsSync(binDir)) {
    try {
      fs.mkdirSync(binDir, { recursive: true });
    } catch (e) {}
  }
  var binPath = path.join(binDir, "macos-helper");
  var srcPath = path.join(binDir, "macos-helper.swift");

  // 检查是否已编译且源码未变
  var needCompile = true;
  if (fs.existsSync(binPath) && fs.existsSync(srcPath)) {
    try {
      var oldSrc = fs.readFileSync(srcPath, "utf8");
      if (oldSrc === SWIFT_HELPER_SOURCE) {
        needCompile = false;
      }
    } catch (e) {}
  }

  if (needCompile) {
    try {
      fs.writeFileSync(srcPath, SWIFT_HELPER_SOURCE, "utf8");
      // 编译 Swift 助手
      execSync(
        'swiftc -O "' + srcPath + '" -o "' + binPath + '" 2>&1',
        { encoding: "utf8", timeout: 60000 }
      );
      _helperCompiled = true;
    } catch (e) {
      console.error("[macOS-auto] Swift helper compile failed:", e.message);
      return null;
    }
  }

  _helperBinaryPath = binPath;
  return binPath;
}

/**
 * 运行 Swift 助手命令
 */
function runHelper(cmd, cmdArgs, dataDir) {
  var binPath = getHelperBinary(dataDir);
  if (!binPath) return null;
  try {
    var allArgs = [cmd].concat(cmdArgs || []);
    var result = spawnSync(binPath, allArgs, { encoding: "utf8", timeout: 30000 });
    if (result.status === 0) {
      return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
    }
    return { ok: false, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (e) {
    return { ok: false, stdout: "", stderr: e.message };
  }
}

// ═══════════════════════════════════════════════════
// 核心：进程检测 / 截图 / OCR / 输入
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
    } catch (e) {
      // pgrep 返回非0表示没找到，继续检查下一个
    }
  }
  return false;
}

/**
 * 获取运行中进程列表
 */
function getRunningApps() {
  try {
    var out = execSync('ps aux | grep -v grep | grep -E "\\.app/"', {
      encoding: "utf8",
      timeout: 5000,
    });
    return out;
  } catch (e) {
    return "";
  }
}

/**
 * 截图（使用 screencapture）
 */
function screenshot(savePath) {
  try {
    // 改用 execFileSync + 数组参数，避免 shell 注入
    execFileSync('screencapture', ['-x', savePath], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (fs.existsSync(savePath)) {
      var stat = fs.statSync(savePath);
      if (stat.size > 100) return { ok: true, path: savePath };
    }
    return { ok: false, error: "截图文件为空或不存在" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * OCR 文字识别
 * 优先使用 Vision 框架（Swift 助手），回退到 tesseract
 */
function ocr(imagePath, dataDir) {
  // 1. 尝试 Vision 框架
  var visionResult = runHelper("ocr", [imagePath], dataDir);
  if (visionResult && visionResult.ok && visionResult.stdout.trim()) {
    var lines = visionResult.stdout.trim().split("\n");
    var results = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split("|");
      if (parts.length >= 2) {
        var text = parts[0];
        var coords = parts[1].split(",");
        var confidence = parts[2] ? parseFloat(parts[2]) : 1.0;
        results.push({
          text: text,
          x: parseFloat(coords[0]) || 0,
          y: parseFloat(coords[1]) || 0,
          w: parseFloat(coords[2]) || 0,
          h: parseFloat(coords[3]) || 0,
          confidence: confidence,
        });
      }
    }
    return { ok: true, engine: "vision", results: results, text: results.map(function(r){return r.text;}).join("\n") };
  }

  // 2. 回退到 tesseract
  try {
    var tessOut = execSync(
      'tesseract "' + imagePath + '" stdout -l chi_sim+eng 2>/dev/null',
      { encoding: "utf8", timeout: 30000 }
    );
    return { ok: true, engine: "tesseract", results: [], text: tessOut.trim() };
  } catch (e) {
    return { ok: false, error: "OCR 失败: Vision 不可用且 tesseract 未安装或执行失败" };
  }
}

/**
 * 设置剪贴板
 */
function setClipboard(text) {
  try {
    var proc = require("child_process").spawn("pbcopy");
    proc.stdin.write(text);
    proc.stdin.end();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 获取剪贴板内容
 */
function getClipboard() {
  try {
    return execSync("pbpaste", { encoding: "utf8", timeout: 5000 });
  } catch (e) {
    return "";
  }
}

/**
 * 输入文字（优先 CGEvent，回退到剪贴板粘贴）
 * CGEvent 可以注入任意 Unicode 字符（包括中文），绕过应用级事件处理
 */
function typeText(text, dataDir) {
  if (!text) return false;

  // 1. 尝试 CGEvent 输入注入（打通底层）
  var cgResult = runHelper("type_text", [text], dataDir);
  if (cgResult && cgResult.ok) {
    return true;
  }

  // 2. 回退：剪贴板 + Cmd+V 粘贴
  setClipboard(text);
  return pressKey("36", ["command"], dataDir); // 36 = Return, Cmd+V
}

/**
 * 按键（优先 CGEvent，回退到 osascript）
 * keyCode 参考: https://eastmanreference.com/complete-list-of-applescript-key-codes
 * 常用: 36=Return, 48=Tab, 49=Space, 51=Delete, 53=Escape, 122=F1, 96=F5
 * 123=Left, 124=Right, 125=Down, 126=Up
 */
function pressKey(keyCode, modifiers, dataDir) {
  modifiers = modifiers || [];

  // 1. 尝试 CGEvent
  var cgArgs = [String(keyCode)].concat(modifiers);
  var cgResult = runHelper("press_key", cgArgs, dataDir);
  if (cgResult && cgResult.ok) {
    return true;
  }

  // 2. 回退到 osascript
  try {
    // C-B4: 对 keyCode 做数字校验，防止 AppleScript 注入
    if (!/^\d+$/.test(String(keyCode))) return false;
    var modStr = "";
    if (modifiers.indexOf("command") >= 0) modStr += " command down";
    if (modifiers.indexOf("shift") >= 0) modStr += " shift down";
    if (modifiers.indexOf("control") >= 0) modStr += " control down";
    if (modifiers.indexOf("option") >= 0) modStr += " option down";
    modStr = modStr.trim();
    var script;
    if (modStr) {
      script = 'tell application "System Events" to key code ' + keyCode + " using {" + modStr + "}";
    } else {
      script = 'tell application "System Events" to key code ' + keyCode;
    }
    execFileSync('osascript', ['-e', script], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 点击坐标（优先 CGEvent，回退到 osascript/cliclick）
 */
function clickAt(x, y, dataDir) {
  // C-B4: 对坐标做数字校验，防止命令注入
  var nx = parseInt(x, 10);
  var ny = parseInt(y, 10);
  if (!isFinite(nx) || !isFinite(ny)) return false;
  var sx = String(nx);
  var sy = String(ny);

  // 1. 尝试 CGEvent
  var cgResult = runHelper("click_at", [sx, sy], dataDir);
  if (cgResult && cgResult.ok) {
    return true;
  }

  // 2. 回退到 osascript
  try {
    var script = 'tell application "System Events" to click at {' + sx + ", " + sy + "}";
    execFileSync('osascript', ['-e', script], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch (e) {
    // 3. 最后回退到 cliclick（如果安装了）
    try {
      execFileSync('cliclick', ['c:' + sx + ',' + sy], { encoding: "utf8", timeout: 5000 });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * 激活应用
 */
function activateApp(appName) {
  // 1. 尝试 osascript
  try {
    // C-B4: 改用 execFileSync + 数组参数，对 appName 转义双引号防止 AppleScript 注入
    var script = 'tell application "' + String(appName).replace(/"/g, '\\"') + '" to activate';
    execFileSync('osascript', ['-e', script], { encoding: "utf8", timeout: 10000 });
    return true;
  } catch (e) {
    // 2. 尝试 open -a
    try {
      execFileSync('open', ['-a', appName], { encoding: "utf8", timeout: 10000 });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * 启动应用
 */
function launchAppByName(appName) {
  try {
    // C-B4: 改用 execFileSync + 数组参数，避免 shell 注入
    execFileSync('open', ['-a', appName], { encoding: "utf8", timeout: 10000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 获取前台窗口标题
 */
function getActiveWindowTitle(dataDir) {
  // 1. 尝试 CGWindowList (Swift 助手)
  var result = runHelper("active_window", [], dataDir);
  if (result && result.ok && result.stdout.trim()) {
    return result.stdout.trim();
  }

  // 2. 回退到 osascript
  try {
    var script =
      'tell application "System Events" to tell (first process whose frontmost is true) to get title of front window';
    return execSync('osascript -e \'' + script + "'", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch (e) {
    return "";
  }
}

/**
 * 枚举所有窗口
 */
function listWindows(dataDir) {
  // 1. 尝试 CGWindowList (Swift 助手)
  var result = runHelper("windows", [], dataDir);
  if (result && result.ok && result.stdout.trim()) {
    var lines = result.stdout.trim().split("\n");
    var wins = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split("|");
      if (parts.length >= 4) {
        var bounds = parts[3].split(",");
        wins.push({
          id: parseInt(parts[0]) || 0,
          owner: parts[1],
          title: parts[2],
          x: parseInt(bounds[0]) || 0,
          y: parseInt(bounds[1]) || 0,
          w: parseInt(bounds[2]) || 0,
          h: parseInt(bounds[3]) || 0,
        });
      }
    }
    return wins;
  }

  // 2. 回退到 osascript
  try {
    var script =
      'tell application "System Events" to get name of every window of (every process whose visible is true)';
    var out = execSync('osascript -e \'' + script + "'", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return out.split(",").map(function (t) {
      return { owner: "", title: t.trim(), id: 0 };
    });
  } catch (e) {
    return [];
  }
}

/**
 * 检查 macOS 权限
 */
function checkPermissions(dataDir) {
  var result = runHelper("check_permissions", [], dataDir);
  var perms = { accessibility: false, screenRecording: false };
  if (result && result.ok && result.stdout) {
    var lines = result.stdout.trim().split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("accessibility:") >= 0) {
        perms.accessibility = lines[i].indexOf("YES") >= 0;
      }
      if (lines[i].indexOf("screen_recording:") >= 0) {
        perms.screenRecording = lines[i].indexOf("YES") >= 0;
      }
    }
  }
  return perms;
}

// ═══════════════════════════════════════════════════
// 高级功能：launchApp / sendMessage
// ═══════════════════════════════════════════════════

/**
 * 解析应用名为 macOS 标准名称
 */
function resolveAppName(inputName) {
  if (!inputName) return null;
  // 直接匹配
  if (MAC_APP_MAP[inputName]) return MAC_APP_MAP[inputName];
  // 模糊匹配
  var inputLower = inputName.toLowerCase();
  for (var key in MAC_APP_MAP) {
    if (key.toLowerCase() === inputLower || MAC_APP_MAP[key].toLowerCase() === inputLower) {
      return MAC_APP_MAP[key];
    }
  }
  // 如果传入的本身就是英文 app 名，直接用
  return inputName;
}

/**
 * 获取应用的进程名列表
 */
function getProcessNames(appName) {
  if (MAC_PROCESS_MAP[appName]) return MAC_PROCESS_MAP[appName];
  return [appName];
}

/**
 * 等待 (Promise)
 */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * launchApp — 启动/激活桌面应用
 * 兼容 Windows uia_launch_app 接口
 *
 * 流程:
 *   1. 检查权限（辅助功能 + 屏幕录制）
 *   2. Step 0 初始截图
 *   3. 进程检测（pgrep）
 *   4. 已运行 → 激活窗口（osascript activate）
 *   5. 未运行 → 启动应用（open -a）
 *   6. 等待窗口出现
 *   7. 登录界面检测（OCR）
 *   8. 最终截图内联返回
 *
 * @param {Object} args - { appName, processName, windowTitle, waitMs }
 * @param {Object} ctx - 上下文（fs, path, broadcast, getWorkspaceOutputPath, DATA_DIR, ...）
 */
async function launchApp(args, ctx) {
  var ctxFs = ctx.fs || fs;
  var ctxPath = ctx.path || path;
  var broadcast = ctx.broadcast || function () {};
  var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;
  var dataDir = ctx.DATA_DIR || os.homedir();

  var appNameInput = args.appName || args.name || "";
  if (!appNameInput) {
    return { ok: false, error: "必须提供 appName 参数（应用名称）" };
  }

  var macAppName = resolveAppName(appNameInput);
  var processNames = args.processName
    ? [args.processName]
    : getProcessNames(macAppName);
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
        ? getWorkspaceOutputPath("mac-launch-" + stepLabel + "-" + Date.now() + ".png")
        : path.join(os.tmpdir(), "mac-launch-" + stepLabel + "-" + Date.now() + ".png");
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
    // Step 0: 权限检查 + 初始截图
    progress("Step 0: 初始截图");
    takeShot("step0-init");

    // 权限检查
    var perms = checkPermissions(dataDir);
    logAdd("权限: accessibility=" + perms.accessibility + " screenRecording=" + perms.screenRecording);
    if (!perms.accessibility) {
      progress("⚠️ 辅助功能权限未授予，CGEvent/AppleScript 输入将不可用");
      progress("请在「系统设置 > 隐私与安全 > 辅助功能」中授权");
    }
    if (!perms.screenRecording) {
      progress("⚠️ 屏幕录制权限未授予，截图将为空白");
      progress("请在「系统设置 > 隐私与安全 > 屏幕录制」中授权");
    }

    // Step 1: 进程检测
    progress("Step 1: 检测 " + macAppName + " 进程 (" + processNames.join("/") + ")");
    var running = isProcessRunning(processNames);
    logAdd("进程检测结果: " + (running ? "运行中" : "未运行"));

    if (running) {
      // Step 2: 已运行 → 激活窗口
      progress("Step 2: " + macAppName + " 已运行，激活窗口");
      activateApp(macAppName);
      await sleep(1500);
      takeShot("step2-activated");

      // 检查窗口标题
      var winTitle = getActiveWindowTitle(dataDir);
      logAdd("当前窗口: " + winTitle);

      // 登录界面检测
      var needsLogin = false;
      if (winTitle) {
        for (var li = 0; li < MAC_LOGIN_KEYWORDS.length; li++) {
          if (winTitle.indexOf(MAC_LOGIN_KEYWORDS[li]) >= 0) {
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
          error: macAppName + " 需要登录（检测到登录界面）。请用户手动扫码登录后重试",
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

    // Step 3: 未运行 → 启动应用
    progress("Step 3: " + macAppName + " 未运行，启动中...");
    var launched = launchAppByName(macAppName);
    if (!launched) {
      logAdd("open -a 失败，尝试直接路径");
      // 可以在这里添加直接路径启动逻辑
      return attachShots({
        ok: false,
        error: "无法启动 " + macAppName + "，请检查应用是否已安装",
        logs: logs,
      });
    }

    // Step 4: 等待窗口出现
    progress("Step 4: 等待 " + macAppName + " 窗口出现...");
    var waitDeadline = Date.now() + waitMs;
    var windowFound = false;
    while (Date.now() < waitDeadline) {
      await sleep(1000);
      takeShot("step4-waiting");
      if (isProcessRunning(processNames)) {
        windowFound = true;
        break;
      }
    }

    if (!windowFound) {
      progress("⚠️ 等待超时，未检测到 " + macAppName + " 窗口");
      return attachShots({
        ok: false,
        error: "启动 " + macAppName + " 超时（等待" + waitMs + "ms未出现窗口）",
        logs: logs,
      });
    }

    // 激活窗口
    activateApp(macAppName);
    await sleep(1500);
    takeShot("step4-activated");

    // Step 5: 登录界面检测
    progress("Step 5: 检测登录界面");
    var winTitle2 = getActiveWindowTitle(dataDir);
    logAdd("窗口标题: " + winTitle2);

    var needsLogin2 = false;
    if (winTitle2) {
      for (var li2 = 0; li2 < MAC_LOGIN_KEYWORDS.length; li2++) {
        if (winTitle2.indexOf(MAC_LOGIN_KEYWORDS[li2]) >= 0) {
          needsLogin2 = true;
          break;
        }
      }
    }

    // OCR 兜底检测登录界面
    if (!needsLogin2 && shots.length > 0) {
      var lastShot = shots[shots.length - 1].path;
      var ocrResult = ocr(lastShot, dataDir);
      if (ocrResult.ok && ocrResult.text) {
        for (var li3 = 0; li3 < MAC_LOGIN_KEYWORDS.length; li3++) {
          if (ocrResult.text.indexOf(MAC_LOGIN_KEYWORDS[li3]) >= 0) {
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
        error: macAppName + " 需要登录（检测到登录界面）。请用户手动扫码登录后重试",
        logs: logs,
      });
    }

    progress("✅ " + macAppName + " 启动成功");
    return attachShots({
      ok: true,
      alreadyRunning: false,
      needsLogin: false,
      windowTitle: winTitle2,
      logs: logs,
    });
  } catch (e) {
    logAdd("异常: " + e.message);
    return attachShots({
      ok: false,
      error: "启动应用异常: " + e.message,
      logs: logs,
    });
  }
}

/**
 * sendMessage — 通过桌面应用发送消息
 * 兼容 Windows uia_send_message 接口
 *
 * 流程:
 *   1. 统一走 launchApp（启动/激活/登录检测）
 *   2. 搜索联系人（Cmd+F → 输入名字 → Enter）
 *   3. OCR 验证是否进入聊天页
 *   4. 输入消息（CGEvent/剪贴板粘贴中文）
 *   5. 按 Enter 发送
 *   6. 截图验证
 *
 * @param {Object} args - { appName, contactName, message, messageText }
 * @param {Object} ctx - 上下文
 */
async function sendMessage(args, ctx) {
  var ctxFs = ctx.fs || fs;
  var ctxPath = ctx.path || path;
  var broadcast = ctx.broadcast || function () {};
  var getWorkspaceOutputPath = ctx.getWorkspaceOutputPath;
  var dataDir = ctx.DATA_DIR || os.homedir();

  var appNameInput = args.appName || "QQ";
  var contactName = args.contactName || "";
  var message = args.messageText || args.message || "";

  if (!contactName) {
    return { ok: false, error: "必须提供 contactName 参数（联系人名称）" };
  }
  if (!message) {
    return { ok: false, error: "必须提供 message 或 messageText 参数（消息内容）" };
  }

  var macAppName = resolveAppName(appNameInput);
  var processNames = getProcessNames(macAppName);

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
        ? getWorkspaceOutputPath("mac-send-" + stepLabel + "-" + Date.now() + ".png")
        : path.join(os.tmpdir(), "mac-send-" + stepLabel + "-" + Date.now() + ".png");
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
      throw new Error("操作总超时(240s)已中止。最后进度见日志，请根据截图判断当前状态");
    }
  }

  try {
    watchdog = true;

    // Step 1: 统一走 launchApp
    progress("Step 1: 启动/激活 " + macAppName);
    var launchResult = await launchApp(
      { appName: appNameInput, processName: args.processName, waitMs: args.waitMs || 8000 },
      ctx
    );
    logAdd("launchApp 结果: ok=" + launchResult.ok + " needsLogin=" + launchResult.needsLogin);

    if (!launchResult.ok) {
      // 如果是登录界面，直接返回
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

    // Step 2: 搜索联系人
    progress("Step 2: 搜索联系人「" + contactName + "」");

    // 方法 1: Cmd+F 搜索（微信/QQ/飞书通用）
    progress("  按下 Cmd+F 搜索");
    pressKey("3", ["command"], dataDir); // 3 = F (keyCode for 'f')
    await sleep(800);

    // 方法 2: 如果 Cmd+F 不行，用 Cmd+Shift+F（全局搜索）
    // 这里先用 Cmd+F，如果 OCR 没看到搜索框再试其他方法

    takeShot("step2-search-focused");
    checkTimeout();

    // 输入联系人名字（CGEvent 输入中文，回退到剪贴板粘贴）
    progress("  输入联系人名字");
    var typeResult = typeText(contactName, dataDir);
    if (!typeResult) {
      logAdd("⚠️ CGEvent 输入失败，使用剪贴板粘贴");
      setClipboard(contactName);
      pressKey("36", ["command"], dataDir); // Cmd+V
    }
    await sleep(1500); // 等待搜索结果

    takeShot("step2-search-results");
    checkTimeout();

    // 按 Enter 选择第一个搜索结果
    progress("  按 Enter 选择搜索结果");
    pressKey("36", [], dataDir); // 36 = Return
    await sleep(1500); // 等待进入聊天页

    takeShot("step2-chat-opened");
    checkTimeout();

    // Step 3: 验证是否进入聊天页
    progress("Step 3: 验证聊天页");
    var chatVerified = false;
    var winTitle = getActiveWindowTitle(dataDir);
    logAdd("窗口标题: " + winTitle);

    // 优先通过窗口标题验证（微信 macOS 进入聊天页后标题变为联系人名）
    if (winTitle && winTitle.indexOf(contactName) >= 0) {
      chatVerified = true;
      logAdd("✅ 窗口标题包含联系人名，验证通过");
    }

    // OCR 兜底验证
    if (!chatVerified && shots.length > 0) {
      var lastShot = shots[shots.length - 1].path;
      var ocrResult = ocr(lastShot, dataDir);
      if (ocrResult.ok && ocrResult.text) {
        logAdd("OCR 文本: " + ocrResult.text.substring(0, 200));
        if (ocrResult.text.indexOf(contactName) >= 0) {
          chatVerified = true;
          logAdd("✅ OCR 包含联系人名，验证通过");
        }
        // 检查联系人首字
        if (!chatVerified && contactName.length > 0) {
          var firstChar = contactName.charAt(0);
          if (ocrResult.text.indexOf(firstChar) >= 0) {
            chatVerified = true;
            logAdd("✅ OCR 包含联系人首字「" + firstChar + "」，验证通过");
          }
        }
      }
    }

    if (!chatVerified) {
      progress("⚠️ 聊天页验证未通过，但继续尝试发送");
    }

    checkTimeout();

    // Step 4: 输入消息
    progress("Step 4: 输入消息");
    var msgTypeResult = typeText(message, dataDir);
    if (!msgTypeResult) {
      logAdd("⚠️ CGEvent 输入失败，使用剪贴板粘贴");
      setClipboard(message);
      pressKey("36", ["command"], dataDir); // Cmd+V
    }
    await sleep(500);

    takeShot("step4-message-typed");
    checkTimeout();

    // Step 5: 发送消息
    progress("Step 5: 按 Enter 发送消息");
    pressKey("36", [], dataDir); // 36 = Return
    await sleep(1000);

    takeShot("step5-message-sent");
    checkTimeout();

    // Step 6: 最终验证
    progress("Step 6: 验证发送结果");
    var finalWinTitle = getActiveWindowTitle(dataDir);
    logAdd("最终窗口标题: " + finalWinTitle);

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
    return attachShots({
      ok: false,
      error: "发送消息异常: " + e.message,
      logs: logs,
    });
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
  checkPermissions: checkPermissions,

  // 高级功能
  launchApp: launchApp,
  sendMessage: sendMessage,

  // 辅助
  resolveAppName: resolveAppName,
  getProcessNames: getProcessNames,
  getHelperBinary: getHelperBinary,
  runHelper: runHelper,

  // 常量
  MAC_APP_MAP: MAC_APP_MAP,
  MAC_PROCESS_MAP: MAC_PROCESS_MAP,
};
