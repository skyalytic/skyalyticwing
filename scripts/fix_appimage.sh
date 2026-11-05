#!/bin/sh
# Legacy entry point: use this edition's reviewed payload and release-policy gates.
set -eu
edition_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$edition_root"
# Never collect the parent checkout, signing files or another edition's build output.
exec node scripts/build-desktop.cjs --target x86_64-unknown-linux-gnu "$@"
