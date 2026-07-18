#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/lexx/hermes-workspace/hermes-usage-dashboard"
cd "$REPO"

LOCKDIR="$REPO/.runtime/publish.lock"
mkdir -p "$REPO/.runtime"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

python3 generate_usage_data.py >/dev/null

if git diff --quiet -- usage-data.json; then
  exit 0
fi

git add usage-data.json
git commit -m "chore: refresh usage data" >/dev/null
git push origin main >/dev/null
