#!/usr/bin/env node
var path = require('path');
var fs = require('fs');
var os = require('os');
var execSync = require('child_process').execSync;
var spawnSync = require('child_process').spawnSync;

var BIN_DIR = path.resolve(__dirname);
var APP_DIR = path.resolve(__dirname, '..');
var IS_WIN = os.platform() === 'win32';
var IS_MAC = os.platform() === 'darwin';
var IS_LINUX = !IS_WIN && !IS_MAC;
var EDITION = require('./product-edition.cjs').product();
var CLI_COMMAND = EDITION ? EDITION.cliCommand : 'skyalyticwing';

// Unix desktop registration is dependency-free and never invokes sudo/Homebrew.
if (!IS_WIN) {
  try { console.log('CLI installed: ' + require('./cli-registration.cjs').install()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  return;
}

function log(text) { console.log(text); }
function ok(text) { console.log('\x1b[32m+ ' + text + '\x1b[0m'); }
function err(text) { console.log('\x1b[31mx ' + text + '\x1b[0m'); }
function info(text) { console.log('\x1b[36mi ' + text + '\x1b[0m'); }
function warn(text) { console.log('\x1b[33m! ' + text + '\x1b[0m'); }

function checkCmd(cmd) {
  try { execSync(cmd + (IS_WIN ? ' >nul 2>&1' : ' >/dev/null 2>&1'), { timeout: 5000 }); return true; }
  catch(e) { return false; }
}

function installDeps() {
  console.log('\n+==========================================+');
  console.log('|   SkyalyticWing                          |');
  console.log('+==========================================+\n');

  if (IS_WIN) {
    info('Windows - all dependencies bundled');
    return true;
  }

  if (IS_MAC) {
    info('Platform: macOS');
    var macDeps = [
      { name: 'cliclick', check: 'which cliclick', install: 'brew install cliclick', desc: 'Mouse/Keyboard control' }
    ];
    var missing = [];
    for (var i = 0; i < macDeps.length; i++) {
      var dep = macDeps[i];
      if (checkCmd(dep.check)) { ok(dep.name + ': installed'); }
      else { warn(dep.name + ': not installed (' + dep.desc + ')'); missing.push(dep); }
    }
    if (missing.length === 0) { ok('All dependencies satisfied'); return true; }
    if (!checkCmd('which brew')) { err('Homebrew not found'); return false; }
    for (var j = 0; j < missing.length; j++) {
      try { execSync(missing[j].install, { timeout: 120000, stdio: 'inherit' }); ok(missing[j].name + ' installed'); }
      catch(e) { err(missing[j].name + ' install failed'); }
    }
    return true;
  }

  if (IS_LINUX) {
    info('Platform: Linux');
    var linuxDeps = [
      { name: 'xdotool', check: 'which xdotool', installApt: 'sudo apt install -y xdotool', desc: 'Mouse/Keyboard control' },
      { name: 'libnotify', check: 'which notify-send', installApt: 'sudo apt install -y libnotify-bin', desc: 'Desktop notifications' },
      { name: 'curl', check: 'which curl', installApt: 'sudo apt install -y curl', desc: 'Network requests' }
    ];
    var missing = [];
    for (var i = 0; i < linuxDeps.length; i++) {
      if (!checkCmd(linuxDeps[i].check)) { missing.push(linuxDeps[i]); }
    }
    if (missing.length === 0) { ok('All dependencies satisfied'); return true; }
    for (var j = 0; j < missing.length; j++) {
      try { execSync(missing[j].installApt, { timeout: 120000, stdio: 'inherit' }); ok(missing[j].name + ' installed'); }
      catch(e) { err(missing[j].name + ' install failed'); }
    }
    return true;
  }
}

/** 经临时 .ps1 文件执行 PowerShell 脚本（spawnSync 参数数组直达 powershell.exe）。
 *  旧实现经 cmd.exe 内联 -Command 并转义引号：多行脚本被压成单行导致 here-string
 *  语法被破坏、PowerShell 挂起 → execSync 30s 超时只杀掉外层 cmd.exe，孤儿
 *  powershell.exe 仍占用安装终端的控制台，导致安装完成后窗口无法关闭。
 *  改为 -File + -NonInteractive + windowsHide 三重规避：不经 cmd.exe 无转义问题、
 *  不会进入交互模式读 stdin、超时时直接杀 powershell.exe 本体且不附着控制台。 */
function runPowerShell(psScript, timeoutMs) {
  var tmpFile = path.join(os.tmpdir(), 'skyalyticwing-path-' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.ps1');
  // UTF-8 BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI(GBK) 解码，中文用户名路径会变乱码
  fs.writeFileSync(tmpFile, '\ufeff' + psScript, 'utf8');
  try {
    var r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { encoding: 'utf8', timeout: timeoutMs || 30000, windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw Error('PowerShell PATH registration failed: ' + (r.stderr || r.status));
    return (r.stdout || '').trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* 临时文件清理失败不影响流程 */ }
  }
}

function addToUserPath(dirToAdd) {
  if (IS_WIN) {
    var normalizedDir = dirToAdd.replace(/\//g, '\\');
    try {
      var psScript = [
        "$dirToAdd = '" + normalizedDir.replace(/'/g, "''") + "'",
        '$currentPath = [System.Environment]::GetEnvironmentVariable("Path", "User")',
        '$pathEntries = $currentPath -split ";" | Where-Object { $_ -ne "" }',
        '$normalizedEntries = $pathEntries | ForEach-Object { $_.TrimEnd("\\").ToLower() }',
        '$dirLower = $dirToAdd.TrimEnd("\\").ToLower()',
        'if ($normalizedEntries -contains $dirLower) {',
        '  Write-Host "PATH_ALREADY_CONTAINS"',
        '} else {',
        '  $newPath = $currentPath',
        '  if ($newPath -ne "" -and -not $newPath.EndsWith(";")) { $newPath += ";" }',
        '  $newPath += $dirToAdd',
        '  [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")',
        '  Write-Host "PATH_ADDED"',
        '  Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"',
        '  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)]',
        '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);',
        '"@',
        '  [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]([UIntPtr]::Zero))',
        '}'
      ].join('\r\n');

      var result = runPowerShell(psScript, 30000);
      if (result.indexOf('PATH_ALREADY_CONTAINS') >= 0) {
        ok('PATH already contains: ' + normalizedDir);
      } else if (result.indexOf('PATH_ADDED') >= 0) {
        ok('Added to user PATH: ' + normalizedDir);
      } else {
        fallbackAddToPath(normalizedDir);
      }
    } catch(e) {
      warn('PowerShell failed: ' + (e && e.message ? e.message : String(e)));
      fallbackAddToPath(normalizedDir);
    }
  } else {
    var homeDir = os.homedir();
    var shellRc = IS_MAC
      ? (fs.existsSync(path.join(homeDir, '.zshrc')) ? path.join(homeDir, '.zshrc') : path.join(homeDir, '.bash_profile'))
      : (fs.existsSync(path.join(homeDir, '.bashrc')) ? path.join(homeDir, '.bashrc') : path.join(homeDir, '.profile'));

    var exportLine = 'export PATH="' + dirToAdd + ':$PATH"';
    if (fs.existsSync(shellRc)) {
      var rcContent = fs.readFileSync(shellRc, 'utf-8');
      if (rcContent.indexOf(dirToAdd) >= 0) { ok('PATH already configured'); return; }
      fs.appendFileSync(shellRc, '\n# SkyalyticWing CLI\n' + exportLine + '\n');
    } else {
      fs.writeFileSync(shellRc, exportLine + '\n');
    }
    ok('Added to PATH in ' + shellRc);
  }
}

function fallbackAddToPath(normalizedDir) {
  try {
    var currentPath = '';
    try {
      var regOutput = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8', timeout: 5000 });
      var match = regOutput.match(/Path\s+REG_\w+\s+(.*)/);
      if (match) currentPath = match[1].trim();
    } catch(e) {}

    var pathEntries = currentPath.split(';').map(function(p) { return p.trim().toLowerCase().replace(/\\$/, ''); });
    var dirLower = normalizedDir.toLowerCase().replace(/\\$/, '');
    if (pathEntries.indexOf(dirLower) >= 0) { ok('PATH already contains: ' + normalizedDir); return; }

    var newPath = currentPath ? currentPath + ';' + normalizedDir : normalizedDir;
    var result = spawnSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', newPath, '/f'], { timeout: 10000, windowsHide: true });
    if (result.error || result.status !== 0) throw Error('Registry PATH update failed');
    ok('Added to user PATH (fallback): ' + normalizedDir);
  } catch(e2) {
    err('Failed to add to PATH: ' + e2.message);
    info('Please manually add to PATH: ' + normalizedDir);
  }
}

/** 清理旧版网关自启残留（升级/重装场景；与后端 daemon.service.ts 的
 *  cleanupLegacyAutostartEntries 对齐，安装时兜底清理）：
 *  1. 启动文件夹旧入口：历史各版的可见终端 .cmd、hidden.vbs、.lnk。
 *     覆盖两代命名——上一版 SkyalyticClaw（skyalyticclaw-* / SkyAlyticClaw.lnk）
 *     与新命名 SkyalyticWing 重装场景的历史形态。重装后安装路径恢复有效，
 *     这些入口会在开机时重新拉起可见终端网关（还会与桌面端抢 910 端口），必须清掉。
 *     注意：保留 skyalyticwing-gateway.vbs（新版降级入口，隐藏窗口），
 *     避免升级重装后用户的网关自启被静默禁用。
 *  2. 历史计划任务：「Skyalyticclaw Gateway」（带空格，最早期遗留，指向已不存在的
 *     gateway.cmd，登录必失败）与「SkyAlyticClawGateway」（SkyalyticClaw 命名期
 *     任务名，改名后由后端注册 SkyAlyticWingGateway 接管）。 */
function cleanupLegacyAutostart() {
  var startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  var legacyFiles = [
    // 上一版 SkyalyticClaw 命名产物
    'skyalyticclaw-gateway.cmd',
    'skyalyticclaw-gateway.vbs',
    'skyalyticclaw-hidden.vbs',
    'skyalyticclaw.cmd',
    'SkyAlyticClaw.lnk',
    // 新命名重装场景的历史形态
    'skyalyticwing-gateway.cmd',
    'skyalyticwing-hidden.vbs',
    'skyalyticwing.cmd',
    'SkyAlyticWing.lnk',
  ];
  var cleaned = 0;
  legacyFiles.forEach(function(name) {
    var f = path.join(startupDir, name);
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); cleaned++; } } catch(e) { /* 文件被锁定等，忽略 */ }
  });
  if (cleaned > 0) ok('Removed ' + cleaned + ' legacy autostart entries from Startup folder');
  // 历史计划任务（execSync 经 cmd.exe 执行，>nul 重定向有效；任务不存在时非零退出属正常）
  ['Skyalyticclaw Gateway', 'SkyAlyticClawGateway', 'SkyAlyticWingGateway'].forEach(function(tn) {
    try {
      execSync('schtasks /delete /tn "' + tn + '" /f >nul 2>&1', { timeout: 10000 });
      ok('Removed legacy scheduled task "' + tn + '"');
    } catch(e) { /* 任务不存在，无需清理 */ }
  });
}

function createWindowsCommand() {
  const registered = require('./cli-registration.cjs').installWindows();
  if (EDITION && CLI_COMMAND !== 'skyalyticwing') {
    for (const name of ['skyalyticwing.cmd', 'skyalyticwing']) {
      const generic = path.join(BIN_DIR, name);
      if (fs.existsSync(generic) && !fs.lstatSync(generic).isSymbolicLink() && fs.readFileSync(generic,'utf8').includes('skyalyticwing.cjs')) fs.unlinkSync(generic);
    }
  }
  for (const file of registered) ok('Created: ' + file);
}

console.log('\n+==========================================+');
console.log('|   SkyalyticWing Setup                    |');
console.log('+==========================================+\n');

installDeps();

console.log('\n--- Register CLI command ---\n');

if (IS_WIN) {
  createWindowsCommand();
  if (!EDITION) cleanupLegacyAutostart();
}

addToUserPath(BIN_DIR);

ok('Installation complete! Reopen terminal and run: ' + CLI_COMMAND + ' help');
