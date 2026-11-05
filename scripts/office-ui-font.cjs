/**
 * Qt 5's WASM font database loads three fixed resource fonts, independently of
 * LibreOffice's fontconfig directory. Redirect its proportional DejaVu entry
 * to the bundled CJK font in Emscripten's filesystem. The two other Qt fonts
 * (Vera and DejaVu Sans Mono) remain available for Latin text and symbols.
 *
 * This changes one UTF-16 path literal only: equal length, no instruction,
 * section size, memory address or QString length changes. Fail closed on any
 * upstream binary change; never apply this to an unreviewed engine build.
 * Upstream: qtbase/src/plugins/platforms/wasm/qwasmfontdatabase.cpp
 */
const crypto = require('node:crypto');
const engineHash = '9ebd9a487e849a24b9c69f843ebdb451709c27b7722c010e36846433474a5bd4';
const from = ':/fonts/DejaVuSans.ttf';
const to = '/fonts/NotoSansCJK.otf';
function patchOfficeUiFont(input) {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  if (hash !== engineHash) throw Error('Unreviewed Office engine for Qt UI font patch');
  const before = Buffer.from(from, 'utf16le'), after = Buffer.from(to, 'utf16le');
  const offset = input.indexOf(before);
  if (before.length !== after.length || offset < 0 || input.indexOf(before, offset + 1) >= 0)
    throw Error('Qt UI font path is missing, ambiguous, or has changed length');
  const bytes = Buffer.from(input);
  after.copy(bytes, offset);
  return { bytes, patch: { name: 'qt-wasm-cjk-ui-font', offset, from, to, bytes: after.length } };
}
module.exports = { patchOfficeUiFont, qtUiFontPath: to };
