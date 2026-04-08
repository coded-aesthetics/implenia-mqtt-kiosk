#!/usr/bin/env bash
# Downloads the small German Vosk model and packages it as a tar.gz
# for vosk-browser. Places the result in ui/public/vosk-model-de.tar.gz
set -euo pipefail

MODEL_NAME="vosk-model-small-de-0.15"
MODEL_URL="https://alphacephei.com/vosk/models/${MODEL_NAME}.zip"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="${ROOT_DIR}/ui/public"
OUT_FILE="${OUT_DIR}/vosk-model-de.tar.gz"

mkdir -p "$OUT_DIR"

if [ -f "$OUT_FILE" ]; then
  echo "Model already exists at $OUT_FILE"
  exit 0
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading ${MODEL_NAME}..."
curl -L -o "${TMPDIR}/model.zip" "$MODEL_URL"

echo "Extracting..."
unzip -q "${TMPDIR}/model.zip" -d "$TMPDIR"

echo "Repackaging as tar.gz (vosk-browser format)..."
# vosk-browser expects the archive to contain a top-level 'model' directory
mv "${TMPDIR}/${MODEL_NAME}" "${TMPDIR}/model"
tar -czf "$OUT_FILE" -C "$TMPDIR" model

echo "Done: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
