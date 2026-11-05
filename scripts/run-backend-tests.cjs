const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cwd = path.resolve(__dirname, '../packages/backend');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-backend-tests-'));
const child = spawn(process.execPath, ['--experimental-vm-modules', require.resolve('jest/bin/jest', { paths: [cwd] }), ...process.argv.slice(2)], {
  cwd, stdio: 'inherit', env: { ...process.env, SKYALYTICWING_DATA_DIR: temporary, SKYALYTICWING_WEB_DATA_DIR: temporary },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  // Only remove the unique temporary profile owned by this test invocation.
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
