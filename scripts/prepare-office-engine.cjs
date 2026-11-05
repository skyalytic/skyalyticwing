/* Stage a private Linux Office companion kit. This never publishes an installer or website. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const lock = require('../deploy/office-engine/runtime.lock.json');
const cache = path.resolve(
  process.argv[2] || path.join(root, '.test-runtime-data/office-engine-packages'),
);
const source = path.resolve(
  process.argv[3] || path.join(root, '.test-runtime-data/office-mpl-source.tar.gz'),
);
const dest = path.join(root, 'build/office-engine-linux-private');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (sha(source) !== lock.source.sha256) throw new Error('Office source archive checksum mismatch');
for (const file of lock.packages) {
  if (
    /brand|onlyoffice/i.test(file.name) ||
    !/^(coolwsd|collaboraoffice[^/]*)_[^/]+\.deb$/.test(file.name)
  )
    throw new Error('Unapproved Office component');
  if (sha(path.join(cache, file.name)) !== file.sha256)
    throw new Error('Office package checksum mismatch: ' + file.name);
}
fs.mkdirSync(path.join(dest, 'packages'), { recursive: true });
fs.mkdirSync(path.join(dest, 'sources'), { recursive: true });
for (const file of lock.packages)
  fs.copyFileSync(path.join(cache, file.name), path.join(dest, 'packages', file.name));
// Refuse stale forbidden packages if the output directory was populated by another build.
const expected = new Set(lock.packages.map((file) => file.name));
for (const file of fs.readdirSync(path.join(dest, 'packages')))
  if (!expected.has(file)) throw new Error('Unexpected staged package: ' + file);
fs.copyFileSync(source, path.join(dest, 'sources/office-source.tar.gz'));
fs.copyFileSync(
  path.join(root, 'deploy/office-engine/runtime.lock.json'),
  path.join(dest, 'runtime.lock.json'),
);
fs.copyFileSync(
  path.join(root, 'deploy/office-engine/install-private.sh'),
  path.join(dest, 'install-private.sh'),
);
fs.copyFileSync(path.join(root, 'docs/OFFICE_ENGINE_DEPLOYMENT.md'), path.join(dest, 'README.md'));
fs.copyFileSync(path.join(root, 'docs/OFFICE_COMMERCIAL_NOTICES.md'), path.join(dest, 'NOTICE.md'));
fs.mkdirSync(path.join(dest, 'licenses'), { recursive: true });
const prefix = 'online.mirror-' + lock.source.commit;
const result = spawnSync(
  'tar',
  [
    '-xzf',
    source,
    '-C',
    path.join(dest, 'licenses'),
    '--strip-components=1',
    ...[
      'COPYING',
      'THIRDPARTYLICENSES',
      'browser/LICENSE',
      'engine/COPYING',
      'engine/COPYING.MPL',
      'engine/COPYING.LGPL',
    ].map((file) => prefix + '/' + file),
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) throw new Error('License extraction failed');
const sums = lock.packages.map((file) => `${file.sha256}  packages/${file.name}`);
sums.push(`${lock.source.sha256}  sources/office-source.tar.gz`);
fs.writeFileSync(path.join(dest, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log('Prepared private companion kit, with source and notices: ' + dest);
console.log('No public upload, website change, or Windows/macOS installer was performed.');
