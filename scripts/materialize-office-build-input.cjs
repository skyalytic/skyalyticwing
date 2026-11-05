const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const assets = JSON.parse(fs.readFileSync(path.join(root, 'build-assets/office.json')));
const resolve = rel => {
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) throw Error('Build asset escapes snapshot');
  return file;
};
for (const asset of assets) {
  const data = zlib.gunzipSync(Buffer.concat(asset.parts.map(part => fs.readFileSync(resolve(part)))));
  if (crypto.createHash('sha256').update(data).digest('hex') !== asset.sha256) throw Error('Office build asset checksum mismatch');
  fs.writeFileSync(resolve(asset.file), data);
}
const dir = path.join(root, 'packages/backend/deploy/office-wasm');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
for (const entry of manifest.files) {
  if (path.basename(entry.name) !== entry.name) throw Error('Invalid Office manifest entry');
  const data = fs.readFileSync(path.join(dir, entry.name));
  if (crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) throw Error('Office runtime checksum mismatch: ' + entry.name);
}
console.log('Office runtime restored and verified against the release manifest.');
