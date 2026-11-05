const { releaseConfig, assertPublish } = require('./release-config.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
async function main() {
  const {version, baseUrl} = releaseConfig();
  assertPublish(version); // Must run before network, archive creation or server changes.
  const [directory, server] = process.argv.slice(2);
  if (!directory || !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(server || '')) throw Error('Supply artifact directory and SSH destination');
  const root = fs.realpathSync(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json')));
  const feed = JSON.parse(fs.readFileSync(path.join(root,'latest.json')));
  if (manifest.version !== version || feed.version !== version || manifest.files.length !== 7) throw Error('Incomplete or mismatched release');
  for (const entry of manifest.files) {
    if (!/^(Windows|MacOS|Linux)\/SkyalyticWing_[\w.\-]+$/.test(entry.file) || entry.url !== baseUrl+entry.file) throw Error('Invalid artifact path/URL');
    const file = path.join(root, entry.file);
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== entry.sha256 || fs.statSync(file).size !== entry.bytes) throw Error('Artifact changed after verification');
    execFileSync(process.execPath,[path.join(__dirname,'verify-release-signature.cjs'),file],{stdio:'inherit'});
  }
  const feedUrl = process.env.WING_UPDATE_FEED_URL;
  if (!feedUrl || !/^https:\/\/[^\s]+$/.test(feedUrl)) throw Error('Set WING_UPDATE_FEED_URL to your HTTPS update feed');
  const live = await fetch(feedUrl, {signal:AbortSignal.timeout(30_000)});
  if (!live.ok) throw Error('Cannot verify live release; publication stopped');
  const previous = await live.json();
  if (!/^\d+\.\d+\.\d+$/.test(previous.version)) throw Error('Invalid live version');
  const compare = version.split('.').map(Number).reduce((r,n,i)=>r || n-Number(previous.version.split('.')[i]),0);
  if (compare <= 0) throw Error('Publication must increase version; existing releases are immutable');
  const base = process.env.WING_RELEASE_DIRECTORY;
  if (!base || !/^\/[a-zA-Z0-9_./-]+$/.test(base) || base.split('/').some(p => p === '..') || base === '/') throw Error('Set WING_RELEASE_DIRECTORY to an absolute deployment directory');
  const incoming = `${base}/.incoming-${version}-${crypto.randomUUID()}`;
  const final = `${base}/wing-${version}`;
  const ssh = script => execFileSync('ssh',[server,script],{stdio:'inherit'});
  ssh(`test ! -e '${final}' && mkdir -p '${incoming}/Windows' '${incoming}/Linux' '${incoming}/MacOS'`);
  for (const file of [...manifest.files.flatMap(f=>[f.file,f.file+'.sig']),'SHA256SUMS.txt','release-manifest.json','wing-release.json','latest.json','CHANGELOG.txt']) {
    execFileSync('scp',[path.join(root,file),`${server}:${incoming}/${file}`],{stdio:'inherit'});
  }
  // Only switch the feed after the immutable release directory is complete and verified remotely.
  ssh(`cd '${incoming}' && sha256sum -c SHA256SUMS.txt && test ! -e '${final}' && mv '${incoming}' '${final}' && cp '${final}/latest.json' '${base}/latest.next.json' && mv '${base}/latest.next.json' '${base}/latest.json'`);
  console.log(`Published signed Wing ${version}; previous installation artifacts retained.`);
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
