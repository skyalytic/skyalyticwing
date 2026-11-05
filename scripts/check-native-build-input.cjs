// A cloud build receives only an explicit snapshot, never the development checkout.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '.');
const findings = [];
for (const name of ['modules/identity/identity.service.js', 'modules/identity/identity.controller.js', 'modules/enterprise/enterprise.service.js', 'modules/enterprise/enterprise.controller.js']) {
  if (fs.existsSync(path.join(root, 'packages/backend/deploy/dist', name))) findings.push(name + ': obsolete alternate account implementation');
}
for (const name of ['packages/backend/deploy/cli/dist/cli.js', 'packages/backend/deploy/cli/dist/progress.js', 'packages/backend/deploy/cli/package.json', 'packages/web/bin/cli-registration.cjs', 'src-tauri/linux/postinst.sh', 'src-tauri/linux/postrm.sh']) {
  if (!fs.existsSync(path.join(root,name))) findings.push(name + ': required CLI lifecycle asset missing');
}
let count = 0, bytes = 0;
for (const name of ['config/ffmpeg-runtime.json','scripts/prepare-ffmpeg-runtime.cjs','scripts/test-bundled-ffmpeg.cjs']) {
  if (!fs.existsSync(path.join(root,name))) findings.push(name+': required bundled media build input missing');
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    if (entry.name === '.git') continue;
    const file = path.join(dir, entry.name);
    const rel = path.relative(root, file).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { findings.push(rel + ': symlink'); continue; }
    if (/(^|\/)(\.env(?:\..*)?|BUILD_DEPLOY\.md|\.test-runtime-data|node_modules|credential\.xml|sessions\.json|API\.txt)$|\.(?:pem|pfx|p12|key|sqlite|db)$/i.test(rel) || /^(?:data|workspace|packages\/web\/(?:data|workspace))(?:\/|$)/.test(rel)) findings.push(rel + ': private or runtime path');
    if (entry.isDirectory()) { walk(file); continue; }
    const data = fs.readFileSync(file); count++; bytes += data.length;
    if (data.length >= 95 * 1024 * 1024) findings.push(rel + ': exceeds source upload file limit');
    if (/\.(?:tgz|png|jpg|ico|icns|bmp|exe|dll)$/i.test(rel)) continue;
    const content = data.toString('utf8');
    if(entry.name==='package-lock.json') {
      const lock=JSON.parse(content);
      const allowed=path.resolve(path.dirname(file),'vendor')+path.sep;
      for(const [name,item] of Object.entries(lock.packages||{})) {
        if(item.resolved?.startsWith('file:')) {
          const target=path.resolve(path.dirname(file),item.resolved.slice(5));
          if(!target.startsWith(allowed))findings.push(rel+': local lock dependency outside vendor: '+name);
        }
      }
    }
    if(entry.name==='package.json') {
      const manifest=JSON.parse(content);
      for(const value of Object.values(manifest.dependencies || {}))if(typeof value==='string' && value.startsWith('file:')) {
        const target=path.resolve(path.dirname(file),value.slice(5));
        if(!target.startsWith(root+path.sep))findings.push(rel+': dependency escapes build snapshot');
      }
    }
    if (/(?:github_pat_[A-Za-z0-9_]{60,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{30,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/.test(content)) findings.push(rel + ': credential-like content');
  }
}
walk(root);
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`PASS: ${count} build-input files, ${(bytes/1048576).toFixed(1)} MiB; no detected credentials or runtime state`);
