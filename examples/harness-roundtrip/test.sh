#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$DIR/.work"
RIT_FILE="$WORK/roundtrip.rit"
SOURCE_DIR="C:/Users/Zora/Projects/harness/src"
OUTPUT_DIR="$WORK/output"

echo "=== Harness Roundtrip Fidelity Test ==="
echo ""

# Clean previous run
rm -rf "$WORK"
mkdir -p "$WORK"

# Ingest
echo "--- Ingesting from $SOURCE_DIR ---"
bun run "$DIR/../roundtrip-test/ingest.ts" "$SOURCE_DIR" "$RIT_FILE"
echo ""

# Materialize
echo "--- Materializing ---"
bun run "$DIR/../roundtrip-test/materialize.ts" "$RIT_FILE" "$OUTPUT_DIR"
echo ""

# Compare
echo "--- Comparing ---"
bun run "$DIR/../roundtrip-test/compare.ts" "$SOURCE_DIR" "$OUTPUT_DIR" || true
