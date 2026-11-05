#!/bin/bash
set -euo pipefail
app="$(realpath "${1:?AppDir required}")"
test -f "$app/usr/bin/skyalyticwing"
# DEB uses an absolute desktop entry to avoid resolving its CLI shim. AppImage
# must resolve the executable inside its own mount instead of the host /usr/bin.
python3 - "$app" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
for candidate in [*root.glob('*.desktop'), *root.glob('usr/share/applications/*.desktop')]:
    target = candidate.resolve()
    if not target.is_relative_to(root):
        raise RuntimeError('Desktop entry escapes AppDir')
    target.write_text(target.read_text().replace('Exec=/usr/bin/skyalyticwing', 'Exec=skyalyticwing'))
PY
mkdir -p "$app/usr/share/doc/wing-bundled-tools"
tools_root="${WING_LINUX_TOOLS_ROOT:-}"
args=()
for tool in xdotool wmctrl scrot; do
  args+=(--executable "$(command -v "$tool")")
  cp "$tools_root/usr/share/doc/$tool/copyright" "$app/usr/share/doc/wing-bundled-tools/$tool-copyright"
done
mkdir -p "$app/usr/lib/imlib2/loaders"
for format in png jpeg bmp webp; do
  loader="$tools_root/usr/lib/x86_64-linux-gnu/imlib2/loaders/$format.so"
  cp "$loader" "$app/usr/lib/imlib2/loaders/$format.so"
  args+=(--library "$app/usr/lib/imlib2/loaders/$format.so")
done
cp "$tools_root/usr/share/doc/libimlib2t64/copyright" "$app/usr/share/doc/wing-bundled-tools/imlib2-copyright"
# linuxdeploy copies the utilities and their shared libraries, and fixes RPATH.
# AppRun already adds AppDir/usr/bin to PATH for the backend's child processes.
APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 linuxdeploy-x86_64.AppImage --appdir "$app" "${args[@]}"
cat > "$app/apprun-hooks/wing-native-tools.sh" <<'HOOK'
export PATH="$this_dir/usr/bin:$PATH"
export IMLIB2_LOADER_PATH="$this_dir/usr/lib/imlib2/loaders"
HOOK
if ! grep -q wing-native-tools.sh "$app/AppRun"; then
  sed -i '/^exec /i source "$this_dir"/apprun-hooks/wing-native-tools.sh' "$app/AppRun"
fi
for tool in xdotool wmctrl scrot; do
  test -x "$app/usr/bin/$tool"
  if LD_LIBRARY_PATH="$app/usr/lib" ldd "$app/usr/bin/$tool" | grep -q 'not found'; then
    echo "Missing bundled dependency for $tool" >&2; exit 1
  fi
done
if [[ "${WING_PACKAGE_INTEGRITY_ONLY:-0}" != 1 ]]; then
test_file=$(mktemp /tmp/wing-scrot-XXXXXX.png)
env PATH="$app/usr/bin:/usr/bin:/bin" LD_LIBRARY_PATH="$app/usr/lib" IMLIB2_LOADER_PATH="$app/usr/lib/imlib2/loaders" xvfb-run -a "$app/usr/bin/scrot" --overwrite "$test_file"
test -s "$test_file"
fi
echo 'PASS: Linux desktop automation utilities and their dependencies bundled'
