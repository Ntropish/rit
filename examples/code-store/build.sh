#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRY="${1:?Usage: build.sh <entrypoint>  (e.g. main.ts or rit:utils)}"

# Resolve file-based entrypoints relative to the project directory
if [[ ! "$ENTRY" == rit:* ]]; then
  ENTRY="$DIR/$ENTRY"
fi

exec bun run "$DIR/_build.ts" "$ENTRY" "$DIR/code-store.rit"
