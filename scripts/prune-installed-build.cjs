// Retire generated code before overlay installation, only after verified backup.
const fs = require('node:fs');
const path = require('node:path');
const recovery = require('./update-recovery.cjs');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const directories = [
  '_up_/packages/backend/deploy/dist',
  '_up_/packages/backend/deploy/frontend',
  '_up_/packages/backend/deploy/cli/dist',
  '_up_/packages/frontend/dist',
  '_up_/packages/backend/deploy/vendor/ffmpeg',
];
function pruneInstalledBuild(installDirectory, recoveryDirectory) {
  const root = fs.realpathSync(installDirectory);
  if (root === path.parse(root).root) throw Error('Unsafe installation root');
  const journal = recovery.load(recoveryDirectory);
  const plan = journal.plans[0];
  if (journal.status !== 'installing' || !samePath(fs.realpathSync(plan.target), root)) {
    throw Error('Verified installation backup required');
  }
  recovery.verify(plan.snapshot, plan.entries);
  const targets = [];
  for (const relative of directories) {
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) break;
      if (fs.lstatSync(current).isSymbolicLink() || !samePath(fs.realpathSync(current), current)) {
        throw Error('Installation code directory must not be a link');
      }
    }
    const target = path.join(root, relative);
    if (!target.startsWith(root + path.sep)) throw Error('Code directory outside installation');
    if (fs.existsSync(target)) targets.push(target);
  }
  // All paths and the recovery copy are checked before the first removal.
  for (const target of targets) fs.rmSync(target, { recursive: true });
  return targets.length;
}
module.exports = { pruneInstalledBuild };
if (require.main === module) {
  try { console.log('Retired compiled directories:', pruneInstalledBuild(process.argv[2], process.argv[3])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
