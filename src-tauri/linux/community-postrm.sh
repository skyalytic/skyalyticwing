#!/bin/sh
set -eu
case "${1:-}" in remove|purge) ;; *) exit 0 ;; esac
marker='# SkyalyticWing community DEB managed CLI'
for command in '/usr/local/bin/skyalyticwing' '/usr/local/bin/wing-community'; do
  if [ -f "$command" ] && [ ! -L "$command" ] && grep -qxF "$marker" "$command"; then
    rm -- "$command"
  fi
done
