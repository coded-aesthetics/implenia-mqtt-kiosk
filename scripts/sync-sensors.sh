#!/usr/bin/env bash
# Sync herstellen sensor CSVs from implenia-web into this project.
# Run from the repo root: ./scripts/sync-sensors.sh
#
# Exits non-zero if the source directory is missing or files differ after copy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="${IMPLENIA_WEB_DIR:-$REPO_ROOT/../implenia-web}/app/assets"
DST="$REPO_ROOT/server/assets/sensors"

if [ ! -d "$SRC" ]; then
  echo "ERROR: Source directory not found: $SRC"
  echo "Set IMPLENIA_WEB_DIR to point to the implenia-web checkout."
  exit 1
fi

check_only=false
if [ "${1:-}" = "--check" ]; then
  check_only=true
fi

changed=0
for csv in "$SRC"/*-sensors-herstellen.csv; do
  name=$(basename "$csv")
  dest="$DST/$name"

  if [ ! -f "$dest" ]; then
    echo "NEW: $name"
    changed=1
  elif ! diff -q "$csv" "$dest" > /dev/null 2>&1; then
    echo "CHANGED: $name"
    changed=1
  fi
done

if [ "$check_only" = true ]; then
  if [ "$changed" -eq 1 ]; then
    echo ""
    echo "Sensor CSVs are out of sync. Run ./scripts/sync-sensors.sh to update."
    exit 1
  else
    echo "Sensor CSVs are in sync."
    exit 0
  fi
fi

cp "$SRC"/*-sensors-herstellen.csv "$DST/"
echo "Synced sensor CSVs from $SRC → $DST"
