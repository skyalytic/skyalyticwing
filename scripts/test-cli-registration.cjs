const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { install, uninstall } = require('../packages/web/bin/cli-registration.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-cli-lifecycle-'));
const bin = path.join(home, "中文 App's $data", 'bin');
const options = {home,bin,node:path.join(home,'bundled node'),image:''};
fs.writeFileSync(path.join(home,'.zshrc'), 'export CUSTOM=value\n');
const command = install(options);
const first = fs.readFileSync(path.join(home,'.zshrc'),'utf8');
install(options);
assert.equal(fs.existsSync(path.join(home,'.bash_profile')),false);
assert.equal(fs.readFileSync(path.join(home,'.zshrc'),'utf8'), first);
assert.ok(fs.readFileSync(command,'utf8').includes("'\\''"));
const newer = {...options,bin:path.join(home,'new install')};
install(newer);
assert.equal(uninstall(options),false);
assert.ok(fs.existsSync(command));
assert.equal(uninstall(newer),true);
assert.equal(fs.existsSync(command),false);
assert.equal(fs.readFileSync(path.join(home,'.zshrc'),'utf8'),'export CUSTOM=value\n');
fs.writeFileSync(command, '#!/bin/sh\n# unrelated command\n');
assert.throws(()=>install(options),/not managed/);
assert.equal(uninstall(options),false);
fs.unlinkSync(command);
install({...options,image:path.join(home,'Wing.AppImage')});
assert.ok(fs.readFileSync(command,'utf8').includes('--wing-cli "$@"'));
assert.ok(!fs.readFileSync(command,'utf8').includes('/tmp/.mount_'));
uninstall({...options,image:path.join(home,'Wing.AppImage')});

// Windows lifecycle executes against an isolated filesystem with registry/process
// access mocked; no changes to the developer's PATH or installed command.
const winBin=path.join(home,'windows','_up_','packages','web','bin');
if (process.platform === 'win32') {
const appData=path.join(home,'appdata');
const winCommand=require('../packages/web/bin/product-edition.cjs').product().cliCommand;
fs.mkdirSync(winBin,{recursive:true});fs.mkdirSync(path.join(appData,'npm'),{recursive:true});
fs.writeFileSync(path.resolve(winBin,'../../../..','node.exe'),'fixture');
let powershell = '';
function windowsScript(name) {
  const source=path.resolve(__dirname,'../packages/web/bin',name), baseRequire=createRequire(source);
  const child={
    execSync(command){if(command.startsWith('reg query'))return 'Path REG_EXPAND_SZ C:\\original';return '';},
    spawnSync(command,args){if(command==='powershell.exe')powershell=fs.readFileSync(args[args.length-1],'utf8');return {status:0,stdout:name==='install.cjs'?'PATH_ADDED':'REMOVED'};},
  };
  const registration = baseRequire('./cli-registration.cjs');
  const isolated = {bin:winBin,npmDir:path.join(appData,'npm'),commands:[winCommand]};
  const requireMock=name=>name==='./cli-registration.cjs'?{
    installWindows:()=>registration.installWindows(isolated),
    uninstallWindows:()=>registration.uninstallWindows(isolated),
  }:name==='os'?{...os,platform:()=> 'win32'}:name==='child_process'?child:baseRequire(name);
  const run=vm.runInNewContext('(function(require,__dirname,process,console){'+fs.readFileSync(source,'utf8').replace(/^#![^\n]*\n/, '')+'\n})');
  run(requireMock,winBin,{env:{APPDATA:appData}}, {log(){},error(){}});
}
windowsScript('install.cjs');
assert.ok(powershell.includes('GetEnvironmentVariable("Path", "User")'));
const npmCmd=path.join(appData,'npm',winCommand+'.cmd');
assert.ok(fs.existsSync(npmCmd));assert.ok(fs.existsSync(path.join(winBin,winCommand+'.cmd')));
windowsScript('uninstall.cjs');
assert.ok(powershell.includes('SetEnvironmentVariable("Path",$np,"User")'));
assert.equal(fs.existsSync(npmCmd),false);
windowsScript('install.cjs');fs.writeFileSync(npmCmd,'another installation');
windowsScript('uninstall.cjs');assert.equal(fs.readFileSync(npmCmd,'utf8'),'another installation');
const realSpawn = require('node:child_process').spawnSync;
for (const [running, expected] of [[false,0],[true,1]]) {
  const guardFixture=path.join(home,'guard-'+running+'.ps1');
  const checker=path.resolve(__dirname,'../packages/web/bin/check-closed.ps1').replaceAll("'","''");
  fs.writeFileSync(guardFixture, `\ufefffunction Get-Process { [CmdletBinding()] param([string[]]$Name) }\nfunction Get-CimInstance { param($Filter) [pscustomobject]@{ExecutablePath='C:\\${running?'Wing':'Other'}\\node.exe'} }\nfunction Start-Sleep { param($Milliseconds) }\n& '${checker}' -InstallDirectory 'C:\\Wing'\nexit $LASTEXITCODE\n`);
  const result=realSpawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',guardFixture],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,expected,result.stderr);
}
}
console.log('PASS CLI install/uninstall: idempotency, shell PATH cleanup, ownership, quoted paths, AppImage stable entry, Windows registry/shim lifecycle');
