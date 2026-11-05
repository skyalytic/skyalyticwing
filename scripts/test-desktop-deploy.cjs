// Acceptance against the actual bundled Node and installed backend, isolated from user data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const deploy = path.resolve(process.argv[2]);
const runtime = path.resolve(process.argv[3]);
require('./test-bundled-ffmpeg.cjs').verify(path.join(deploy,'vendor','ffmpeg'));
const port = Number(process.argv[4] || 19229);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-release-check-'));
const token = randomBytes(32).toString('hex');
let child;
let errors = '';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => nativeFetch(url, {...options, signal: options.signal || AbortSignal.timeout(15000)});
const watchdog = setTimeout(() => {
  console.error('Packaged backend acceptance timed out', errors);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exit(1);
}, 240000);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => ['path','systemroot','comspec','temp','tmp','pathext','home'].includes(k.toLowerCase()))),
  SKYALYTICWING_DATA_DIR: data, APPDATA: data, LOCALAPPDATA: data, XDG_CONFIG_HOME: data,
  SKYALYTICWING_AUTH_TOKEN: token,
  SKYALYTICWING_REGISTER_CLI: '0',
};
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const base = `http://127.0.0.1:${port}`;
async function start() {
  console.log('Checking packaged backend startup');
  child = spawn(runtime, [path.join(deploy,'desktop-main.cjs'),'--port',String(port)], {cwd:data, env, windowsHide:true, stdio:['ignore','pipe','pipe']});
  child.stdout.on('data', b => { errors = (errors + b.toString()).slice(-4000); });
  child.stderr.on('data', b => { errors = (errors + b.toString()).slice(-4000); });
  // Use the same deadline as src-tauri/src/lib.rs, including cold disk caches.
  const started = Date.now();
  while (Date.now() - started < 120000) {
    if (child.exitCode !== null) throw new Error(`Bundled runtime exited (${child.exitCode})`);
    if (await fetch(base+'/health', {signal:AbortSignal.timeout(2000)}).then(r=>r.ok).catch(()=>false)) return;
    await new Promise(r=>setTimeout(r,1000));
  }
  throw new Error('Bundled runtime did not become healthy');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const target = child;
  console.log('Checking packaged backend shutdown');
  let timer;
  const stopped = new Promise(resolve=>target.once('exit',resolve));
  target.kill();
  try {
    await Promise.race([stopped, new Promise((_, reject) => {
      timer = setTimeout(() => { target.kill('SIGKILL'); reject(new Error('Bundled runtime did not stop within 15 seconds')); }, 15000);
    })]);
  } finally { clearTimeout(timer); }
}
(async()=>{
  try {
    await start();
    assert.equal((await fetch(base+'/api/config')).status,401);
    assert.equal((await fetch(base+'/api/config',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(base+'/api/config',{headers:{...headers,Origin:'http://localhost:1420'}})).status,403);
    const page = await fetch(base+'/');
    assert.equal(page.status,200);
    const html = await page.text();
    assert.ok(html.includes('<html'));
    const js = html.match(/src="([^"\s]+\.js)"/);
    assert.ok(js, 'Built frontend must contain its JavaScript asset');
    assert.equal((await fetch(new URL(js[1],base))).status,200);
    assert.equal((await fetch(base+'/account')).status,200);
    const config = await fetch(base+'/api/config',{headers}).then(r=>r.json());
    assert.ok(config.success);
    const saved = await fetch(base+'/api/config/releaseAcceptance',{method:'PUT',headers,body:JSON.stringify({persisted:true})}).then(r=>r.json());
    assert.ok(saved.success);
    const acpSaved = await fetch(base+'/api/acp',{method:'PUT',headers,body:JSON.stringify({maxConcurrentSessions:7})}).then(r=>r.json());
    assert.ok(acpSaved.success);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data,'acp.json'),'utf8')).maxConcurrentSessions,7);
    // Exercise the real HTTP routes in the packaged runtime without connecting external accounts.
    const channelList = await fetch(base+'/api/channels',{headers}).then(r=>r.json());
    assert.deepEqual(channelList.data.map(c=>c.type).sort(),['weixin','wechat-work','dingtalk','feishu','email','sms','cli','webchat'].sort());
    const saveChannel = (id, value) => fetch(base+'/api/channels/'+id,{method:'PUT',headers,body:JSON.stringify(value)});
    const disabledWeixin = await saveChannel('weixin',{enabled:false,credentials:{botToken:'isolated-acceptance-token',baseUrl:'https://example.invalid'}}).then(r=>r.json());
    assert.equal(disabledWeixin.data.channel.enabled,false);
    assert.equal(disabledWeixin.data.channel.status,'disconnected');
    const safeConfig = await fetch(base+'/api/channels/weixin/config',{headers}).then(r=>r.json());
    assert.ok(safeConfig.data.configuredSecrets.includes('botToken'));
    assert.ok(!JSON.stringify(safeConfig).includes('isolated-acceptance-token'));
    const editedWeixin = await saveChannel('weixin',{enabled:false,credentials:{baseUrl:'https://example.invalid/edited'}});
    assert.equal(editedWeixin.status,200);
    const enabledCli = await saveChannel('cli',{enabled:true}).then(r=>r.json());
    assert.equal(enabledCli.data.channel.status,'connected');
    const disabledCli = await saveChannel('cli',{enabled:false}).then(r=>r.json());
    assert.equal(disabledCli.data.channel.status,'disconnected');
    await saveChannel('webchat',{enabled:true});
    assert.equal((await saveChannel('not-a-channel',{enabled:false})).status,404);
    assert.equal((await saveChannel('email',{enabled:true})).status,400);
    assert.equal((await saveChannel('sms',{enabled:true})).status,400);
    await stop();
    await start();
    const restored = await fetch(base+'/api/config/releaseAcceptance',{headers}).then(r=>r.json());
    assert.equal(restored.data?.value?.persisted,true);
    const acpRestored = await fetch(base+'/api/acp/status',{headers}).then(r=>r.json());
    assert.equal((acpRestored.data || acpRestored).maxConcurrentSessions,7);
    const restoredChannel = await fetch(base+'/api/channels/weixin/config',{headers}).then(r=>r.json());
    assert.ok(restoredChannel.data.configuredSecrets.includes('botToken'));
    const restoredChannelStatus = await fetch(base+'/api/channels/status',{headers}).then(r=>r.json());
    assert.equal(restoredChannelStatus.data.weixin.enabled,false);
    assert.equal(restoredChannelStatus.data.weixin.connected,false);
    assert.equal(restoredChannelStatus.data.webchat.connected,true);
    console.log('PASS: eight retained channels, first-save persistence, secret-preserving edits, enable/disable lifecycle, restart restoration, unsupported providers rejected');
    console.log('PASS: bundled Node, clean startup, production origin guard, token protection, frontend assets, SPA routes, writable user state and restart persistence');
    await stop();
    // Reproduce the installed-machine failure: broken primary, absent .bak.
    const damaged = '{interrupted-session-write';
    fs.writeFileSync(path.join(data, 'sessions.json'), damaged);
    fs.rmSync(path.join(data, 'sessions.json.bak'), {force:true});
    await start();
    const recoveryResponse = await fetch(base+'/api/sessions/recovery',{headers}).then(r=>r.json());
    const recovery = recoveryResponse.data;
    assert.ok(recovery?.archiveDirectory);
    assert.equal(fs.readFileSync(path.join(recovery.archiveDirectory,'sessions.json'),'utf8'),damaged);
    const newSession = await fetch(base+'/api/sessions',{method:'POST',headers,body:JSON.stringify({title:'Recovered startup'})}).then(r=>r.json());
    assert.ok(newSession.data?.id);
    await stop();
    await start();
    const restoredSessions = await fetch(base+'/api/sessions',{headers}).then(r=>r.json());
    assert.ok(restoredSessions.data.some(s=>s.id===newSession.data.id));
    assert.equal(fs.readFileSync(path.join(recovery.archiveDirectory,'sessions.json'),'utf8'),damaged);
    console.log('PASS: corrupt sessions without backup no longer crash startup; originals preserved, new sessions survive restart');
  } finally {
    await stop();
    fs.rmSync(data,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e.message);if(errors)console.error(errors);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
