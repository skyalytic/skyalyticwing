#!/bin/bash
set -euo pipefail
: "${TARGET:?TARGET is required}"
root="$PWD"
node scripts/check-packaging-policy.cjs
: "${SKYALYTICWING_EDITION:?SKYALYTICWING_EDITION is required}"
product="$(node -e 'console.log(require("./config/desktop-editions.json")[process.env.SKYALYTICWING_EDITION].productName)')"
binary="$(node -e 'console.log(require("./config/desktop-editions.json")[process.env.SKYALYTICWING_EDITION].binaryName)')"
port="$(node -e 'console.log(require("./config/desktop-editions.json")[process.env.SKYALYTICWING_EDITION].port)')"
app="$root/src-tauri/target/$TARGET/release/bundle/macos/$product.app"
test -d "$app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
python3 scripts/audit-macos-runtime.py "$app"
mkdir -p output

# Sign nested native modules before the app envelope. This is explicitly an
# ad-hoc test signature, not Developer ID signing or Apple notarization.
binary_list="$(mktemp "$RUNNER_TEMP/wing-signing.XXXXXX")"
python3 - "$app" > "$binary_list" <<'PY'
import os, sys
magic = {bytes.fromhex(value) for value in (
    'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
    'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}
for directory, _, files in os.walk(sys.argv[1]):
    for name in files:
        filename = os.path.join(directory, name)
        if os.path.islink(filename):
            continue
        with open(filename, 'rb') as stream:
            if stream.read(4) in magic:
                sys.stdout.buffer.write(os.fsencode(filename) + b'\0')
PY
while IFS= read -r -d '' binary; do
  if file -b "$binary" | grep -q 'Mach-O'; then
    codesign --force --sign - --timestamp=none --entitlements src-tauri/entitlements.mac.plist "$binary"
  fi
done < "$binary_list"
node scripts/test-bundled-ffmpeg.cjs "$app/Contents/Resources/_up_/packages/backend/deploy/vendor/ffmpeg" --record-macos-signatures
codesign --force --sign - --timestamp=none --entitlements src-tauri/entitlements.mac.plist "$app"
codesign --verify --deep --strict --verbose=2 "$app"

runtime="$app/Contents/MacOS/node"
deploy="$app/Contents/Resources/_up_/packages/backend/deploy"
test -f "$runtime"
test -f "$deploy/desktop-main.cjs"
node scripts/test-cli-registration.cjs
"$runtime" "$app/Contents/Resources/_up_/packages/web/bin/skyalyticwing.cjs" --version
if [[ "${WING_PACKAGE_INTEGRITY_ONLY:-0}" != 1 ]]; then
node scripts/test-desktop-deploy.cjs "$deploy" "$runtime"
node scripts/test-desktop-documents.cjs "$deploy"
env PYTHONDONTWRITEBYTECODE=1 "$deploy/python/bin/python3" -I -B -c 'import ssl,sqlite3,ctypes,lzma,bz2,zlib,venv,ensurepip,pip; print("PASS: packaged Python standard extensions and pip")'
"$runtime" scripts/test-bundled-python.cjs "$deploy"

# Start the actual native app with an isolated profile, then test local readiness.
export SKYALYTICWING_PROFILE_ROOT="$(mktemp -d "$RUNNER_TEMP/wing-macos-qa.XXXXXX")"
profile="$SKYALYTICWING_PROFILE_ROOT/$binary"
mkdir -p "$profile"
export SKYALYTICWING_DATA_DIR="$profile"
export SKYALYTICWING_REGISTER_CLI=0
printf '%s' '{interrupted-session-write' > "$profile/sessions.json"
app_pid=''
cleanup() {
  if [[ -n "$app_pid" ]]; then
    pkill -TERM -P "$app_pid" || true
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
"$app/Contents/MacOS/$executable" > "$profile/native.log" 2>&1 &
app_pid=$!
ready=false
for i in {1..60}; do
  if curl --noproxy '*' --silent --fail "http://127.0.0.1:$port/health" > /dev/null; then ready=true; break; fi
  kill -0 "$app_pid" || { tail -n 80 "$profile/native.log"; exit 1; }
  sleep 1
done
if [[ "$ready" != true ]]; then tail -n 80 "$profile/native.log"; exit 1; fi
python3 - "$profile" <<'PY'
import json, pathlib, sys
profile = pathlib.Path(sys.argv[1])
notice = json.loads((profile / 'session-recovery.json').read_text())
assert (pathlib.Path(notice['archiveDirectory']) / 'sessions.json').read_bytes() == b'{interrupted-session-write'
assert json.loads((profile / 'sessions.json').read_text()) == {}
print('PASS: native macOS app starts with broken sessions and no backup; original bytes preserved')
PY
cleanup
app_pid=''
unset SKYALYTICWING_DATA_DIR
unset SKYALYTICWING_PROFILE_ROOT
fi

stage="$(mktemp -d "$RUNNER_TEMP/wing-dmg.XXXXXX")"
ditto "$app" "$stage/$product.app"
ln -s /Applications "$stage/Applications"
sed "s/^edition=\"legacy\"/edition=\"$SKYALYTICWING_EDITION\"/" scripts/uninstall-macos.command > "$stage/卸载 Wing.command"
chmod +x "$stage/卸载 Wing.command"
arch='arm64'
[[ "$TARGET" == x86_64-* ]] && arch='x64'
dmg="output/${binary}_${version}_${arch}.dmg"
hdiutil create -volname "$product" -srcfolder "$stage" -ov -format UDZO "$dmg"
hdiutil verify "$dmg"
codesign --force --sign - --timestamp=none "$dmg"
codesign --verify --verbose=2 "$dmg"
COPYFILE_DISABLE=1 tar -czf "output/${binary}_${version}_${arch}.app.tar.gz" -C "$(dirname "$app")" "$product.app"
tar -tzf "output/${binary}_${version}_${arch}.app.tar.gz" > /dev/null
cat > output/README.txt <<EOF
SkyalyticWing ${version} for macOS
Publisher metadata: 杭州穹析科技有限公司 / Skyalytic
Code signature: ad-hoc. Developer ID / Apple notarization: not configured.
Checks: native runtime dependencies, nested code signatures and DMG integrity.
Functional startup checks skipped when WING_PACKAGE_INTEGRITY_ONLY=1.
Publication is performed separately after all platform artifacts are ready.
EOF
(cd output && shasum -a 256 ./*.dmg ./*.app.tar.gz > SHA256SUMS.txt)
echo 'PASS: macOS packaging, ad-hoc signatures and DMG integrity'
