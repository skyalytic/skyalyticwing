import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { checkVersions, syncVersions } = require('./sync-versions.cjs');
const { assertPublish } = require('./release-config.cjs');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

try {
  const version = process.argv[2];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) throw new Error('Supply an exact X.Y.Z version');
  const policy = JSON.parse(readFileSync(new URL('../config/release-policy.json', import.meta.url), 'utf8'));
  if (policy.version !== version || policy.publicReleaseAllowed !== true || policy.updateFeedAllowed !== true) {
    throw new Error(`Release blocked: ${version} has not been approved. No version files were changed.`);
  }
  // Prepare a local source change. Publishing remains an explicit, separate action.
  syncVersions(undefined, version);
  checkVersions();
  assertPublish(version);
  run('pnpm', ['build']);
  run('pnpm', ['test']);
  console.log(`Prepared ${version}. Review and commit the version changes before creating a release tag. No tag or push was performed.`);
} catch (error) {
  console.error('Release preparation failed:', error.message);
  process.exitCode = 1;
}
