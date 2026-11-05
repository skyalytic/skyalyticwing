'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const editions = require('../config/desktop-editions.json');
function profile(edition = 'community', platform = process.platform) {
  const spec = editions[edition];
  if (!spec) throw Error('Specify --edition community or --edition enterprise');
  const base = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  // Linux package/resource names remain stable ASCII identities. The desktop
  // template and window title carry the requested display name.
  const packageProduct = platform === 'linux' ? spec.linuxProductName : spec.productName;
  const result = {
    productName: packageProduct, mainBinaryName: spec.binaryName, identifier: spec.identifier,
    build: { devUrl: `http://localhost:${spec.port}` },
    app: {
      windows: base.app.windows.map(w => ({ ...w, title: `${spec.productName} v${base.version}` })),
      security: { csp: base.app.security.csp.replace(/\b910\b/g, String(spec.port)) },
    },
    plugins: { updater: { endpoints: [spec.updateEndpoint] } },
  };
  if (platform === 'linux') result.bundle = {
    externalBin: ['binaries/skyalyticwing-node'],
    linux: {
      deb: {
        postInstallScript: `linux/${edition}-postinst.sh`, postRemoveScript: `linux/${edition}-postrm.sh`,
        desktopTemplate: `linux/${edition}.desktop`,
        files: { '/usr/lib/SkyalyticWing/cli-bin/node': null, [`/usr/lib/${packageProduct}/cli-bin/node`]: 'linux/node' },
      },
      appimage: { files: { 'usr/lib/SkyalyticWing/cli-bin/node': null, [`usr/lib/${packageProduct}/cli-bin/node`]: 'linux/node' } },
    },
  };
  return result;
}
function cliScripts(edition, spec) {
  const paths = [spec.cliCommand, ...(spec.cliAliases || [])].map(name => "'/usr/local/bin/" + name + "'").join(' ');
  const marker = '# SkyalyticWing ' + edition + ' DEB managed CLI';
  const install = ['#!/bin/sh', 'set -eu', '[ "${1:-}" = configure ] || exit 0',
    "marker='" + marker + "'", 'for command in ' + paths + '; do',
    '  if [ -e "$command" ] || [ -L "$command" ]; then',
    '    if [ -L "$command" ] || ! grep -qxF "$marker" "$command"; then',
    "      echo 'CLI command belongs to another installation; not overwritten.' >&2", '      exit 1', '    fi', '  fi', 'done',
    'mkdir -p /usr/local/bin', 'for command in ' + paths + '; do',
    `  printf '%s\\n' '#!/bin/sh' "$marker" 'exec /usr/bin/${spec.binaryName} --wing-cli "$@"' > "$command"`,
    '  chmod 755 "$command"', 'done', ''].join('\n');
  const remove = ['#!/bin/sh', 'set -eu', 'case "${1:-}" in remove|purge) ;; *) exit 0 ;; esac',
    "marker='" + marker + "'", 'for command in ' + paths + '; do',
    '  if [ -f "$command" ] && [ ! -L "$command" ] && grep -qxF "$marker" "$command"; then',
    '    rm -- "$command"', '  fi', 'done', ''].join('\n');
  return {install, remove};
}
function writeProfiles() {
  for (const [edition, spec] of Object.entries(editions)) {
    fs.writeFileSync(path.join(root, `src-tauri/tauri.${edition}.json`), JSON.stringify(profile(edition, 'win32'), null, 2) + '\n');
    const cli = cliScripts(edition, spec);
    fs.writeFileSync(path.join(root, `src-tauri/linux/${edition}-postinst.sh`), cli.install);
    fs.writeFileSync(path.join(root, `src-tauri/linux/${edition}-postrm.sh`), cli.remove);
    fs.writeFileSync(path.join(root, `src-tauri/linux/${edition}.desktop`), `[Desktop Entry]\nType=Application\nName=${spec.productName}\nComment=Wing ${spec.label}\nExec=${spec.binaryName}\nIcon=${spec.binaryName}\nTerminal=false\nCategories=Office;Utility;\n`);
  }
}
module.exports = { editions, profile, writeProfiles };
if (require.main === module && process.argv.includes('--write')) writeProfiles();
