#!/bin/sh
set -eu
[ "${1:-}" = configure ] || exit 0
command=/usr/local/bin/skyalyticwing
marker='# SkyalyticWing DEB managed CLI'
if [ -e "$command" ] || [ -L "$command" ]; then
  if [ -L "$command" ] || ! grep -qxF "$marker" "$command"; then
    echo 'Existing /usr/local/bin/skyalyticwing belongs to another installation; not overwritten.' >&2
    exit 1
  fi
fi
mkdir -p /usr/local/bin
printf '%s\n' '#!/bin/sh' "$marker" 'exec /usr/bin/skyalyticwing --wing-cli "$@"' > "$command"
chmod 755 "$command"
