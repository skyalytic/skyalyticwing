#!/usr/bin/env node
var path = require('path');
var fs = require('fs');
var os = require('os');
var execSync = require('child_process').execSync;
var spawnSync = require('child_process').spawnSync;

var BIN_DIR = path.resolve(__dirname);
var IS_WIN = os.platform() === 'win32';
var EDITION = require('./product-edition.cjs').product();
var CLI_COMMAND = EDITION ? EDITION.cliCommand : 'skyalyticwing';
if (!IS_WIN) {
  try { require('./cli-registration.cjs').uninstall(); console.log('Wing CLI registration removed.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  return;
}

function ok(t) { console.log('\x1b[32m+ ' + t + '\x1b[0m'); }
function info(t) { console.log('\x1b[36mi ' + t + '\x1b[0m'); }
function warn(t) { console.log('\x1b[33m! ' + t + '\x1b[0m'); }

/** 经临时 .ps1 文件执行 PowerShell 脚本（spawnSync 参数数组直达 powershell.exe）。
 *  旧实现经 cmd.exe 内联 -Command 并转义引号，曾导致 PowerShell 挂起 → 30s 超时
 *  → 只杀掉外层 cmd.exe，孤儿 powershell.exe 拖住卸载终端无法关闭。
 *  改为 -File + -NonInteractive + windowsHide：不经 cmd.exe 无转义问题、
 *  不会进入交互模式读 stdin、超时时直接杀 powershell.exe 本体。 */
function runPowerShell(psScript, timeoutMs) {
  var tmpFile = path.join(os.tmpdir(), 'skyalyticwing-uninstall-' + Date.now() + '-' + Math.floor(Math.random() * 1000000) + '.ps1');
  // UTF-8 BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI(GBK) 解码，中文用户名路径会变乱码
  fs.writeFileSync(tmpFile, '\ufeff' + psScript, 'utf8');
  try {
    var r = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { encoding: 'utf8', timeout: timeoutMs || 30000, windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw Error('PowerShell PATH removal failed: ' + (r.stderr || r.status));
    return (r.stdout || '').trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* 临时文件清理失败不影响流程 */ }
  }
}

function removeFromUserPath(dirToRemove) {
  if (IS_WIN) {
    var normalizedDir = dirToRemove.replace(/\//g, '\\');
    try {
      var psScript = "$d='" + normalizedDir.replace(/'/g, "''") + "';" + '$p=[System.Environment]::GetEnvironmentVariable("Path","User");if($p){$entries=$p -split ";" | Where-Object {$_.TrimEnd("\\").ToLower() -ne $d.TrimEnd("\\").ToLower()};$np=$entries -join ";";[System.Environment]::SetEnvironmentVariable("Path",$np,"User");Write-Host "REMOVED"}else{Write-Host "NO_PATH"}';
      var result = runPowerShell(psScript, 30000);
      if (result.indexOf('REMOVED') >= 0) {
        ok('Removed from user PATH: ' + normalizedDir);
      }
    } catch(e) {
      warn('PowerShell PATH removal failed: ' + (e && e.message ? e.message : String(e)));
      try {
        var regOutput = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8', timeout: 5000 });
        var match = regOutput.match(/Path\s+REG_\w+\s+(.*)/);
        if (match) {
          var currentPath = match[1].trim();
          var entries = currentPath.split(';').filter(function(p) {
            return p.trim().toLowerCase().replace(/\\$/, '') !== normalizedDir.toLowerCase().replace(/\\$/, '');
          });
          var newPath = entries.join(';');
          var result = spawnSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', newPath, '/f'], { timeout: 10000, windowsHide: true });
          if (result.error || result.status !== 0) throw Error('Registry PATH removal failed');
          ok('Removed from user PATH (fallback)');
        }
      } catch(e2) {
        warn('Registry PATH removal also failed: ' + e2.message);
      }
    }

    require('./cli-registration.cjs').uninstallWindows();

  } else {
    var targets = ['/usr/local/bin/skyalyticwing', path.join(os.homedir(), '.local', 'bin', 'skyalyticwing')];
    targets.forEach(function(f) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });

    var homeDir = os.homedir();
    var shellRc = os.platform() === 'darwin'
      ? (fs.existsSync(path.join(homeDir, '.zshrc')) ? path.join(homeDir, '.zshrc') : path.join(homeDir, '.bash_profile'))
      : (fs.existsSync(path.join(homeDir, '.bashrc')) ? path.join(homeDir, '.bashrc') : path.join(homeDir, '.profile'));

    if (fs.existsSync(shellRc)) {
      try {
        var rcContent = fs.readFileSync(shellRc, 'utf-8');
        var lines = rcContent.split('\n').filter(function(line) {
          return line.indexOf('SkyalyticWing CLI') < 0 && line.indexOf(BIN_DIR) < 0;
        });
        fs.writeFileSync(shellRc, lines.join('\n'));
        ok('Removed PATH entry from ' + shellRc);
      } catch(e) {}
    }
    ok('Removed skyalyticwing command');
  }
}

/** 清理网关自启残留（含历史各版命名与降级入口）：
 *  卸载后安装目录即被删除，任何残留自启入口都指向失效路径，
 *  下次登录会空跑甚至闪错误窗口，全部清掉保证系统干净。
 *  历史三代任务名都删：最旧「Skyalyticclaw Gateway」（带空格）、
 *  「SkyAlyticClawGateway」（SkyalyticClaw 命名期）、
 *  当前「SkyAlyticWingGateway」（SkyalyticWing 命名，daemon 服务注册）——
 *  卸载即代表不再需要网关自启，重装后可在应用内重新开启。 */
function cleanupGatewayAutostart() {
  var startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  // 两代命名全形态：当前 SkyalyticWing + 上一版 SkyalyticClaw（升级残留）
  ['skyalyticwing-gateway.cmd', 'skyalyticwing-gateway.vbs', 'skyalyticwing-hidden.vbs', 'skyalyticwing.cmd', 'SkyAlyticWing.lnk',
   'skyalyticclaw-gateway.cmd', 'skyalyticclaw-gateway.vbs', 'skyalyticclaw-hidden.vbs', 'skyalyticclaw.cmd', 'SkyAlyticClaw.lnk'].forEach(function(name) {
    var f = path.join(startupDir, name);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) { /* 忽略锁定等 */ }
  });
  ['Skyalyticclaw Gateway', 'SkyAlyticClawGateway', 'SkyAlyticWingGateway'].forEach(function(tn) {
    try { execSync('schtasks /delete /tn "' + tn + '" /f >nul 2>&1', { timeout: 10000 }); } catch(e) { /* 任务不存在，无需清理 */ }
  });
  // 上一版桌面端自启注册表键（tauri-plugin-autostart 按 productName 写 HKCU Run），
  // 旧桌面端卸载后键可能残留（指向失效 exe），一并清掉
  ['SkyalyticClaw', 'skyalyticclaw', 'com.skyalyticclaw.desktop'].forEach(function(v) {
    try { execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "' + v + '" /f >nul 2>&1', { timeout: 10000 }); } catch(e) { /* 键不存在 */ }
  });
  ok('Cleaned gateway autostart entries');
}

removeFromUserPath(BIN_DIR);
if (IS_WIN) {
  if (!EDITION) cleanupGatewayAutostart();
}
info('Uninstall complete');
