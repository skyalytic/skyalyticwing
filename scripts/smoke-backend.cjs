const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = mkdtempSync(path.join(require('node:os').tmpdir(), 'sky-startup-'));
console.log('Isolated smoke data:', base);
mkdirSync(base, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function start(port, label) {
  const data = path.join(base, label);
  mkdirSync(data, { recursive: true });
  const env = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'COMSPEC',
    'TEMP',
    'TMP',
    'PATHEXT',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(port),
    SKYALYTICWING_DATA_DIR: data,
    SKYALYTICWING_WEB_DATA_DIR: data,
    APPDATA: data,
    LOCALAPPDATA: data,
    SKYALYTICWING_AUTH_TOKEN: 'startup-test-only',
  });
  const child = spawn(process.execPath, [path.join(root, 'packages/backend/dist/main.js')], {
    cwd: data,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return {
    child,
    output: () => output,
    log: () => writeFileSync(path.join(base, `startup-${label}.log`), output),
  };
}
(async () => {
  const occupant = createServer((_req, res) => res.end('occupant-still-alive'));
  await new Promise((r) => occupant.listen(0, '127.0.0.1', r));
  const port = occupant.address().port;
  let running;
  try {
    running = start(port, 'occupied');
    const deadline = Date.now() + 60000;
    while (running.child.exitCode === null && Date.now() < deadline) await delay(200);
    assert.notEqual(running.child.exitCode, null, 'startup must exit on port conflict');
    assert.notEqual(running.child.exitCode, 0, 'port conflict must fail startup');
    assert.match(
      running.output(),
      /EADDRINUSE|is already in use/,
      'must reach the actual port conflict',
    );
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'occupant-still-alive');
    running.log();
    await new Promise((r) => occupant.close(r));
    console.log('PASS: occupied port preserved; backend exited with failure.');
    running = start(port, 'normal');
    let healthy = false;
    const readyDeadline = Date.now() + 60000;
    while (Date.now() < readyDeadline && running.child.exitCode === null) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {}
      if (healthy) break;
      await delay(250);
    }
    assert.equal(healthy, true, 'backend health check');
    const url = `http://127.0.0.1:${port}/API/tools`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { Authorization: 'Bearer startup-test-only' } })).status,
      200,
    );
    assert.equal(
      (await fetch(url, { headers: { Origin: 'https://attacker.example' } })).status,
      403,
    );
    console.log('PASS: real backend health, token auth, uppercase route and origin restriction.');
  } finally {
    running?.log();
    running?.child.kill();
    occupant.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
