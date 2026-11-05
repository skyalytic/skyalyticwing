/** Verify a built, self-contained server bundle without repository cwd/module fallback. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const deploy = path.resolve(process.argv[2] || 'packages/backend/deploy');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-deployment-acceptance-'));
const token = randomBytes(32).toString('hex');
let child,
  output = '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop() {
  if (!child || child.exitCode !== null) return;
  const running = child;
  const exited = new Promise((resolve) => running.once('exit', resolve));
  running.kill();
  await exited;
}
(async () => {
  assert.ok(fs.existsSync(path.join(deploy, 'dist/main.js')));
  assert.ok(fs.existsSync(path.join(deploy, 'frontend/index.html')));
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const url = 'http://127.0.0.1:' + port;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['path', 'systemroot', 'comspec', 'temp', 'tmp', 'pathext'].includes(key.toLowerCase()),
    ),
  );
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(port),
    SKYALYTICWING_HOST: '127.0.0.1',
    SKYALYTICWING_AUTH_TOKEN: token,
    SKYALYTICWING_DATA_DIR: temp,
    SKYALYTICWING_WEB_DATA_DIR: temp,
    APPDATA: temp,
    LOCALAPPDATA: temp,
  });
  async function start() {
    child = spawn(process.execPath, [path.join(deploy, 'dist/main.js')], {
      cwd: temp,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (bytes) => {
      output = (output + bytes).slice(-3000);
    });
    child.stderr.on('data', (bytes) => {
      output = (output + bytes).slice(-3000);
    });
    for (let i = 0; i < 90; i++) {
      if (child.exitCode !== null) throw new Error('Deployment process exited: ' + output);
      try {
        if ((await fetch(url + '/health', { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch {}
      await delay(1000);
    }
    throw new Error('Deployment did not become healthy: ' + output);
  }
  const call = (route, init = {}) =>
    fetch(url + route, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(10000),
    });
  await start();
  assert.equal((await fetch(url + '/api/automation/media/video-tasks')).status, 401);
  assert.equal(
    (
      await call('/api/automation/media/video-tasks', {
        headers: { Authorization: 'Bearer invalid' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call('/api/automation/media/video-tasks', {
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await call('/api/automation/media/video-tasks')).status, 200);
  assert.equal(
    (
      await call('/api/automation/media/video-tasks', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'must not submit without key' }),
      })
    ).status,
    400,
  );
  assert.equal((await call('/api/automation/media/video-tasks/not-present/artifact')).status, 404);
  const html = await (await fetch(url + '/tools')).text();
  assert.match(html, /<html/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(url + asset)).status, 200);
  const created = await (
    await call('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'deployment-persistence-check' }),
    })
  ).json();
  assert.ok(created.data?.id);
  await stop();
  await start();
  const restored = await (await call('/api/sessions/' + created.data.id)).json();
  assert.equal(restored.data.title, 'deployment-persistence-check');
  console.log(
    'PASS: standalone deployment frontend/assets, auth, origin protection, video API validation, session persistence across restart',
  );
})()
  .catch((error) => {
    console.error(String(error).split(token).join('[REDACTED]'));
    process.exitCode = 1;
  })
  .finally(async () => {
    await stop();
    const resolved = path.resolve(temp);
    if (
      resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
      path.basename(resolved).startsWith('sky-deployment-acceptance-')
    )
      fs.rmSync(resolved, { recursive: true, force: true });
  });
