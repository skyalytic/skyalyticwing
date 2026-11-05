/** Assemble the pinned local Office runtime; no user document is sent off-device. */
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  zlib = require('node:zlib');
const root = path.resolve(__dirname, '..'),
  source = path.join(root, 'deploy/office-wasm'),
  cache = path.join(root, 'build/office-wasm-inputs');
const output = path.resolve(process.argv[2] || path.join(root, 'build/office-wasm-runtime'));
const lock = JSON.parse(fs.readFileSync(path.join(source, 'runtime-lock.json')));
const { patchOfficeUiFont, qtUiFontPath } = require('./office-ui-font.cjs');
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function input(record) {
  const file = path.join(cache, record.name);
  let bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!bytes || digest(bytes) !== record.sha256) {
    const r = await fetch(record.url);
    if (!r.ok) throw Error(record.name + ': HTTP ' + r.status);
    bytes = Buffer.from(await r.arrayBuffer());
    if (digest(bytes) !== record.sha256)
      throw Error(
        record.name +
          ' changed upstream; review and update the runtime lock before using a different engine.',
      );
    fs.writeFileSync(file, bytes);
  }
  return bytes;
}
function debData(ar) {
  if (ar.subarray(0, 8).toString() !== '!<arch>\n') throw Error('Invalid locale archive');
  for (let offset = 8; offset + 60 < ar.length;) {
    const header = ar.subarray(offset, offset + 60),
      name = header.subarray(0, 16).toString().trim().replace(/\/$/, ''),
      size = Number(header.subarray(48, 58).toString().trim());
    offset += 60;
    const b = ar.subarray(offset, offset + size);
    if (name === 'data.tar.zst') return zlib.zstdDecompressSync(b);
    offset += size + (size % 2);
  }
  throw Error('Locale data missing');
}
function tarFiles(tar) {
  const entries = [];
  for (let offset = 0; offset + 512 < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (!header.some(Boolean)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, ''),
      size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    offset += 512;
    if (header[156] === 48 || header[156] === 0)
      entries.push({ name, bytes: tar.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}
(async () => {
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const data = {};
  for (const record of lock.inputs) data[record.name] = await input(record);
  const metadata = JSON.parse(data['soffice.data.js.metadata']);
  const chunks = [data['soffice.data']];
  let offset = chunks[0].length;
  function add(filename, bytes) {
    let entry = metadata.files.find((x) => x.filename === filename);
    if (!entry) {
      entry = { filename };
      metadata.files.push(entry);
    }
    entry.start = offset;
    entry.end = offset + bytes.length;
    chunks.push(bytes);
    offset += bytes.length;
  }
  add('/instdir/share/fonts/truetype/NotoSansCJKsc-Regular.otf', data['NotoSansCJKsc-Regular.otf']);
  add('/instdir/share/fonts/truetype/NotoSerifCJKsc-Regular.otf', data['NotoSerifCJKsc-Regular.otf']);
  // Reuse the same archive bytes for Qt's separate UI font database.
  const cjk = metadata.files.find((x) => x.filename === '/instdir/share/fonts/truetype/NotoSansCJKsc-Regular.otf');
  metadata.files.push({ ...cjk, filename: qtUiFontPath });
  for (const entry of tarFiles(debData(data['office-zh-CN.deb']))) {
    const marker = entry.name.indexOf('libreoffice/');
    if (marker >= 0 && /zh[_-]CN/.test(entry.name)) {
      let target = '/instdir/' + entry.name.slice(marker + 'libreoffice/'.length);
      target = target.replace('/share/.registry/', '/share/registry/');
      if (!target.includes('..') && !target.includes('/doc/')) add(target, entry.bytes);
    }
    if (/\/copyright$/.test(entry.name))
      fs.writeFileSync(path.join(output, 'LIBREOFFICE-L10N-COPYRIGHT.txt'), entry.bytes);
  }
  const version = metadata.files.find((x) => x.filename === '/instdir/program/versionrc');
  if (version)
    add(
      version.filename,
      Buffer.from(
        data['soffice.data']
          .subarray(version.start, version.end)
          .toString()
          .replace('AllLanguages=en-US', 'AllLanguages=en-US zh-CN'),
      ),
    );
  metadata.remote_package_size = offset;
  // A neutral font-name list is more legible than mixed-script sample text.
  // Keep all fonts available for documents that need them.
  const registry = metadata.files.find(x => x.filename === '/instdir/share/registry/main.xcd');
  if (!registry) throw Error('Office font preferences are missing');
  const registryText = data['soffice.data'].subarray(registry.start, registry.end).toString();
  const fontPreview = /(<prop oor:name="ShowFontBoxWYSIWYG"[^>]*>[\s\S]*?<value>)true(<\/value>)/;
  if (!fontPreview.test(registryText)) throw Error('Office font preview preference changed');
  add(registry.filename, Buffer.from(registryText.replace(fontPreview, '$1false$2')));
  metadata.remote_package_size = offset;
  fs.writeFileSync(path.join(output, 'soffice.data'), Buffer.concat(chunks));
  fs.writeFileSync(path.join(output, 'soffice.data.js.metadata'), JSON.stringify(metadata));
  const before = 'var files=metadata["files"];for(var i=0;i<files.length;++i){new DataRequest';
  const after =
    'var files=metadata["files"];for(var i=0;i<files.length;++i){Module["FS_createPath"]("/",files[i]["filename"].substring(1,files[i]["filename"].lastIndexOf("/")),true,true);new DataRequest';
  const loader = data['soffice.js'].toString();
  if (!loader.includes(before)) throw Error('Office loader format changed');
  fs.writeFileSync(path.join(output, 'soffice.js'), loader.replace(before, after));
  const uiFont = patchOfficeUiFont(data['soffice.wasm']);
  fs.writeFileSync(path.join(output, 'soffice.wasm'), uiFont.bytes);
  fs.copyFileSync(path.join(__dirname, 'office-ui-font.cjs'), path.join(output, 'office-ui-font.cjs'));
  for (const name of ['zeta.js', 'ZETAJS-LICENSE.txt', 'Noto-OFL.txt', 'NotoSerif-OFL.txt'])
    fs.writeFileSync(path.join(output, name), data[name]);
  for (const name of [
    'host.js',
    'input.js',
    'worker.js',
    'index.html',
    'editor.css',
    'THIRD-PARTY-NOTICES.txt',
  ])
    fs.copyFileSync(path.join(source, name), path.join(output, name));
  const files = fs
    .readdirSync(output)
    .filter((name) => name !== 'manifest.json')
    .map((name) => {
      const b = fs.readFileSync(path.join(output, name));
      return { name, bytes: b.length, sha256: digest(b) };
    });
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    JSON.stringify({ build: lock.build, inputs: lock.inputs, patches: [uiFont.patch], files }, null, 2),
  );
  console.log('Local Office prepared: ' + output);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
