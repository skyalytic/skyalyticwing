import { SOURCE_EDITION } from '../utils/desktop-edition.js';

export const REMOTE_NODE_VERSION = '22.22.2';
export const REMOTE_RG_VERSION = '14.1.1';

// Fixed upstream archives and digests make preparation repeatable across connections.
export const REMOTE_RUNTIME_ASSETS = {
  'Linux:x86_64': {
    node: ['linux-x64', '978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3'],
    rg: [
      'x86_64-unknown-linux-musl',
      '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e',
    ],
  },
  'Linux:aarch64': {
    node: ['linux-arm64', 'b2f3a96f31486bfc365192ad65ced14833ad2a3c2e1bcefec4846902f264fa28'],
    rg: [
      'aarch64-unknown-linux-gnu',
      'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f',
    ],
  },
  'Darwin:x86_64': {
    node: ['darwin-x64', '12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba'],
    rg: ['x86_64-apple-darwin', 'fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3'],
  },
  'Darwin:arm64': {
    node: ['darwin-arm64', 'db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000'],
    rg: [
      'aarch64-apple-darwin',
      '24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be',
    ],
  },
} as const;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** Preparation changes only the current user's edition-specific runtime directory. */
export function remoteRuntimeShell(
  command: string[],
  relay?: { kind: 'node' | 'rg'; target: string },
): string {
  const cases = Object.entries(REMOTE_RUNTIME_ASSETS)
    .map(
      ([platform, asset]) =>
        platform +
        ') node_target=' +
        asset.node[0] +
        '; node_sha=' +
        asset.node[1] +
        '; rg_target=' +
        asset.rg[0] +
        '; rg_sha=' +
        asset.rg[1] +
        ';;',
    )
    .join('\n');
  return [
    'set -eu',
    'umask 077',
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'case "$(uname -s):$(uname -m)" in',
    cases,
    '*) fail "Unsupported remote platform; Linux/macOS x64 or arm64 required";;',
    'esac',
    'test -n "${HOME:-}" && test "${HOME#/}" != "$HOME" || fail "An absolute remote HOME is required"',
    'runtime="$HOME/.local/share/skyalyticwing-' + SOURCE_EDITION + '/remote-runtime"',
    'node_home="$runtime/node-' + REMOTE_NODE_VERSION + '"',
    'rg_home="$runtime/rg-' + REMOTE_RG_VERSION + '"',
    'export PATH="$node_home/bin:$rg_home:$PATH"',
    'checksum() {',
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d " " -f 1',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d " " -f 1',
    '  else fail "Remote SHA-256 utility is required"; fi',
    '}',
    // Each installer owns its lock and staging directory.
    'install_asset() (',
    '  dest="$1"; url="$2"; digest="$3"; executable="$4"; mirror="${5:-}"',
    '  mkdir -p "$runtime"',
    '  lock="$dest.lock"; attempts=0',
    '  until mkdir "$lock" 2>/dev/null; do',
    '    if test -x "$dest/$executable"; then exit 0; fi',
    '    attempts=$((attempts + 1)); test "$attempts" -lt 120 || fail "Remote runtime preparation is busy"',
    '    sleep 1',
    '  done',
    '  stage=""',
    '  cleanup() { if test -n "$stage"; then rm -rf -- "$stage"; fi; rmdir "$lock"; }',
    '  trap cleanup EXIT; trap "exit 1" HUP INT TERM',
    '  if test -x "$dest/$executable"; then "$dest/$executable" --version >/dev/null; exit 0; fi',
    '  test ! -e "$dest" || fail "Incomplete remote runtime; inspect $dest"',
    '  stage="$(mktemp -d "$runtime/.install.XXXXXXXX")"',
    '  speed_floor=1; if test -n "$mirror"; then speed_floor=200000; fi',
    '  download() {',
    '    if test "$1" = stdin; then cat > "$stage/archive.tgz"; return; fi',
    '    if command -v curl >/dev/null 2>&1; then',
    '      curl --fail --location --silent --show-error --proto "=https" --proto-redir "=https" --connect-timeout 15 --speed-limit "$speed_floor" --speed-time 15 --max-time 120 "$1" -o "$stage/archive.tgz"',
    '    elif command -v wget >/dev/null 2>&1; then',
    '      wget --https-only --timeout=30 --tries=1 -q -O "$stage/archive.tgz" "$1"',
    '    else return 1; fi',
    '  }',
    '  if ! download "$url"; then',
    '    if ! { test -n "$mirror" && download "$mirror"; }; then',
    '      if test "$executable" = bin/node; then fail "WING_RUNTIME_DOWNLOAD_FAILED:node:$node_target"; else fail "WING_RUNTIME_DOWNLOAD_FAILED:rg:$rg_target"; fi',
    '    fi',
    '  fi',
    '  test "$(checksum "$stage/archive.tgz")" = "$digest" || fail "Remote runtime checksum mismatch"',
    '  mkdir "$stage/unpacked"',
    '  tar -xzf "$stage/archive.tgz" -C "$stage/unpacked" --strip-components=1',
    '  test -x "$stage/unpacked/$executable" || fail "Runtime archive is incomplete"',
    '  "$stage/unpacked/$executable" --version >/dev/null || fail "Runtime is incompatible with this host"',
    '  mv "$stage/unpacked" "$dest"',
    ')',
    ...(relay
      ? [
          'test "$' +
            relay.kind +
            '_target" = ' +
            quote(relay.target) +
            ' || fail "Runtime platform changed"',
          relay.kind === 'node'
            ? 'install_asset "$node_home" stdin "$node_sha" bin/node'
            : 'install_asset "$rg_home" stdin "$rg_sha" rg',
        ]
      : [
          'if ! command -v node >/dev/null 2>&1 || ! node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)\' >/dev/null 2>&1; then',
          '  install_asset "$node_home" "https://nodejs.org/dist/v' +
            REMOTE_NODE_VERSION +
            '/node-v' +
            REMOTE_NODE_VERSION +
            '-$node_target.tar.gz" "$node_sha" bin/node "https://cdn.npmmirror.com/binaries/node/v' +
            REMOTE_NODE_VERSION +
            '/node-v' +
            REMOTE_NODE_VERSION +
            '-$node_target.tar.gz"',
          'fi',
          'if ! command -v rg >/dev/null 2>&1; then',
          '  install_asset "$rg_home" "https://github.com/BurntSushi/ripgrep/releases/download/' +
            REMOTE_RG_VERSION +
            '/ripgrep-' +
            REMOTE_RG_VERSION +
            '-$rg_target.tar.gz" "$rg_sha" rg',
          'fi',
        ]),
    'exec ' + command.map(quote).join(' '),
  ].join('\n');
}
