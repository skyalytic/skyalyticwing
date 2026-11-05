// Pinned, relocatable CPython. No developer-machine interpreter enters a release.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const spec = require('../config/python-standalone.json');
const target = process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : 'x86_64-unknown-linux-gnu';
if (!['linux','darwin'].includes(process.platform) || !['x64','arm64'].includes(process.arch) || (process.platform === 'linux' && process.arch !== 'x64')) throw Error('Unsupported native Python build target');
const deploy = path.resolve(process.argv[2] || path.join(root, 'packages/backend/deploy'));
if (!fs.existsSync(path.join(deploy, 'desktop-main.cjs'))) throw Error('Expected a prepared desktop deployment directory');
const dest = path.join(deploy,'python');
const smoke = "import ssl,sqlite3,ctypes,lzma,bz2,zlib,venv,ensurepip,pip,sys; assert sys.version_info[:2]==(3,12); print(sys.version.split()[0])";
if (fs.existsSync(dest)) {
  const marker = path.join(dest, 'wing-runtime.json');
  const installed = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker,'utf8')) : {};
  if (installed.version !== spec.version || installed.target !== target || installed.sha256 !== spec.targets[target]) throw Error('Existing Python runtime differs; inspect before replacing it');
  execFileSync(path.join(dest,'bin/python3'), ['-I','-B','-c',smoke], {stdio:'inherit'});
  console.log(`PASS: existing bundled CPython ${spec.version} verified`);
  process.exit(0);
}
const archiveName = `cpython-${spec.version}+${spec.release}-${target}-install_only_stripped.tar.gz`;
const cache = path.join(root, 'build/python-standalone-cache');
fs.mkdirSync(cache, {recursive:true});
const archive = path.join(cache, archiveName);
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (!fs.existsSync(archive) || digest(archive) !== spec.targets[target]) {
  execFileSync('curl', ['--fail','--location','--retry','3','--max-time','600',`https://github.com/astral-sh/python-build-standalone/releases/download/${spec.release}/${encodeURIComponent(archiveName)}`,'-o',archive+'.partial'], {stdio:'inherit'});
  if (digest(archive+'.partial') !== spec.targets[target]) throw Error('CPython download SHA-256 mismatch');
  fs.renameSync(archive+'.partial', archive);
}
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-python-'));
execFileSync('tar', ['-xzf',archive,'-C',staging], {stdio:'inherit'});
const source = path.join(staging, 'python');
execFileSync(path.join(source,'bin/python3'), ['-I','-c',smoke], {stdio:'inherit',env:{...process.env,PYTHONHOME:'',PYTHONPATH:''}});
if (fs.existsSync(dest)) throw Error('Python destination already exists; inspect before replacing it');
fs.cpSync(source,dest,{recursive:true,verbatimSymlinks:true});
// Verify after relocation; retain all bundled licenses and dependency notices.
execFileSync(path.join(dest,'bin/python3'), ['-I','-c',smoke], {stdio:'inherit',env:{...process.env,PYTHONHOME:'',PYTHONPATH:''}});
fs.writeFileSync(path.join(dest,'wing-runtime.json'),JSON.stringify({version:spec.version,target,sha256:spec.targets[target],source:`https://github.com/astral-sh/python-build-standalone/releases/tag/${spec.release}`},null,2));
console.log(`PASS: bundled relocatable CPython ${spec.version} (${target}), standard extensions and pip`);
