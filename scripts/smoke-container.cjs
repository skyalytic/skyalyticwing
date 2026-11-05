const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 600000, windowsHide: true });
(async () => {
  const name = `sky-image-${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  run(['build', '-t', 'skywing-ci', '-f', 'docker/Dockerfile', '.']);
  try {
    run(['run', '-d', '--name', name, '-e', `SKYALYTICWING_AUTH_TOKEN=${token}`, '-p', '127.0.0.1::910', 'skywing-ci']);
    const mapped = run(['port', name, '910/tcp']).trim();
    const url = `http://${mapped}`;
    const deadline = Date.now() + 90000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { healthy = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch {}
      if (healthy) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.equal(healthy, true, 'container must reach health endpoint');
    assert.equal((await fetch(`${url}/api/tools`)).status, 401);
    assert.equal((await fetch(`${url}/api/tools`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    console.log('PASS: production image health and token authentication');
  } finally { try { run(['rm', '-f', name]); } catch {} }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
