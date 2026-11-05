const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { patchOfficeUiFont, qtUiFontPath } = require('../scripts/office-ui-font.cjs');
const root = path.resolve(__dirname, '..');
const assets = path.resolve(process.env.OFFICE_QA_ASSETS || path.join(root, 'build/office-wasm-runtime'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('only the pinned Qt font path changes; engine code and offsets stay intact', () => {
  const original = fs.readFileSync(path.join(root, 'build/office-wasm-inputs/soffice.wasm'));
  const { bytes, patch } = patchOfficeUiFont(original);
  assert.equal(bytes.length, original.length);
  assert.deepEqual(bytes.subarray(0, patch.offset), original.subarray(0, patch.offset));
  assert.deepEqual(bytes.subarray(patch.offset + patch.bytes), original.subarray(patch.offset + patch.bytes));
  assert.equal(bytes.subarray(patch.offset, patch.offset + patch.bytes).toString('utf16le'), qtUiFontPath);
  assert.deepEqual(fs.readFileSync(path.join(assets, 'soffice.wasm')), bytes);
  assert.throws(() => patchOfficeUiFont(bytes), /Unreviewed Office engine/);
  assert.throws(() => patchOfficeUiFont(Buffer.alloc(8)), /Unreviewed Office engine/);
});

test('Qt and document font paths share the complete pinned CJK font in the archive', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(assets, 'soffice.data.js.metadata')));
  const qt = metadata.files.filter(f => f.filename === qtUiFontPath);
  const document = metadata.files.find(f => f.filename === '/instdir/share/fonts/truetype/NotoSansCJKsc-Regular.otf');
  assert.equal(qt.length, 1);
  assert.equal(qt[0].start, document.start);
  assert.equal(qt[0].end, document.end);
  const data = fs.readFileSync(path.join(assets, 'soffice.data'));
  assert.equal(data.length, metadata.remote_package_size);
  assert.equal(hash(data.subarray(qt[0].start, qt[0].end)),
    '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b');
});

test('distribution manifest and font patch recipe match the shipped assets', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json')));
  assert.equal(manifest.patches[0].to, qtUiFontPath);
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(assets, entry.name));
    assert.equal(bytes.length, entry.bytes, entry.name);
    assert.equal(hash(bytes), entry.sha256, entry.name);
  }
  assert.deepEqual(fs.readFileSync(path.join(assets, 'office-ui-font.cjs')),
    fs.readFileSync(path.join(root, 'scripts/office-ui-font.cjs')));
});
