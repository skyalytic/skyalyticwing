// Installed desktop entrypoint. Mutable state belongs to the current OS user,
// never the read-only application resources directory (notably /usr/lib on Linux).
process.env.NODE_ENV = 'production';
process.env.SKYALYTICWING_DESKTOP = '1';
process.env.SKYALYTICWING_HOST = '127.0.0.1';
const { mkdirSync } = require('node:fs');
const editionFile = require('node:path').join(__dirname, 'product-edition.json');
if (require('node:fs').existsSync(editionFile)) {
  const product = JSON.parse(require('node:fs').readFileSync(editionFile, 'utf8'));
  if (!['community', 'enterprise'].includes(product.edition)) throw Error('Invalid desktop edition');
  if (process.env.SKYALYTICWING_EDITION && process.env.SKYALYTICWING_EDITION !== product.edition) throw Error('Native and backend editions do not match');
  process.env.SKYALYTICWING_EDITION = product.edition;
}
// DEB owns a system command through package hooks. DMG/AppImage register per user
// on first launch, pointing to the stable app/image rather than a temporary mount.
if (process.platform !== 'win32' && process.env.SKYALYTICWING_REGISTER_CLI !== '0' &&
    (process.platform === 'darwin' || process.env.APPIMAGE)) {
  try { require(require('node:path').resolve(__dirname, '../../web/bin/cli-registration.cjs')).install(); }
  catch (error) { console.error('[CLI registration] ' + error.message); }
}
const { getDefaultDataDir, migrateLegacyAppData } = require('./dist/modules/core/utils/web-data.util.js');
migrateLegacyAppData();
process.env.SKYALYTICWING_DATA_DIR ||= getDefaultDataDir();
process.env.SKYALYTICWING_WEB_DATA_DIR ||= process.env.SKYALYTICWING_EDITION ? require('node:path').join(getDefaultDataDir(), 'web') : getDefaultDataDir();
mkdirSync(process.env.SKYALYTICWING_WEB_DATA_DIR, { recursive: true });
require('./dist/main.js');
