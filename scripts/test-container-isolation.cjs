// Requires a working Docker daemon. Never reports a skip as a passing isolation test.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const {
  SandboxSystemService,
} = require('../packages/backend/dist/modules/tools/sandbox/sandbox.service.js');
(async () => {
  execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15000 });
  execFileSync(
    'docker',
    ['pull', process.env.SKYALYTICWING_SANDBOX_IMAGE || 'node:22-bookworm-slim'],
    { stdio: 'inherit', timeout: 300000 },
  );
  const dir = mkdtempSync(join(tmpdir(), 'sky-isolation-'));
  writeFileSync(join(dir, 'input.txt'), 'workspace');
  const sandbox = new SandboxSystemService(
    { info() {} },
    { isCommandAllowed: () => true, isPathAllowed: (path) => path === dir },
  );
  await sandbox.onModuleInit();
  const result = await sandbox.executeSafe(
    "cat input.txt && echo saved > output.txt && test ! -w /etc && test ! -e /var/run/docker.sock && test \"$(id -u)\" != 0 && ! node -e \"require('net').connect(443,'1.1.1.1').on('error',()=>process.exit(1))\"",
    { cwd: dir, timeout: 10000 },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(readFileSync(join(dir, 'output.txt'), 'utf8').trim(), 'saved');
  const timeout = await sandbox.executeSafe('sleep 20', { cwd: dir, timeout: 300 });
  assert.equal(timeout.success, false);
  const containers = execFileSync(
    'docker',
    ['ps', '-a', '--filter', `name=${timeout.container}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  assert.equal(containers.trim(), '', 'timed-out container must be removed');
  console.log(
    'PASS: workspace access, non-root, read-only root, no network/socket, timeout cleanup',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
