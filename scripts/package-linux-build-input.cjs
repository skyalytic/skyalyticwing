// Build-only input: compiled application and native sources, never user state.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('./assert-single-application.cjs').assertSingleApplication(path.join(root, 'packages/backend/dist'), path.join(root, 'packages/frontend/dist'));
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'build', 'release-20261015', 'linux-input');
if (!out.startsWith(root + path.sep)) throw new Error('Build export must stay inside the workspace');
if (fs.existsSync(out)) throw new Error('Build input already exists; inspect before replacing it');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '.gitattributes'), '* -text\n');
function copy(rel, dest = rel) {
  const target = path.join(out, dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, rel), target, { recursive: true, filter: (p) => !['.Temp', '.DS_Store'].includes(path.basename(p)) });
}
for (const rel of ['src-tauri/src', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/permissions', 'src-tauri/windows', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/LICENSE.txt', 'src-tauri/entitlements.mac.plist', 'packages/frontend/dist']) copy(rel);
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
copy('packages/frontend/public/desktop-startup.html');
copy('packages/frontend/public/desktop-startup.js');
copy('scripts/prepare-unix-python.cjs');
copy('scripts/prune-native-variants.cjs');
copy('scripts/restore-appimage-payload.cjs');
for (const name of ['build-native-local-test.cjs', 'sign-native-resources.py', 'verify-native-payload.cjs', 'verify-native-build-input.cjs']) copy('scripts/' + name);
copy('scripts/audit-macos-runtime.py');
copy('scripts/test-bundled-python.cjs');
copy('scripts/test-swarm-runtime.cjs');
copy('scripts/test-cli-registration.cjs');
copy('scripts/prune-installed-build.cjs');
copy('scripts/test-linux-cli-package.sh');
copy('scripts/bundle-linux-tools.sh');
copy('scripts/upload-private-macos-release.sh');
for (const name of ['release-config.cjs', 'check-release-policy.cjs', 'check-packaging-policy.cjs', 'check-native-build-input.cjs', 'harden-desktop-npm.cjs', 'prune-linux-deploy.cjs', 'test-desktop-deploy.cjs', 'test-desktop-documents.cjs', 'package-macos-dmg.sh', 'verify-release-signature.cjs', 'create-wing-release-manifest.cjs', 'materialize-office-build-input.cjs']) copy('scripts/' + name);
copy('config/release-policy.json');
for (const name of ['packaging-inputs.json', 'source-edition.json', 'desktop-editions.json']) copy('config/' + name);
for (const name of ['audit-installer-inputs.cjs', 'source-edition.cjs', 'desktop-editions.cjs', 'prepare-desktop-edition.cjs']) copy('scripts/' + name);
// Keep the existing fixed identity; the target builder verifies rather than relabels it.
copy('packages/backend/deploy/product-edition.json');
copy('packages/backend/deploy/app-version.json');
copy('src-tauri/tauri.ci-macos.json');
copy('config/python-standalone.json');
copy('config/ffmpeg-runtime.json');
copy('scripts/prepare-ffmpeg-runtime.cjs');
copy('scripts/test-bundled-ffmpeg.cjs');
copy('src-tauri/tauri.linux.conf.json');
copy('src-tauri/tauri.macos.conf.json');
for (const rel of config.bundle.resources.filter(p => p.startsWith('../packages/web/'))) copy(rel.slice(3));
const deploy = path.join(out, 'packages/backend/deploy');
fs.mkdirSync(deploy, { recursive: true });
const rewrite = (deps, prefix) => Object.fromEntries(Object.entries(deps || {}).map(([name, value]) => [name, value.startsWith('workspace:') ? `file:${prefix}/${prefix === '..' ? name.split('/').pop() : name}` : value]));
for (const pkg of ['shared', 'sdk', 'tools', 'providers']) {
  const data = JSON.parse(fs.readFileSync(path.join(root, `packages/${pkg}/package.json`), 'utf8'));
  const dest = `packages/backend/deploy/vendor/@skyalyticwing/${pkg}`;
  copy(`packages/${pkg}/dist`, `${dest}/dist`);
  fs.writeFileSync(path.join(out, dest, 'package.json'), JSON.stringify({ name:data.name, version:data.version, private:true, type:data.type || 'module', main:data.main, module:data.module, exports:data.exports, files:['dist'], dependencies:rewrite(data.dependencies, '..') }, null, 2));
}
const backend = JSON.parse(fs.readFileSync(path.join(root, 'packages/backend/package.json'), 'utf8'));
backend.overrides = JSON.parse(fs.readFileSync(path.join(root, 'config/desktop-dependency-overrides.json'), 'utf8'));
copy('deploy/vendor/xlsx-0.20.3.tgz', 'packages/backend/deploy/vendor/xlsx-0.20.3.tgz');
backend.dependencies.xlsx = 'file:vendor/xlsx-0.20.3.tgz';
fs.writeFileSync(path.join(deploy, 'package.json'), JSON.stringify({name:'@skyalyticwing/backend-deploy', version:backend.version, private:true, type:'commonjs', main:'dist/main.js', dependencies:rewrite(backend.dependencies, 'vendor'), overrides:backend.overrides}, null, 2));
copy('packages/backend/dist', 'packages/backend/deploy/dist');
copy('packages/frontend/dist', 'packages/backend/deploy/frontend');
copy('deploy/office-engine', 'packages/backend/deploy/office-installer');
copy('scripts/wing-tui.cjs', 'packages/backend/deploy/wing-tui.cjs');
copy('scripts/desktop-main.cjs', 'packages/backend/deploy/desktop-main.cjs');
copy('packages/cli/dist', 'packages/backend/deploy/cli/dist');
copy('packages/backend/deploy/cli/package.json');
copy('src-tauri/linux');
copy('scripts/uninstall-macos.command');
copy('scripts/update-recovery.cjs', 'packages/backend/deploy/update-recovery.cjs');
copy('packages/backend/deploy/package-lock.json');
// Large engine binaries are compressed independently so the private Git build
// snapshot stays below the per-file upload limit. Restore before native bundling.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const engineRoot = path.join(root, 'packages/backend/deploy/office-wasm');
const officeOutput = 'packages/backend/deploy/office-wasm';
const assets = [];
for (const name of fs.readdirSync(engineRoot)) {
  const source = path.join(engineRoot, name);
  if (!fs.statSync(source).isFile()) throw Error('Unexpected Office asset directory');
  if (fs.statSync(source).size < 90 * 1024 * 1024) { copy('packages/backend/deploy/office-wasm/' + name); continue; }
  const data = fs.readFileSync(source);
  const compressed = zlib.gzipSync(data, {level: 6});
  const parts = [];
  for (let start = 0; start < compressed.length; start += 48 * 1024 * 1024) {
    const part = `build-assets/${name}.gz.part${parts.length}`;
    fs.mkdirSync(path.join(out, 'build-assets'), {recursive: true});
    fs.writeFileSync(path.join(out, part), compressed.subarray(start, start + 48 * 1024 * 1024));
    parts.push(part);
  }
  assets.push({file: `${officeOutput}/${name}`, parts, sha256: crypto.createHash('sha256').update(data).digest('hex')});
}
fs.writeFileSync(path.join(out, 'build-assets/office.json'), JSON.stringify(assets, null, 2));
// The server installs Linux dependencies locally; no Windows node_modules travel.
fs.mkdirSync(path.join(out, 'src-tauri/binaries'), { recursive: true });
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({name:'skyalyticwing-native-build', version:config.version,private:true}));
console.log('Native build input ready:', out);
