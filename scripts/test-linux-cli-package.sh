#!/bin/bash
set -euo pipefail
deb="$1"
version="$(dpkg-deb -f "$deb" Version)"
temp="$(mktemp -d)"
trap 'rm -rf -- "$temp"' EXIT
dpkg-deb -x "$deb" "$temp/root"
dpkg-deb -e "$deb" "$temp/control"
test ! -e "$temp/root/usr/bin/node"
test -x "$temp/root/usr/bin/skyalyticwing-node"
"$temp/root/usr/lib/SkyalyticWing/cli-bin/node" --version | grep -qx 'v24.19.0'
test -f "$temp/control/postinst"
test -f "$temp/control/postrm"
grep -q '^Exec=/usr/bin/skyalyticwing$' "$temp/root/usr/share/applications/"*.desktop
"$temp/root/usr/bin/skyalyticwing" --wing-cli --version | grep -Fxq "$version"
mkdir "$temp/bin"
# Run the package's real hooks with only their filesystem destination redirected.
sed "s#/usr/local/bin#$temp/bin#g" "$temp/control/postinst" > "$temp/install.sh"
sed "s#/usr/local/bin#$temp/bin#g" "$temp/control/postrm" > "$temp/remove.sh"
bash "$temp/install.sh" configure
bash "$temp/install.sh" configure
test -x "$temp/bin/skyalyticwing"
bash "$temp/remove.sh" upgrade
test -x "$temp/bin/skyalyticwing"
bash "$temp/remove.sh" remove
test ! -e "$temp/bin/skyalyticwing"
printf 'another command\n' > "$temp/bin/skyalyticwing"
if bash "$temp/install.sh" configure; then echo 'Overwrote unrelated command'; exit 1; fi
bash "$temp/remove.sh" purge
grep -qx 'another command' "$temp/bin/skyalyticwing"
echo 'PASS packaged DEB CLI, headless launcher, installation, upgrade, removal and ownership protection'
