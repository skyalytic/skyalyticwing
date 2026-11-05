const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { version } = require('./release-config.cjs').releaseConfig();
if (!process.argv[2]) throw Error('Supply the local artifact directory');
const root = path.resolve(process.argv[2]);
const artifacts = [
  `Windows/SkyalyticWing_${version}_x64-setup.exe`,
  `Linux/SkyalyticWing_${version}_amd64.deb`,
  `Linux/SkyalyticWing_${version}_amd64.AppImage`,
];
const macosArtifacts = [`MacOS/SkyalyticWing_${version}_arm64.dmg`, `MacOS/SkyalyticWing_${version}_x64.dmg`]
  .filter(file => fs.existsSync(path.join(root, file)));
artifacts.push(...macosArtifacts);
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
(async () => {
  const files = [];
  for (const relative of artifacts) {
    execFileSync(process.execPath, [path.join(__dirname, 'verify-release-signature.cjs'), path.join(root, relative)], { stdio: 'inherit' });
    for (const name of [relative, relative + '.sig']) {
      const file = path.join(root, name);
      const bytes = fs.statSync(file).size;
      if (!bytes) throw new Error(`Empty release file: ${name}`);
      files.push({ file: name, bytes, sha256: await hash(file) });
    }
  }
  const manifest = {
    product: 'SkyalyticWing', version, builtAt: new Date().toISOString(),
    status: 'acceptance-candidate', publicReleaseAllowed: false,
    windowsAuthenticodeSigned: false,
    updaterSignaturesVerifiedSeparately: true,
    linuxBuildBaseline: 'Ubuntu 24.04 x86_64 / glibc 2.39',
    macosBuilt: macosArtifacts.length > 0,
    ...(macosArtifacts.length ? {
      macosArchitectures: macosArtifacts.map(file => file.includes('_arm64.') ? 'arm64' : 'x64'),
      macosCodeSignature: 'ad-hoc', macosAppleNotarized: false,
    } : {}),
    files,
  };
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), files.map(f => `${f.sha256}  ${f.file}`).join('\n') + '\n');
  console.log('Release manifest and SHA-256 checksums written for ' + files.length + ' files.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
