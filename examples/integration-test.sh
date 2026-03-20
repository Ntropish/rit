#!/usr/bin/env bash
# End-to-end integration test: ingest radio catalog, serve, clone, modify, push back.
# Run from the rit project root: bash examples/integration-test.sh

set -euo pipefail

RIT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RADIO_CATALOG_SRC="C:/Users/Zora/Projects/radio-catalog/src"
SERVER_RIT="/tmp/radio-catalog-e2e.rit"
CLONE_RIT="/tmp/local-clone-e2e.rit"
PORT=3457
SERVER_PID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_RIT" "$CLONE_RIT" "${SERVER_RIT}-wal" "${SERVER_RIT}-shm" "${CLONE_RIT}-wal" "${CLONE_RIT}-shm"
}
trap cleanup EXIT

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cd "$RIT_DIR"

echo "=== rit end-to-end integration test ==="
echo ""

# ── Step 1: Ingest radio catalog ───────────────────────────────
echo "Step 1: Ingest radio catalog into $SERVER_RIT"
OUTPUT=$(bun src/cli/index.ts "$SERVER_RIT" INGEST "$RADIO_CATALOG_SRC" 2>&1)
echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "Committed:"; then
  pass "Ingest completed with commit"
else
  fail "Ingest did not produce a commit"
fi

# Verify entities exist
KEYS_OUTPUT=$(bun src/cli/index.ts "$SERVER_RIT" KEYS '*' 2>&1)
if echo "$KEYS_OUTPUT" | grep -q "mod:"; then
  pass "Module entities found"
else
  fail "No module entities found"
fi

if echo "$KEYS_OUTPUT" | grep -q "fn:"; then
  pass "Function entities found"
else
  fail "No function entities found"
fi

ENTITY_COUNT=$(echo "$KEYS_OUTPUT" | wc -l)
echo "  ($ENTITY_COUNT entities total)"
echo ""

# ── Step 2: Start rit sync server ──────────────────────────────
echo "Step 2: Start rit server on port $PORT"
bun src/server/serve.ts "$SERVER_RIT" --port "$PORT" &
SERVER_PID=$!
sleep 1

# Verify server is running
if kill -0 "$SERVER_PID" 2>/dev/null; then
  pass "Server started (PID $SERVER_PID)"
else
  fail "Server failed to start"
  exit 1
fi

# Verify HTTP endpoint
REFS_OUTPUT=$(curl -s "http://localhost:$PORT/refs" 2>&1)
if echo "$REFS_OUTPUT" | grep -q "main"; then
  pass "GET /refs returns main branch"
else
  fail "GET /refs did not return main branch"
fi
echo ""

# ── Step 3: Clone via WebSocket ────────────────────────────────
echo "Step 3: Clone from server to $CLONE_RIT"
CLONE_OUTPUT=$(bun src/cli/index.ts CLONE "ws://localhost:$PORT/ws" "$CLONE_RIT" 2>&1)
echo "  $CLONE_OUTPUT"

if echo "$CLONE_OUTPUT" | grep -q "Cloned to"; then
  pass "Clone completed"
else
  fail "Clone did not complete"
fi

# Verify clone has same entities
CLONE_KEYS=$(bun src/cli/index.ts "$CLONE_RIT" KEYS '*' 2>&1)
CLONE_COUNT=$(echo "$CLONE_KEYS" | wc -l)
echo "  (clone has $CLONE_COUNT entities)"

if [ "$CLONE_COUNT" -eq "$ENTITY_COUNT" ]; then
  pass "Clone entity count matches server ($CLONE_COUNT)"
else
  fail "Clone entity count mismatch: clone=$CLONE_COUNT server=$ENTITY_COUNT"
fi
echo ""

# ── Step 4: Make a change on the clone ─────────────────────────
echo "Step 4: Add a test entity on the clone"
bun src/cli/index.ts "$CLONE_RIT" HSET "fn:mod:schemas:testFunction" module "mod:schemas" name "testFunction" exported "true" async "false" params "" returnType "string" body "return hello" order "100" 2>&1
bun src/cli/index.ts "$CLONE_RIT" COMMIT "Add test function" 2>&1

# Verify entity exists on clone
TEST_FN=$(bun src/cli/index.ts "$CLONE_RIT" HGETALL "fn:mod:schemas:testFunction" 2>&1)
if echo "$TEST_FN" | grep -q "testFunction"; then
  pass "Test entity created on clone"
else
  fail "Test entity not found on clone"
fi
echo ""

# ── Step 5: Push the change back ───────────────────────────────
echo "Step 5: Push clone changes to server"
PUSH_OUTPUT=$(bun src/cli/index.ts "$CLONE_RIT" PUSH 2>&1)
echo "  $PUSH_OUTPUT"

if echo "$PUSH_OUTPUT" | grep -q "Pushed"; then
  pass "Push completed"
elif echo "$PUSH_OUTPUT" | grep -q "Already in sync"; then
  pass "Push reports in sync (no changes needed)"
else
  fail "Push did not succeed: $PUSH_OUTPUT"
fi
echo ""

# ── Step 6: Verify on server ──────────────────────────────────
echo "Step 6: Verify server has the new entity"

# Stop server to read the .rit file directly
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
sleep 1

SERVER_FN=$(bun src/cli/index.ts "$SERVER_RIT" HGETALL "fn:mod:schemas:testFunction" 2>&1)
if echo "$SERVER_FN" | grep -q "testFunction"; then
  pass "Server has the pushed entity"
else
  fail "Server does not have the pushed entity"
fi

SERVER_KEYS_AFTER=$(bun src/cli/index.ts "$SERVER_RIT" KEYS '*' 2>&1)
SERVER_COUNT_AFTER=$(echo "$SERVER_KEYS_AFTER" | wc -l)
EXPECTED=$((ENTITY_COUNT + 1))
echo "  (server now has $SERVER_COUNT_AFTER entities, expected $EXPECTED)"
echo ""

# ── Summary ────────────────────────────────────────────────────
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "Some tests failed."
  exit 1
fi
