# Roundtrip Fidelity Test Results

Target: [superjson](https://github.com/flightcontrolhq/superjson) (12 source files, ~3000 lines)

## Summary

- **12/12** files ingested successfully
- **12/12** files materialized successfully
- **5/12** files match exactly (42%)
- **7/12** files have diffs
- **0** files missing

## Exact matches

- `accessDeep.ts`
- `class-registry.ts`
- `custom-transformer-registry.ts`
- `double-indexed-kv.ts`
- `registry.ts`

## Identified gaps

### 1. `export default` (semantic loss)

`export default class SuperJSON` becomes `export class SuperJSON`. The `default` keyword is not captured or materialized.

**Affected files:** `index.ts`

### 2. Re-export statements (semantic loss)

`export { SuperJSON, SuperJSONResult, SuperJSONValue }` is not ingested at all. These are neither import declarations nor top-level declarations; they're export specifier lists.

**Affected files:** `index.ts`

### 3. Multi-line parameter formatting (formatting loss)

```typescript
// Original:
export function find<T>(
  record: Record<string, T>,
  predicate: (v: T) => boolean
): T | undefined {

// Materialized:
export function find<T>(record: Record<string, T>, predicate: (v: T) => boolean): T | undefined {
```

Parameters are stored as a single string. Multi-line formatting is collapsed. Semantically correct but visually different.

**Affected files:** `util.ts`, `plainer.ts`, `transformer.ts`

### 4. Multi-line union type formatting (formatting loss)

```typescript
// Original:
export type SuperJSONValue =
  | JSONValue
  | SerializableJSONValue;

// Materialized:
export type SuperJSONValue = JSONValue | SerializableJSONValue;
```

Type bodies are stored as a single string. Semantically correct.

**Affected files:** `types.ts`, `is.ts`, `transformer.ts`

## Not yet tested

- Decorators
- Namespace declarations (`declare namespace`)
- Module augmentation
- Ambient declarations (`declare function`, `declare const`)
- Conditional types spanning multiple lines
- Template literal types
