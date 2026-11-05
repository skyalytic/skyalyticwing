// Acquire the pinned Windows runtime independently inside this source tree.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const root = path.resolve(__dirname, '..');
const version = 'v24.13.1';
async function prepare() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const base = `https://nodejs.org/dist/${version}/`;
  const sums = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60_000) });
  if (!sums.ok) throw Error('Unable to obtain official Node checksums');
  const expected = (await sums.text()).match(/^([a-f0-9]{64})\s+win-x64\/node.exe\s*$/m)?.[1];
  if (!expected) throw Error('Official Node checksum is missing');
  const target = path.join(root, 'src-tauri/binaries/node-x86_64-pc-windows-msvc.exe');
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (fs.existsSync(target) && sha(target) === expected) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(base + 'win-x64/node.exe', { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw Error('Node download failed: ' + response.status);
  const temporary = target + '.partial';
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
  if (sha(temporary) !== expected) throw Error('Node runtime checksum mismatch');
  fs.renameSync(temporary, target);
  console.log('Verified Node ' + version + ' sidecar: ' + target);
}
prepare().catch(error => { console.error(error); process.exitCode = 1; });
