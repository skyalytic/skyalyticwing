#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${WING_DEPLOY_HOST:?Set WING_DEPLOY_HOST to user@host}"
if [ "$#" -ne 1 ]; then echo "Usage: deploy-updates.sh VERIFIED_ARTIFACT_DIRECTORY" >&2; exit 1; fi
node "$ROOT/scripts/check-release-policy.cjs"
node "$ROOT/scripts/publish-wing-release.cjs" "$1" "$WING_DEPLOY_HOST"
