#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$DIR/.work"
RIT_FILE="$WORK/roundtrip.rit"
SOURCE_DIR="$WORK/source/src"
OUTPUT_DIR="$WORK/output"

echo "=== Roundtrip Fidelity Test ==="
echo ""

# Clean previous run
rm -rf "$WORK"
mkdir -p "$WORK"

# Clone target project
echo "Cloning superjson..."
git clone --depth 1 https://github.com/flightcontrolhq/superjson.git "$WORK/source" 2>&1 | tail -1
echo ""

# Ingest
echo "--- Ingesting ---"
bun run "$DIR/ingest.ts" "$SOURCE_DIR" "$RIT_FILE"
echo ""

# Materialize
echo "--- Materializing ---"
bun run "$DIR/materialize.ts" "$RIT_FILE" "$OUTPUT_DIR"
echo ""

# Compare
echo "--- Comparing ---"
bun run "$DIR/compare.ts" "$SOURCE_DIR" "$OUTPUT_DIR" || true
