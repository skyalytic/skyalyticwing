const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const product = require('../config/source-edition.json');
const { editions, profile } = require('../scripts/desktop-editions.cjs');
test('this independent source exposes exactly its own product', () => {
  assert.deepEqual(Object.keys(editions), [product.edition]);
  const base = require('../src-tauri/tauri.conf.json');
  assert.equal(base.identifier, product.identifier);
  assert.equal(product.productName, product.edition === 'community' ? 'skyalyticwing' : 'skyalyticwing企业版');
  assert.equal(base.productName, product.productName);
  assert.equal(base.app.windows[0].title, product.productName + ' v' + base.version);
  assert.equal(editions[product.edition].productName, product.productName);
  assert.equal(product.cliCommand, 'skyalyticwing');
  assert.deepEqual(product.cliAliases, ['wing-community']);
  assert.equal(require('../packages/web/bin/product-edition.cjs').product().cliCommand, product.cliCommand);
  assert.equal(base.mainBinaryName, product.binaryName);
  assert.equal(base.build.devUrl, 'http://localhost:' + product.port);
  assert.deepEqual(require('../src-tauri/tauri.' + product.edition + '.json'), profile(product.edition, 'win32'));
  for (const platform of ['win32', 'darwin', 'linux']) {
    const config = profile(product.edition, platform);
    assert.equal(config.identifier, product.identifier);
    assert.equal(config.plugins.updater.endpoints[0], product.updateEndpoint);
    assert.ok(config.app.security.csp.includes('127.0.0.1:' + product.port));
  }
  assert.throws(() => profile(product.edition === 'community' ? 'enterprise' : 'community'));
});
test('renaming the display product keeps existing Windows registration and isolated identity', () => {
  const source=fs.readFileSync(path.join(root,'src-tauri/windows/installer.nsi'),'utf8');
  assert.ok(source.includes('!define INSTALLERIDENTITY "SkyalyticWing Community"'));
  assert.ok(source.includes('!define INSTALLERIDENTITY "SkyalyticWing Enterprise"'));
  assert.ok(source.includes('!define INSTALLDIRNAME "skyalyticwing"'));
  assert.ok(source.includes('!define INSTALLDIRNAME "skyalyticwing-enterprise"'));
  for (const base of ['$LOCALAPPDATA', '$PROGRAMFILES', '$PROGRAMFILES64']) {
    assert.ok(source.includes(base+'\\${INSTALLDIRNAME}'));
    assert.ok(!source.includes(base+'\\${PRODUCTNAME}'));
  }
  assert.ok(source.includes('Uninstall\\${INSTALLERIDENTITY}'));
  assert.ok(source.includes('!define MANUPRODUCTKEY "${MANUKEY}\\${INSTALLERIDENTITY}"'));
  assert.ok(source.includes('WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"'));
  assert.ok(source.includes('!insertmacro IsShortcutTarget "${DIRECTORY}\\${INSTALLERIDENTITY}.lnk" "$INSTDIR\\${MAINBINARYNAME}.exe"'));
  const desktop=fs.readFileSync(path.join(root,'src-tauri/linux/'+product.edition+'.desktop'),'utf8');
  assert.ok(desktop.includes('Name='+product.productName+'\n'));
  const linux=require('../src-tauri/tauri.linux.conf.json');
  assert.equal(linux.productName, product.linuxProductName);
  assert.equal(linux.bundle.linux.deb.files['/usr/lib/'+product.linuxProductName+'/cli-bin/node'],'linux/node');
  assert.equal(profile(product.edition,'linux').productName, product.linuxProductName);
  assert.equal(profile(product.edition,'darwin').productName, product.productName);
  const uninstall=fs.readFileSync(path.join(root,'scripts/uninstall-macos.command'),'utf8');
  assert.ok(uninstall.includes('edition="'+product.edition+'"'));
});
test('default source build check works and rejects the opposite edition before spawning Cargo', () => {
  for (const requested of [null, product.edition, product.edition === 'community' ? 'enterprise' : 'community']) {
    const args = [path.join(root, 'scripts/build-desktop.cjs'), '--check', ...(requested ? ['--edition', requested] : [])];
    const result = spawnSync(process.execPath, args, { cwd: os.tmpdir(), env: { ...process.env, PATH: '' }, encoding: 'utf8' });
    assert.equal(result.status === 0, !requested || requested === product.edition, result.stderr);
    if (result.status === 0) assert.match(result.stdout, /installer build not started/);
  }
});
test('source identity agrees across frontend, backend, native build and local CLI', () => {
  for (const file of ['packages/frontend/src/product-edition.ts', 'packages/backend/src/modules/core/utils/desktop-edition.ts', 'src-tauri/build.rs']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.includes("'" + product.edition + "'") || text.includes('"' + product.edition + '"'), file);
  }
  assert.equal(require('../packages/web/bin/product-edition.cjs').product().edition, product.edition);
  assert.equal(require('../config/release-policy.json').packagingAllowed, false);
});
test('two independent CLI commands can coexist and uninstall preserves the other', t => {
  const cli = require('../packages/web/bin/cli-registration.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-cli-independent-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a = { home, command: 'wing-community', bin: path.join(home, 'a/bin'), node: '/fixture/node' };
  const b = { home, command: 'wing-enterprise', bin: path.join(home, 'b/bin'), node: '/fixture/node' };
  const first = cli.install(a), second = cli.install(b), saved = fs.readFileSync(second, 'utf8');
  cli.uninstall(a);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(second, 'utf8'), saved);
  cli.uninstall(b);
});
