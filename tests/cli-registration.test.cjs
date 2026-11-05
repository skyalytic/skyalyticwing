'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const cli = require('../packages/web/bin/cli-registration.cjs');
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'wing-cli-coexist-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const npmDir=path.join(home,'shared npm');fs.mkdirSync(npmDir);
  const a={home,bin:path.join(home,'personal app'),node:process.execPath,npmDir,commands:['skyalyticwing','wing-community']};
  const b={home,bin:path.join(home,'enterprise app'),node:process.execPath,npmDir,commands:['wing','wing-enterprise']};
  for(const [options,edition] of [[a,'community'],[b,'enterprise']]) {
    fs.mkdirSync(options.bin);
    fs.writeFileSync(path.join(options.bin,'skyalyticwing.cjs'),'console.log(JSON.stringify({edition:'+JSON.stringify(edition)+',args:process.argv.slice(2)}));');
  }
  return {home,npmDir,a,b};
}
test('Unix primary commands and compatibility aliases coexist in either install order',t=>{
  const {home,a,b}=fixture(t);
  for(const order of [[a,b],[b,a]]) {
    for(const options of order)cli.install(options);
    const other=fs.readFileSync(path.join(home,'.local/bin/wing'),'utf8');
    cli.uninstall(a);
    assert.equal(fs.existsSync(path.join(home,'.local/bin/skyalyticwing')),false);
    assert.equal(fs.existsSync(path.join(home,'.local/bin/wing-community')),false);
    assert.equal(fs.readFileSync(path.join(home,'.local/bin/wing'),'utf8'),other);
    assert.match(fs.readFileSync(path.join(home,'.profile'),'utf8'),/SkyalyticWing CLI/);
    cli.uninstall(b);
    assert.doesNotMatch(fs.readFileSync(path.join(home,'.profile'),'utf8'),/SkyalyticWing CLI/);
  }
});
test('Windows install/uninstall owns both its commands without removing the other edition',t=>{
  const {npmDir,a,b}=fixture(t);
  for(const order of [[a,b],[b,a]]) {
    for(const options of order)cli.installWindows(options);
    cli.installWindows(a);
    const enterprise=fs.readFileSync(path.join(npmDir,'wing.cmd'),'utf8');
    assert.ok(enterprise.includes(path.join(b.bin,'skyalyticwing.cjs')));
    cli.uninstallWindows(a);
    for(const name of a.commands)assert.equal(fs.existsSync(path.join(npmDir,name+'.cmd')),false);
    assert.equal(fs.readFileSync(path.join(npmDir,'wing.cmd'),'utf8'),enterprise);
    cli.uninstallWindows(b);
  }
});
test('registration refuses unrelated commands and uninstall leaves them intact',t=>{
  const {a,npmDir}=fixture(t),file=path.join(npmDir,'skyalyticwing.cmd');
  fs.writeFileSync(file,'@echo unrelated app');
  assert.throws(()=>cli.installWindows(a),/another installation/);
  assert.equal(fs.existsSync(path.join(a.bin,'skyalyticwing.cmd')),false);
  cli.uninstallWindows(a);
  assert.equal(fs.readFileSync(file,'utf8'),'@echo unrelated app');
});
test('a packaged relative Windows shim can be replaced by its installed absolute dispatcher',t=>{
  const {a}=fixture(t),file=path.join(a.bin,'skyalyticwing.cmd');
  fs.writeFileSync(file,'@echo off\r\nnode "%~dp0skyalyticwing.cjs" %*\r\n');
  cli.installWindows(a);
  assert.ok(fs.readFileSync(file,'utf8').includes('"'+path.join(a.bin,'skyalyticwing.cjs')+'"'));
});
test('Windows short commands execute their own dispatcher and forward cli arguments',{skip:process.platform!=='win32'},t=>{
  const {a,b}=fixture(t);
  for(const [options,edition] of [[a,'community'],[b,'enterprise']]) {
    const files=cli.installWindows(options);
    for(const name of options.commands) {
      const file=files.find(f=>path.dirname(f)===options.npmDir&&path.basename(f)===name+'.cmd');
      const result=spawnSync('cmd.exe',['/d','/s','/c','""'+file+'" cli --help"'],{encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:10000});
      assert.equal(result.status,0,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout.trim()),{edition,args:['cli','--help']});
    }
  }
});
