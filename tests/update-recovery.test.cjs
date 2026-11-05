const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync,spawnSync,spawn} = require('node:child_process');
const recovery = require('../scripts/update-recovery.cjs');
const {releaseConfig,assertPublish} = require('../scripts/release-config.cjs');
test('release version is unified and publication is denied before touching server', t => {
  assert.equal(releaseConfig().version,JSON.parse(fs.readFileSync('package.json','utf8')).version);
  const base=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'wing-release-policy-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.mkdirSync(path.join(base,'src-tauri'));fs.mkdirSync(path.join(base,'config'));
  fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({version:'9.9.9'}));
  fs.writeFileSync(path.join(base,'src-tauri/tauri.conf.json'),JSON.stringify({version:'9.9.9'}));
  fs.writeFileSync(path.join(base,'src-tauri/Cargo.toml'),'[package]\nversion = "9.9.9"\n');
  fs.writeFileSync(path.join(base,'config/release-policy.json'),JSON.stringify({version:'9.9.9',publicReleaseAllowed:false,updateFeedAllowed:false}));
  // Never invoke a real publish script: the working tree may hold an approved release policy.
  assert.throws(()=>assertPublish('9.9.9',base),/Release blocked/);
  for (const name of ['installer.nsi','installer.ui-offline.nsi']) {
    const code=fs.readFileSync(path.resolve('src-tauri/windows',name),'utf8');
    assert.match(code,/!define VERSION "\{\{version\}\}"/);
    assert.doesNotMatch(code,/!define VERSION "2\.0\.0"/);
    assert.match(code,/Function \.onInstFailed/);
    assert.doesNotMatch(code,/!insertmacro CheckIfAppIsRunning/);
  }
});
test('independent recovery process restores a failed update without the Wing shell or backend', async () => {
  const base=fs.mkdtempSync(path.resolve('build/update-safety-qa/watchdog-'));
  const app=path.join(base,'app'),data=path.join(base,'data'),dir=path.join(base,'updates','standalone-test');
  for(const p of [app,data,dir])fs.mkdirSync(p,{recursive:true});
  const exe=path.join(app,process.platform==='win32'?'Wing.exe':'Wing');
  fs.copyFileSync(process.platform==='win32'?path.join(process.env.SystemRoot,'System32/whoami.exe'):'/usr/bin/true',exe);
  fs.chmodSync(exe,0o755);fs.writeFileSync(path.join(data,'chat.json'),'before');
  recovery.prepare({transactionDir:dir,installRoot:app,executable:exe,dataDirs:[data],version:'2.0.2',previousVersion:'2.0.1'});
  fs.writeFileSync(exe,'broken executable');fs.writeFileSync(path.join(data,'chat.json'),'migration');recovery.phase(dir,'failed');
  const node=path.join(dir,process.platform==='win32'?'recovery-node.exe':'recovery-node');
  const child=spawn(node,[path.join(dir,'recovery.cjs'),'watch',dir],{windowsHide:true,stdio:'pipe'});
  let logs='';child.stderr.on('data',b=>logs+=b);
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Watchdog timeout '+logs));},30_000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});child.once('error',reject);});
  assert.equal(code,0,logs);assert.equal(recovery.load(dir).status,'rolled-back');
  assert.equal(fs.readFileSync(path.join(data,'chat.json'),'utf8'),'before');
  assert.equal(fs.readFileSync(data+'.wing-failed-standalone-test/chat.json','utf8'),'migration');
  assert.ok(fs.statSync(exe).size>1000);
});
test('verified snapshot restores failed program and data, retaining failed files; corrupt backups fail closed', () => {
  const base=fs.mkdtempSync(path.resolve('build/update-safety-qa/transaction-'));
  const app=path.join(base,'app'), data=path.join(base,'userdata'), dir=path.join(base,'updates','transaction-1');
  for(const p of [app,data,dir]) fs.mkdirSync(p,{recursive:true});
  fs.writeFileSync(path.join(app,'Wing.exe'),'old-app'); fs.writeFileSync(path.join(data,'session.json'),'old-chat');
  recovery.prepare({transactionDir:dir,installRoot:app,executable:path.join(app,'Wing.exe'),dataDirs:[data],version:'2.0.2',previousVersion:'2.0.1'});
  fs.writeFileSync(path.join(app,'Wing.exe'),'broken-update');fs.writeFileSync(path.join(data,'session.json'),'new-migration');
  recovery.phase(dir,'failed');
  const snapshot=path.join(dir,'snapshot-0','Wing.exe');fs.writeFileSync(snapshot,'corrupt');
  assert.throws(()=>recovery.restore(dir),/verification/);
  assert.equal(fs.readFileSync(path.join(app,'Wing.exe'),'utf8'),'broken-update');
  fs.writeFileSync(snapshot,'old-app');
  // Resume a copy interrupted by power loss without trusting the incomplete staging tree.
  const staging=app+'.wing-restore-transaction-1';
  fs.mkdirSync(staging);fs.writeFileSync(path.join(staging,'Wing.exe'),'partial-copy');
  const result=recovery.restore(dir);
  assert.ok(fs.readdirSync(base).some(name=>name.startsWith('app.wing-restore-transaction-1.partial-')));
  assert.equal(result.status,'rolled-back');assert.equal(fs.readFileSync(path.join(app,'Wing.exe'),'utf8'),'old-app');
  assert.equal(fs.readFileSync(path.join(data,'session.json'),'utf8'),'old-chat');
  assert.equal(fs.readFileSync(app+'.wing-failed-transaction-1/Wing.exe','utf8'),'broken-update');
  assert.equal(fs.readFileSync(data+'.wing-failed-transaction-1/session.json','utf8'),'new-migration');
  assert.throws(()=>recovery.restore(dir),/eligible/);
  // Simulate power loss after the last atomic rename but before final completion.
  const j=JSON.parse(fs.readFileSync(path.join(dir,'journal.json')));j.status='restoring';
  fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify(j));
  assert.equal(recovery.restore(dir).status,'rolled-back');
  recovery.healthy(dir,'2.0.3',process.pid); assert.equal(fs.existsSync(path.join(dir,'healthy.json')),false);
  assert.throws(()=>recovery.safeRoot(path.parse(base).root),/root/);
  // Verify the independently copied Node/helper still run when original app is unavailable.
  execFileSync(path.join(dir,process.platform==='win32'?'recovery-node.exe':'recovery-node'),[path.join(dir,'recovery.cjs'),'phase',dir,'cancelled']);
});
