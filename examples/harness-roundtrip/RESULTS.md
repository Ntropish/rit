# Harness Roundtrip Fidelity Test Results

**Target project:** @trivorn/harness (`C:/Users/Zora/Projects/harness/src/`)
**Date:** 2026-03-28
**Bead:** d5256a10 (Ingestion roundtrip fidelity: real open source project test)

## Summary

| Metric | Count |
|--------|-------|
| Files ingested | 11 |
| Files materialized | 11 |
| Exact matches | 3 |
| Whitespace-only diffs | 8 |
| Content diffs | 0 |
| Missing files | 0 |

**Result: PASS** — All diffs are whitespace/formatting only.

## Exact Matches

- `belay-client.ts`
- `config.ts`
- `store.ts`

## Whitespace-Only Diffs

These files differ only in formatting (multi-line parameter lists collapsed to single line, blank line differences). No content is lost or changed.

| File | Original lines | Materialized lines | Cause |
|------|---------------|-------------------|-------|
| `api.ts` | 222 | 212 | Multi-line params collapsed |
| `auth.ts` | 57 | 52 | Multi-line params collapsed |
| `index.ts` | 5 | 6 | Extra blank line between expressions |
| `lib.ts` | 120 | 125 | Extra blank lines between re-exports |
| `matrix.ts` | 296 | 293 | Multi-line params collapsed |
| `push-gateway.ts` | 62 | 57 | Multi-line params collapsed |
| `runner.ts` | 288 | 287 | Multi-line initializer collapsed |
| `state.ts` | 410 | 403 | Multi-line params/initializers collapsed |

## Plugin Fixes Made

Two improvements to the TypeScript plugin were required to reach this result:

1. **Comment preservation**: Standalone comments between declarations (e.g., `// SSE client management`) and file-level JSDoc comments (before imports) were being lost. Added support for capturing these as ordered entities and materializing them in position.

2. **Re-export ordering**: `export { Foo } from './bar'` declarations were collected separately and always emitted at the end of the file. Changed to process them as ordered entities in the statement loop, preserving their original position.

## Remaining Whitespace Patterns

These are acceptable per the success criteria but could be improved in a future pass:

- **Multi-line parameter lists**: `function foo(\n  a: A,\n  b: B\n)` becomes `function foo(a: A, b: B)` — params are stored as a single joined string.
- **Multi-line initializers**: `const X =\n  "value"` becomes `const X = "value"` — initializer text loses the line break before it.
- **Multi-line union types**: `type T =\n  | A\n  | B` becomes `type T = | A | B` on the first line — the type body is stored as-is from the AST.
- **Blank line handling**: Extra or missing blank lines between declarations, caused by uniform `\n` insertion after each materialized entity.
