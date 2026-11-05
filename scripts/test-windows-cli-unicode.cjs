'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {installWindows,uninstallWindows}=require('../packages/web/bin/cli-registration.cjs');
if(process.platform!=='win32'){console.log('SKIP Windows console regression');process.exit(0);}
const home=fs.mkdtempSync(path.join(os.tmpdir(),'wing-cli-unicode-'));
try {
  const root=path.join(home,'中文 企业版 ! 目录'),bin=path.join(root,'_up_','packages','web','bin'),npmDir=path.join(home,'npm');
  fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(npmDir);
  fs.copyFileSync(process.execPath,path.join(root,'node.exe'));
  fs.writeFileSync(path.join(bin,'skyalyticwing.cjs'),"console.log('ARGV='+Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'));process.exitCode=37;\n");
  const driver=path.join(home,'driver.cmd');
  fs.writeFileSync(driver,['@echo off','chcp %WING_TEST_CP% >nul','call "%WING_TEST_SHIM%" cli "%WING_TEST_ARG%" "two words" "x&y" "x!y"','set "WING_TEST_EXIT=%ERRORLEVEL%"','chcp','exit /b %WING_TEST_EXIT%',''].join('\r\n'));
  for(const command of ['skyalyticwing','wing']){
    const options={bin,npmDir,commands:[command]};
    const files=installWindows(options);
    assert.equal(files.length,2);
    for(const file of files)for(const cp of ['936','65001']){
      const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/v:off','/c',driver],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,WING_TEST_CP:cp,WING_TEST_SHIM:file,WING_TEST_ARG:'文宇与企业版'}});
      assert.equal(result.status,37,result.stderr||result.stdout||String(result.error));
      const encoded=result.stdout.match(/ARGV=([A-Za-z0-9+/=]+)/)?.[1];
      assert.ok(encoded,result.stdout);
      assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64').toString()),['cli','文宇与企业版','two words','x&y','x!y']);
      assert.ok(result.stdout.trim().endsWith(cp),'Caller code page was not restored: '+result.stdout);
    }
    uninstallWindows(options);
    for(const file of files)assert.equal(fs.existsSync(file),false);
  }
  console.log('PASS real Windows CLI: Chinese installation paths, local/npm entries, GBK/UTF-8 consoles, Unicode arguments, exit status and code-page restoration');
} finally {
  if(path.dirname(home)!==os.tmpdir()||!path.basename(home).startsWith('wing-cli-unicode-'))throw Error('Unexpected fixture root');
  fs.rmSync(home,{recursive:true,force:true});
}
