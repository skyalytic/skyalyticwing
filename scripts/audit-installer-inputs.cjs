'use strict';
// Only reads build inputs and writes audit receipts. Never installs, publishes or removes files.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const slash = value => value.replaceAll('\\', '/');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const fail = message => { throw Error(message); };
const privatePath = /(?:^|\/)(?:\.git|\.svn|\.env(?:\..*)?|\.npmrc|\.pypirc|\.ssh|\.aws|\.azure|\.test-runtime-data|\.test-data|\.source-check|\.拆分前备份|sessions\.json|credentials?\.json|tokens?\.json|credential\.xml|API\.txt|短信sms\.txt|id_rsa|id_ed25519)(?:\/|$)|\.(?:pfx|p12|key|sqlite(?:3)?|db|log)$/i;
const sensitiveContent = /(?<![A-Za-z0-9_])(?:github_pat_[A-Za-z0-9_]{60,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,}|sk-(?:proj-|ant-api\d+-)[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_])|-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{30,}/;
const textFile = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|json|map|txt|md|ya?ml|html|css|xml|ps1|py|sh|cjs|cs|pem|toml|ini|cfg|conf|sql|nsi|nsh)$/i;

function omission(rel) {
  if (/\.(?:[cm]?js|css|[cm]?ts|min)\.map$|\.tsbuildinfo$/i.test(rel)) return 'debug-metadata';
  if (/(?:^|\/)node_modules\/.*\.pdb$/i.test(rel)) return 'debug-metadata';
  if (/(?:^|\/)node_modules\/pdfkit\/\.yarn\//.test(rel)) return 'dependency-build-tool';
  if (/(?:^|\/)(?:__pycache__|\.pytest_cache|\.DS_Store|Thumbs\.db)(?:\/|$)/i.test(rel)) return 'generated-cache';
  return null;
}
function checkPath(rel, reviewedBuiltin = false) {
  if (privatePath.test(rel)) fail('Private/runtime input is forbidden: ' + rel);
  if (!reviewedBuiltin && /(?:^|\/)(?:data|workspace|uploads|downloads|backups)(?:\/|$)/i.test(rel) && !rel.includes('/node_modules/') && !/^packages\/backend\/deploy\/(?:dist|vendor\/@skyalyticwing)\//.test(rel)) {
    fail('User-state directory is forbidden: ' + rel);
  }
  // Certificate stores are legitimate runtime inputs; private material never is.
  if (/\.pem$/i.test(rel) && !/\/(?:certifi\/cacert|openssl\/cert)\.pem$/i.test(rel)) fail('Unreviewed certificate: ' + rel);
}
function validatePolicy(root = ROOT) {
  const policy = json(path.join(root, 'config/packaging-inputs.json'));
  const config = json(path.join(root, 'src-tauri/tauri.conf.json'));
  const product = json(path.join(root, 'config/source-edition.json'));
  if (JSON.stringify(config.bundle.resources) !== JSON.stringify(policy.resources)) fail('Tauri resources differ from reviewed packaging policy');
  if (config.identifier !== product.identifier || config.mainBinaryName !== product.binaryName) fail('Wrong source edition identity');
  for (const rel of policy.resources) {
    if (!rel.startsWith('../packages/') || /[*?[\]{}]/.test(rel) || !inside(root, path.resolve(root, 'src-tauri', rel))) fail('Unreviewed resource root: ' + rel);
  }
  return { policy, config, product };
}
async function mapLimit(values, fn, limit = 16) {
  let next = 0, failure;
  await Promise.all(Array.from({length: Math.min(limit, values.length)}, async () => {
    while (!failure && next < values.length) {
      const index = next++;
      try { await fn(values[index], index); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
}
async function digest(file, rel) {
  const hash = crypto.createHash('sha256');
  let bytes = 0, tail = '';
  const scan = textFile.test(rel) || !path.extname(rel);
  for await (const chunk of fs.createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
    if (scan) {
      const text = tail + chunk.toString('utf8');
      if (sensitiveContent.test(text)) fail('Credential-like content detected (value redacted): ' + rel);
      tail = text.slice(-1024);
    }
  }
  return { bytes, sha256: hash.digest('hex') };
}
async function enumerate(root, resources) {
  root = await fsp.realpath(root); // Windows TEMP may use an 8.3 alias.
  const found = new Map();
  async function walk(file, scope, ancestors = [], entry) {
    const rel = slash(path.relative(root, file));
    const stat = entry || await fsp.lstat(file);
    const real = stat.isSymbolicLink() ? await fsp.realpath(file) : file;
    // Unix runtime symlinks may resolve inside their own resource tree, never to the host/sibling edition.
    if (!inside(scope, real)) fail('Resource escapes its approved root: ' + rel);
    const target = stat.isSymbolicLink() ? await fsp.stat(file) : stat;
    if (target.isDirectory()) {
      if (ancestors.includes(real)) fail('Resource symlink cycle: ' + rel);
      const children = await fsp.readdir(file, {withFileTypes:true});
      for (const child of children) await walk(path.join(file, child.name), scope, [...ancestors, real], child);
    } else if (target.isFile()) {
      if (found.has(rel)) fail('Duplicate resource: ' + rel);
      if (rel.startsWith('packages/web/') && (stat.isSymbolicLink() || (await fsp.lstat(file)).nlink > 1)) fail('Built-in source must be an independent file: ' + rel);
      found.set(rel, { path: rel, absolute: file });
    } else fail('Unsupported resource type: ' + rel);
  }
  await mapLimit(resources, async rel => {
    const file = path.resolve(root, 'src-tauri', rel);
    const stat = await fsp.lstat(file);
    await walk(file, stat.isDirectory() ? file : path.dirname(file));
  }, 6);
  return [...found.values()].sort((a,b) => a.path.localeCompare(b.path));
}
async function audit(root = ROOT, {target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : '', onProgress} = {}) {
  const {policy, product, config} = validatePolicy(root);
  const version = require('./release-config.cjs').releaseConfig(root).version;
  const deploy = path.join(root, 'packages/backend/deploy');
  const installed = json(path.join(deploy, 'product-edition.json'));
  for (const key of ['edition','identifier','binaryName','dataDirectory','port','cliCommand','updateEndpoint']) {
    if (installed[key] !== product[key]) fail('Deployed edition disagrees: ' + key);
  }
  if (json(path.join(deploy, 'app-version.json')).version !== version) fail('Stale deployed app version');
  if (json(path.join(deploy, 'package.json')).version !== version) fail('Stale deployed package version');
  const candidates = await enumerate(root, policy.resources);
  const builtins = new Set(policy.builtins);
  const excluded = [], files = [];
  // Validate every path before starting the expensive content scan.
  for (const item of candidates) {
    checkPath(item.path, builtins.has(item.path));
    if (!omission(item.path) && item.path.startsWith('packages/web/') && !builtins.has(item.path)) fail('Unreviewed built-in file: ' + item.path);
  }
  let scanned = 0;
  await mapLimit(candidates, async item => {
    // Scan omitted maps as well: audit of old outputs must not hide embedded credentials.
    const hash = await digest(item.absolute, item.path);
    if (++scanned % 5000 === 0 || scanned === candidates.length) onProgress?.(scanned, candidates.length);
    const reason = omission(item.path);
    if (reason) { excluded.push({path:item.path,bytes:hash.bytes,reason}); return; }
    if (item.path.startsWith('packages/web/') && !builtins.has(item.path)) fail('Unreviewed built-in file: ' + item.path);
    files.push({path:item.path,target:'_up_/' + item.path,...hash});
  });
  files.sort((a,b)=>a.path.localeCompare(b.path));
  excluded.sort((a,b)=>a.path.localeCompare(b.path));
  const selected = new Set(files.map(f=>f.path));
  for (const rel of [...policy.required, ...policy.builtins]) if (!selected.has(rel)) fail('Required packaged file missing: ' + rel);
  if (target) {
    const platform = target.includes('windows') ? 'win32' : target.includes('darwin') ? 'darwin' : 'linux';
    for (const rel of policy.platformRequired?.[platform] || []) if (!selected.has(rel)) fail('Required platform runtime missing: ' + rel);
    const media = json(path.join(deploy,'vendor/ffmpeg/runtime.json'));
    const arch = target.startsWith('aarch64') ? 'arm64' : 'x64';
    if (media.target !== platform + '-' + arch) fail('FFmpeg architecture does not match desktop target');
    const hashes = new Map(files.map(f=>[f.path,f.sha256]));
    for (const entry of media.files) {
      if (hashes.get('packages/backend/deploy/vendor/ffmpeg/' + entry.path) !== entry.sha256) fail('FFmpeg runtime manifest mismatch: ' + entry.path);
    }
  }
  const inputs = [];
  // The native shell embeds only its startup screen. The backend serves the full React UI.
  for (const rel of policy.embedded) inputs.push({path:rel,...await digest(path.join(root,rel),rel)});
  for (const rel of policy.installerInputs?.[target.includes('windows') ? 'win32' : target.includes('darwin') ? 'darwin' : 'linux'] || []) {
    inputs.push({path:rel,...await digest(path.join(root,rel),rel)});
  }
  if (target) {
    const platform = target.includes('windows') ? 'win32' : target.includes('darwin') ? 'darwin' : 'linux';
    const nodeName = platform === 'linux' ? 'skyalyticwing-node' : 'node';
    const rel = 'src-tauri/binaries/' + nodeName + '-' + target + (platform === 'win32' ? '.exe' : '');
    inputs.push({path:rel,...await digest(path.join(root,rel),rel)});
  }
  return {schema:1,edition:product.edition,version,target,createdAt:new Date().toISOString(),files,inputs,excluded,
    totals:{files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),excludedFiles:excluded.length,excludedBytes:excluded.reduce((n,f)=>n+f.bytes,0)}};
}
function configForManifest(manifest, profile, root = ROOT) {
  const {policy} = validatePolicy(root);
  return {
    ...profile,
    build: {...profile.build, beforeBuildCommand:'node scripts/audit-installer-inputs.cjs --verify',
      frontendDist:policy.embedded.map(rel=>'../'+rel)},
    bundle: {...profile.bundle, resources:Object.fromEntries(manifest.files.map(f=>['../'+f.path,f.target]))},
  };
}
async function verifyManifest(manifest, root = ROOT) {
  const fresh = await audit(root, {target:manifest.target});
  for (const key of ['edition','version','target','files','inputs']) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(fresh[key])) fail('Packaging input changed after approval: ' + key);
  }
  return fresh;
}
function verifyNsis(script, manifest, root = ROOT) {
  const rows = [...script.matchAll(/^\s*File \/a "\/oname=([^"\r\n]+)" "([^"\r\n]+)"/gm)];
  if (!rows.length) fail('NSIS resource list missing');
  const expected = new Map(manifest.files.map(f=>[f.target.toLowerCase(), f.path]));
  const seen = new Set();
  const sidecars = new Set();
  for (const [,rawTarget,source] of rows) {
    const target = slash(rawTarget).toLowerCase();
    const rel = expected.get(target);
    if (!rel) {
      // The sidecar is emitted by externalBin, outside the resource mapping.
      if (target === 'node.exe' && manifest.inputs.some(f => path.resolve(root,f.path).toLowerCase() === path.resolve(source).toLowerCase())) {
        if (sidecars.has(target)) fail('Duplicate NSIS sidecar');
        sidecars.add(target); continue;
      }
      fail('Unexpected NSIS payload: ' + slash(rawTarget));
    }
    if (seen.has(target)) fail('Duplicate NSIS destination: ' + target);
    if (path.resolve(root,rel).toLowerCase() !== path.resolve(source).toLowerCase()) fail('Wrong NSIS input origin: ' + rel);
    seen.add(target);
  }
  if (seen.size !== expected.size) fail('NSIS payload omitted approved files');
  if (manifest.inputs.some(f=>/\/binaries\/node-.*\.exe$/.test(f.path)) && !sidecars.has('node.exe')) fail('NSIS payload omitted Node sidecar');
}
async function main() {
  if (process.argv.includes('--require-wrapper')) fail('Use node scripts/build-desktop.cjs: raw Tauri directory bundling is not audited.');
  const output = path.join(ROOT,'.source-check/packaging-audit');
  fs.mkdirSync(output,{recursive:true});
  if (process.argv.includes('--verify')) {
    await verifyManifest(json(path.join(output,'approved-manifest.json')));
    console.log('PASS packaging manifest, hashes, edition and private-data checks');
  } else {
    const index = process.argv.indexOf('--target');
    const report = await audit(ROOT,{...(index >= 0 ? {target:process.argv[index+1]} : {}),
      onProgress:(done,total)=>console.log('Audit content: ' + done + '/' + total)});
    fs.writeFileSync(path.join(output,'candidate-manifest.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({edition:report.edition,...report.totals,mode:'audit only; no installer built'}));
  }
}
module.exports = {audit,configForManifest,verifyManifest,verifyNsis,validatePolicy,enumerate,digest,checkPath,omission,inside};
if (require.main === module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
