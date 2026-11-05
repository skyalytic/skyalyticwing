#!/usr/bin/env bash
set -euo pipefail
# Dedicated Ubuntu 24.04 x86_64 instance, loopback by default. No public reverse proxy changes.
cd -- "$(dirname -- "$(readlink -f -- "$0")")"
test "$(id -u)" = 0 || { echo 'Run as root on the private Office host.'; exit 1; }
test "$(dpkg --print-architecture)" = amd64 || { echo 'This kit is for amd64.'; exit 1; }
sha256sum --check SHA256SUMS
test -n "${WING_WOPI_ORIGIN:-}" && test -n "${WING_FRAME_ORIGIN:-}" || { echo 'Set WING_WOPI_ORIGIN and WING_FRAME_ORIGIN to the Wing backend and frontend origins.'; exit 1; }
python3 - <<'PY'
import os, urllib.parse
for key in ['WING_WOPI_ORIGIN','WING_FRAME_ORIGIN']:
    u=urllib.parse.urlsplit(os.environ[key])
    if u.scheme not in ('http','https') or not u.netloc or u.username or u.password or u.path not in ('','/') or u.query or u.fragment:
        raise SystemExit('Invalid origin: '+key)
PY
if dpkg-query -W -f='${db:Status-Status}' code-brand 2>/dev/null | grep -qx installed; then
  echo 'This host contains code-brand. Use a dedicated host without the proprietary brand package.'; exit 1
fi
if systemctl is-active --quiet coolwsd; then
  echo 'An Office service already runs here. Back up and upgrade that deployment explicitly.'; exit 1
fi
systemctl mask coolwsd >/dev/null
trap 'systemctl unmask coolwsd >/dev/null' EXIT
apt-get update
# Local packages are pinned and hashed. The OS resolves its normal shared-library dependencies.
apt-get install -y --no-install-recommends ./packages/*.deb fonts-noto-cjk python3
cp -a /etc/coolwsd/coolwsd.xml "/etc/coolwsd/coolwsd.xml.wing-backup-$(date +%s)"
python3 - <<'PY'
import os,xml.etree.ElementTree as E
path='/etc/coolwsd/coolwsd.xml';tree=E.parse(path);root=tree.getroot()
for key,value in {'net/listen':'loopback','net/proto':'IPv4','ssl/enable':'false','ssl/termination':'false','logging/level':'warning','net/frame_ancestors':os.environ['WING_FRAME_ORIGIN']}.items():
    node=root.find(key)
    if node is not None: node.text=value
groups=root.find('storage/wopi/alias_groups')
if groups is None: raise SystemExit('Unsupported Office configuration schema')
groups.clear();groups.set('mode','groups');group=E.SubElement(groups,'group')
E.SubElement(group,'host',{'allow':'true'}).text=os.environ['WING_WOPI_ORIGIN']
tree.write(path,encoding='UTF-8',xml_declaration=True)
PY
systemctl unmask coolwsd >/dev/null
trap - EXIT
systemctl enable --now coolwsd
echo 'Office companion installed on loopback port 9980. Configure Wing and verify load/edit/save/reopen.'
echo 'For a separate host, configure a private HTTPS reverse proxy and explicit WOPI/frame origins; no public ingress was opened.'
