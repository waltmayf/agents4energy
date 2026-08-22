#!/usr/bin/env bash
# Deploy a pack (see packs/README.md) against the deployed backend.
#
# Usage:
#   ./scripts/deploy-pack.sh <pack-id> [--dry-run]
#
# Examples:
#   ./scripts/deploy-pack.sh example-pack
#   ./scripts/deploy-pack.sh example-pack --dry-run

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PACK_ID=""
EXTRA_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    EXTRA_ARGS+=("--dry-run")
  elif [[ -z "$PACK_ID" ]]; then
    PACK_ID="$arg"
  fi
done

if [[ -z "$PACK_ID" ]]; then
  echo "Usage: $0 <pack-id> [--dry-run]" >&2
  exit 1
fi

PACK_JSON="$REPO_ROOT/packs/$PACK_ID/pack.json"
if [[ ! -f "$PACK_JSON" ]]; then
  echo "Error: $PACK_JSON not found." >&2
  exit 1
fi

exec npx tsx "$REPO_ROOT/scripts/deploy-pack.ts" "$PACK_JSON" "${EXTRA_ARGS[@]}"
