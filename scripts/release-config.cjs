const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function releaseConfig(base = root) {
  const read = name => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
  const app = read('src-tauri/tauri.conf.json');
  const version = read('package.json').version;
  const cargo = fs.readFileSync(path.join(base, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(version) || app.version !== version || cargo !== version) {
    throw Error('Application versions disagree: package.json, tauri.conf.json and Cargo.toml must match.');
  }
  const baseUrl = process.env.WING_RELEASE_BASE_URL || `https://downloads.example.com/wing-${version}/`;
  if (!/^https:\/\/[^\s]+\/$/.test(baseUrl)) throw Error('WING_RELEASE_BASE_URL must be an HTTPS URL ending in /');
  return { version, policy: read('config/release-policy.json'), baseUrl };
}
function assertPublish(version, base = root) {
  const config = releaseConfig(base);
  if (version !== config.version || config.policy.version !== version || config.policy.publicReleaseAllowed !== true || config.policy.updateFeedAllowed !== true) {
    throw Error(`Release blocked: Wing ${version} requires explicit acceptance for this version. Local source checks are allowed; packaging/publication are deferred.`);
  }
  return config;
}
module.exports = { releaseConfig, assertPublish };
if (require.main === module) console.log(releaseConfig().version);
