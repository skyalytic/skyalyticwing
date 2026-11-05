const fs = require('node:fs');
const path = require('node:path');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const repositoryRoot = path.resolve(__dirname, '..');

function versionFiles(root, version) {
  if (!VERSION.test(version)) throw new Error('Expected an exact X.Y.Z application version');
  const changes = [];
  const jsonVersion = relative => {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(original);
    if (typeof json.version !== 'string') throw new Error(`Missing version: ${relative}`);
    let changed = json.version !== version;
    json.version = version;
    if (relative === 'src-tauri/tauri.conf.json') {
      for (const window of json.app?.windows || []) {
        const title = `${json.productName} v${version}`;
        if (window.title !== title) { window.title = title; changed = true; }
      }
    }
    if (changed) {
      changes.push({ file, relative, original, content: JSON.stringify(json, null, 2) + '\n' });
    }
  };
  jsonVersion('package.json');
  // Keep in step with pnpm-workspace.yaml: packages/* and apps/*.
  for (const parent of ['packages', 'apps']) {
    const directory = path.join(root, parent);
    if (!fs.existsSync(directory)) continue;
    for (const child of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${parent}/${child.name}/package.json`;
      if (child.isDirectory() && fs.existsSync(path.join(root, relative))) jsonVersion(relative);
    }
  }
  jsonVersion('src-tauri/tauri.conf.json');
  const bundled = 'packages/backend/src/extensions/bundled';
  if (fs.existsSync(path.join(root, bundled))) {
    for (const child of fs.readdirSync(path.join(root, bundled), { withFileTypes: true })) {
      const relative = `${bundled}/${child.name}/manifest.json`;
      if (child.isDirectory() && fs.existsSync(path.join(root, relative))) jsonVersion(relative);
    }
  }
  // Defaults appear before the backend handshake and in isolated runtime fallback.
  for (const [relative, pattern] of [
    ['packages/backend/src/modules/core/utils/app-version.util.ts', /(APP_VERSION_FALLBACK = ')[^']+(')/],
    ['packages/frontend/src/components/layout/WindowTitlebar.tsx', /(version = ')[^']+(')/],
    ['packages/frontend/src/components/layout/Layout.tsx', /(\[appVersion, setAppVersion\] = useState\(')[^']+('\))/],
  ]) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    if (!pattern.test(original)) throw new Error(`Missing runtime version default: ${relative}`);
    const content = original.replace(pattern, (_match, before, after) => before + version + after);
    if (original !== content) changes.push({ file, relative, original, content });
  }
  for (const edition of ['community', 'enterprise']) {
    const relative = `src-tauri/tauri.${edition}.json`, file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8'), config = JSON.parse(original);
    let changed = false;
    for (const window of config.app?.windows || []) {
      const title = `${config.productName} v${version}`;
      if (window.title !== title) { window.title = title; changed = true; }
    }
    if (changed) changes.push({ file, relative, original, content: JSON.stringify(config, null, 2) + '\n' });
  }
  const tomlPath = path.join(root, 'src-tauri/Cargo.toml');
  const toml = fs.readFileSync(tomlPath, 'utf8');
  const packageBlock = toml.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[0];
  const cargoName = packageBlock?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!cargoName || !/^version\s*=\s*"[^"]+"/m.test(packageBlock)) throw new Error('Invalid Cargo package metadata');
  const updatedBlock = packageBlock.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`);
  const updatedToml = toml.replace(packageBlock, updatedBlock);
  if (toml !== updatedToml) changes.push({ file: tomlPath, relative: 'src-tauri/Cargo.toml', original: toml, content: updatedToml });

  const lockPath = path.join(root, 'src-tauri/Cargo.lock');
  const lock = fs.readFileSync(lockPath, 'utf8');
  let matches = 0;
  const updatedLock = lock.replace(/^\[\[package\]\]\r?\n[\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm, block => {
    if (block.match(/^name = "([^"]+)"/m)?.[1] !== cargoName) return block;
    matches++;
    if (!/^version = "[^"]+"/m.test(block)) throw new Error('Missing application version in Cargo.lock');
    return block.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  });
  if (matches !== 1) throw new Error(`Expected one ${cargoName} entry in Cargo.lock; found ${matches}`);
  if (lock !== updatedLock) changes.push({ file: lockPath, relative: 'src-tauri/Cargo.lock', original: lock, content: updatedLock });
  return changes;
}

function checkVersions(root = repositoryRoot) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const changes = versionFiles(root, version);
  if (changes.length) throw new Error(`Versions differ from ${version}: ${changes.map(item => item.relative).join(', ')}. Run pnpm version:sync.`);
  return version;
}

function syncVersions(root = repositoryRoot, version) {
  version ??= JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  // Validate every input before writing anything. No dependency update or external command.
  const changes = versionFiles(root, version);
  const written = [];
  try {
    for (const change of changes) {
      fs.writeFileSync(change.file, change.content);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) fs.writeFileSync(change.file, change.original);
    throw error;
  }
  return changes.map(item => item.relative);
}

module.exports = { checkVersions, syncVersions, versionFiles };
if (require.main === module) {
  try {
    if (process.argv[2] === '--check') console.log(`Application versions agree: ${checkVersions()}`);
    else console.log(`Updated versions: ${syncVersions(repositoryRoot, process.argv[2]).join(', ') || 'already consistent'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
