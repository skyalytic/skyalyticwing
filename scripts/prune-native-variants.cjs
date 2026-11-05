const fs = require('node:fs');
const path = require('node:path');

const supports = (values, target) => !Array.isArray(values) ||
  (!values.includes('!' + target) && (values.every(v => v.startsWith('!')) || values.includes(target) || values.includes('any')));

function pruneNativeVariants(deploy, target) {
  const root = fs.realpathSync(deploy);
  const modules = path.join(root, 'node_modules');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const candidates = [];
  for (const [relative, entry] of Object.entries(lock.packages || {})) {
    if (!relative.startsWith('node_modules/')) continue;
    const dir = path.resolve(root, relative);
    if (!dir.startsWith(modules + path.sep)) throw Error('Dependency escapes deployment: ' + relative);
    if (!fs.existsSync(dir)) continue;
    const real = fs.realpathSync(dir);
    if (!real.startsWith(modules + path.sep)) throw Error('Dependency links outside deployment: ' + relative);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const wrongPlatform = !supports(pkg.os || entry.os, target.os) || !supports(pkg.cpu || entry.cpu, target.cpu);
    const muslName = /(?:linuxmusl-|linux-[^/]+-musl$)/.test(relative);
    const wrongLibc = target.os === 'linux' && (!supports(pkg.libc || entry.libc, target.libc) || (target.libc === 'glibc' && muslName));
    if (!wrongPlatform && !wrongLibc) continue;
    if (entry.optional !== true) throw Error('Incompatible required dependency: ' + relative);
    if (!wrongPlatform && wrongLibc) {
      const counterpart = relative.replace('linuxmusl-', 'linux-').replace(/-musl$/, '-gnu');
      if (counterpart === relative || !fs.existsSync(path.join(root, counterpart, 'package.json')))
        throw Error('Missing compatible native counterpart: ' + relative);
    }
    candidates.push({ dir, relative });
  }
  // Validate the entire removal plan before changing the isolated deployment.
  for (const { dir, relative } of candidates) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Removed incompatible optional native variant: ' + relative);
  }
  return candidates.map(c => c.relative);
}
module.exports = { pruneNativeVariants };
