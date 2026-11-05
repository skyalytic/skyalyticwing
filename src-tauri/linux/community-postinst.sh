#!/bin/sh
set -eu
[ "${1:-}" = configure ] || exit 0
marker='# SkyalyticWing community DEB managed CLI'
for command in '/usr/local/bin/skyalyticwing' '/usr/local/bin/wing-community'; do
  if [ -e "$command" ] || [ -L "$command" ]; then
    if [ -L "$command" ] || ! grep -qxF "$marker" "$command"; then
      echo 'CLI command belongs to another installation; not overwritten.' >&2
      exit 1
    fi
  fi
done
mkdir -p /usr/local/bin
for command in '/usr/local/bin/skyalyticwing' '/usr/local/bin/wing-community'; do
  printf '%s\n' '#!/bin/sh' "$marker" 'exec /usr/bin/SkyalyticWingCommunity --wing-cli "$@"' > "$command"
  chmod 755 "$command"
done
