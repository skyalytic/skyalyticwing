#!/bin/sh
set -eu
case "${1:-}" in remove|purge) ;; *) exit 0 ;; esac
command=/usr/local/bin/skyalyticwing
if [ -f "$command" ] && [ ! -L "$command" ] && grep -qxF '# SkyalyticWing DEB managed CLI' "$command"; then
  rm -- "$command"
fi
