const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncVersions, checkVersions } = require('../scripts/sync-versions.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-version-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  for (const file of ['package.json', 'packages/backend/package.json', 'packages/sdk/package.json', 'apps/new-app/package.json', 'src-tauri/tauri.conf.json']) {
    write(file, JSON.stringify({ name: file, version: '1.0.0', other: 'preserved' }));
  }
  write('src-tauri/Cargo.toml', '[package]\nname = "skyalyticwing"\nversion = "1.0.0"\n\n[dependencies]\nexample = "8.7.6"\n');
  write('src-tauri/Cargo.lock', '# version of lock format\nversion = 4\n\n[[package]]\nname = "dependency"\nversion = "8.7.6"\nchecksum = "keep"\n\n[[package]]\nname = "skyalyticwing"\nversion = "1.0.0"\ndependencies = ["dependency"]\n');
  return { root, write, read: file => fs.readFileSync(path.join(root, file), 'utf8') };
}

test('sync includes new workspace packages and changes only the app in Cargo.lock', t => {
  const f = fixture(t);
  const result = syncVersions(f.root, '2.0.2');
  assert.equal(result.length, 7);
  assert.equal(checkVersions(f.root), '2.0.2');
  assert.equal(JSON.parse(f.read('apps/new-app/package.json')).other, 'preserved');
  assert.match(f.read('src-tauri/Cargo.lock'), /name = "dependency"\nversion = "8.7.6"\nchecksum = "keep"/);
  assert.match(f.read('src-tauri/Cargo.lock'), /^version = 4/m);
  assert.match(f.read('src-tauri/Cargo.toml'), /example = "8.7.6"/);
  assert.deepEqual(syncVersions(f.root, '2.0.2'), []);
});

test('check reports a single drifting package without modifying it', t => {
  const f = fixture(t);
  f.write('packages/backend/package.json', '{"version":"0.0.1"}');
  assert.throws(() => checkVersions(f.root), /packages\/backend\/package.json/);
  assert.equal(f.read('packages/backend/package.json'), '{"version":"0.0.1"}');
});

test('all metadata is validated before any write', t => {
  const f = fixture(t);
  f.write('src-tauri/Cargo.lock', 'version = 4\n');
  const before = f.read('package.json');
  assert.throws(() => syncVersions(f.root, '2.0.2'), /Expected one/);
  assert.equal(f.read('package.json'), before);
});

test('invalid versions cannot enter release metadata', t => {
  const f = fixture(t);
  for (const version of ['2.0', '2.0.2; echo unsafe', '02.0.2', 'v2.0.2']) {
    assert.throws(() => syncVersions(f.root, version), /exact/);
  }
  assert.equal(checkVersions(f.root), '1.0.0');
});

test('CRLF Cargo metadata remains supported', t => {
  const f = fixture(t);
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) f.write(file, f.read(file).replaceAll('\n', '\r\n'));
  syncVersions(f.root, '2.0.2');
  assert.equal(checkVersions(f.root), '2.0.2');
  assert.ok(!/(?<!\r)\n/.test(f.read('src-tauri/Cargo.lock')));
});

test('release metadata includes titlebar defaults and shipped extension versions', t => {
  const f = fixture(t);
  f.write('src-tauri/tauri.conf.json', JSON.stringify({version:'1.0.0',productName:'Wing',app:{windows:[{title:'Wing v1.0.0'}]}}));
  f.write('packages/backend/src/extensions/bundled/files/manifest.json', '{"version":"1.0.0"}');
  f.write('packages/backend/src/modules/core/utils/app-version.util.ts', "export const APP_VERSION_FALLBACK = '1.0.0';");
  f.write('packages/frontend/src/components/layout/WindowTitlebar.tsx', "function WindowTitlebar({ version = '1.0.0' }) {}");
  f.write('packages/frontend/src/components/layout/Layout.tsx', "const [appVersion, setAppVersion] = useState('1.0.0');");
  syncVersions(f.root, '2.1.0');
  assert.equal(checkVersions(f.root), '2.1.0');
  assert.equal(JSON.parse(f.read('src-tauri/tauri.conf.json')).app.windows[0].title, 'Wing v2.1.0');
  assert.equal(JSON.parse(f.read('packages/backend/src/extensions/bundled/files/manifest.json')).version, '2.1.0');
  for (const file of ['packages/backend/src/modules/core/utils/app-version.util.ts','packages/frontend/src/components/layout/WindowTitlebar.tsx','packages/frontend/src/components/layout/Layout.tsx']) assert.ok(f.read(file).includes("'2.1.0'"));
  f.write('packages/frontend/src/components/layout/WindowTitlebar.tsx', "function WindowTitlebar({ version = '2.0.2' }) {}");
  assert.throws(() => checkVersions(f.root), /WindowTitlebar/);
});
