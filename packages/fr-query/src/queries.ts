/**
 * Query and mutation materializer for fr-query plugin.
 *
 * Reads query/mutation entities from the rit store and materializes
 * typed TanStack Query hooks. Entity fields map 1:1 to useQuery/useMutation
 * options. No abstraction layer; the entity IS the TanStack Query config.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Repository } from '../../../src/repo/index.js';

// ── Known option types ──────────────────────────────────

/**
 * Options that take function bodies. The materializer wraps the stored
 * value in an appropriate function signature.
 */
const QUERY_FN_OPTIONS = new Set([
  'queryFn',       // async (context) => { ... }
  'select',        // (data) => { ... }
  'initialData',   // () => { ... } (when it's a function)
  'placeholderData', // (previousData, previousQuery) => { ... }
  'retry',         // can be number or (failureCount, error) => boolean
]);

const MUTATION_FN_OPTIONS = new Set([
  'mutationFn',  // async (variables) => { ... }
  'onMutate',    // async (variables) => { ... }
  'onSuccess',   // (data, variables, context) => { ... }
  'onError',     // (error, variables, context) => { ... }
  'onSettled',   // (data, error, variables, context) => { ... }
  'retry',       // can be number or (failureCount, error) => boolean
]);

/**
 * Options that should be passed through as raw expressions (not quoted strings).
 */
const RAW_OPTIONS = new Set([
  'staleTime', 'gcTime', 'refetchInterval', 'retry', 'retryDelay',
  'enabled', 'refetchOnWindowFocus', 'refetchOnReconnect', 'refetchOnMount',
  'refetchIntervalInBackground', 'retryOnMount', 'throwOnError',
  'structuralSharing', 'networkMode', 'notifyOnChangeProps',
  'initialData', 'initialDataUpdatedAt', 'placeholderData',
  'select', 'meta',
]);

// ── Helpers ─────────────────────────────────────────────

function toPascalCase(s: string): string {
  return s.replace(/(^|[-_])([a-z])/g, (_, __, c) => c.toUpperCase());
}

/**
 * Determine if a value looks like a function body vs a simple expression.
 * If it contains statements (return, const, let, if, etc.), it's a body.
 */
function isFunctionBody(value: string): boolean {
  const trimmed = value.trim();
  return /\b(return|const|let|var|if|for|while|switch|try|await|throw)\b/.test(trimmed)
    || trimmed.includes('\n')
    || trimmed.includes(';');
}

/**
 * Wrap a value as a function if it looks like a function body,
 * otherwise treat it as an expression.
 */
function wrapAsFunction(value: string, params: string): string {
  const trimmed = value.trim();
  if (isFunctionBody(trimmed)) {
    const indented = trimmed.split('\n').map(l => `      ${l}`).join('\n');
    return `async (${params}) => {\n${indented}\n    }`;
  }
  // Simple expression
  return `(${params}) => ${trimmed}`;
}

// ── Code generation ─────────────────────────────────────

function generateQueryHook(key: string, fields: Record<string, string>): string {
  const id = key.slice('query:'.length);
  const hookName = `use${toPascalCase(id)}Query`;

  // queryKey is required
  const queryKey = fields.queryKey || id;
  // Support array-style keys or simple string keys
  const queryKeyExpr = queryKey.startsWith('[') ? queryKey : `['${queryKey}']`;

  const optionLines: string[] = [];
  optionLines.push(`queryKey: ${queryKeyExpr}`);

  for (const [field, value] of Object.entries(fields)) {
    if (field === 'queryKey') continue; // already handled

    if (field === 'queryFn') {
      optionLines.push(`queryFn: ${wrapAsFunction(value, 'context')}`);
    } else if (field === 'select') {
      optionLines.push(`select: ${wrapAsFunction(value, 'data')}`);
    } else if (field === 'placeholderData') {
      if (isFunctionBody(value)) {
        optionLines.push(`placeholderData: ${wrapAsFunction(value, 'previousData, previousQuery')}`);
      } else {
        optionLines.push(`placeholderData: ${value}`);
      }
    } else if (RAW_OPTIONS.has(field)) {
      optionLines.push(`${field}: ${value}`);
    } else {
      // Unknown option: pass through as raw expression
      optionLines.push(`${field}: ${value}`);
    }
  }

  return `export function ${hookName}() {
  return useQuery({
    ${optionLines.join(',\n    ')},
  })
}`;
}

function generateMutationHook(key: string, fields: Record<string, string>): string {
  const id = key.slice('mutation:'.length);
  const hookName = `use${toPascalCase(id)}Mutation`;

  const needsQueryClient = ['onSuccess', 'onError', 'onSettled', 'onMutate'].some(
    f => fields[f]?.includes('queryClient')
  );

  const optionLines: string[] = [];

  // mutationKey is optional but useful
  const mutationKey = fields.mutationKey || id;
  optionLines.push(`mutationKey: ['${mutationKey}']`);

  for (const [field, value] of Object.entries(fields)) {
    if (field === 'mutationKey') continue;

    if (field === 'mutationFn') {
      optionLines.push(`mutationFn: ${wrapAsFunction(value, 'variables')}`);
    } else if (field === 'onMutate') {
      optionLines.push(`onMutate: ${wrapAsFunction(value, 'variables')}`);
    } else if (field === 'onSuccess') {
      optionLines.push(`onSuccess: ${wrapAsFunction(value, 'data, variables, context')}`);
    } else if (field === 'onError') {
      optionLines.push(`onError: ${wrapAsFunction(value, 'error, variables, context')}`);
    } else if (field === 'onSettled') {
      optionLines.push(`onSettled: ${wrapAsFunction(value, 'data, error, variables, context')}`);
    } else if (RAW_OPTIONS.has(field)) {
      optionLines.push(`${field}: ${value}`);
    } else {
      optionLines.push(`${field}: ${value}`);
    }
  }

  const queryClientLine = needsQueryClient ? '\n  const queryClient = useQueryClient()' : '';

  return `export function ${hookName}() {${queryClientLine}
  return useMutation({
    ${optionLines.join(',\n    ')},
  })
}`;
}

// ── Public API ──────────────────────────────────────────

/**
 * Read all query entities from the store.
 */
export async function readQueries(repo: Repository): Promise<Array<{ key: string; fields: Record<string, string> }>> {
  const queries: Array<{ key: string; fields: Record<string, string> }> = [];
  for await (const key of repo.keys('query:*')) {
    const fields = await repo.hgetall(key);
    if (Object.keys(fields).length === 0) continue;
    queries.push({ key, fields });
  }
  return queries;
}

/**
 * Read all mutation entities from the store.
 */
export async function readMutations(repo: Repository): Promise<Array<{ key: string; fields: Record<string, string> }>> {
  const mutations: Array<{ key: string; fields: Record<string, string> }> = [];
  for await (const key of repo.keys('mutation:*')) {
    const fields = await repo.hgetall(key);
    if (Object.keys(fields).length === 0) continue;
    mutations.push({ key, fields });
  }
  return mutations;
}

/**
 * Write a query entity to the store.
 * Fields map directly to TanStack Query useQuery options.
 */
export async function writeQuery(repo: Repository, key: string, fields: Record<string, string>): Promise<void> {
  for (const [field, value] of Object.entries(fields)) {
    await repo.hset(key, field, value);
  }
}

/**
 * Write a mutation entity to the store.
 * Fields map directly to TanStack Query useMutation options.
 */
export async function writeMutation(repo: Repository, key: string, fields: Record<string, string>): Promise<void> {
  for (const [field, value] of Object.entries(fields)) {
    await repo.hset(key, field, value);
  }
}

/**
 * Materialize all query and mutation entities into a hooks file.
 */
export async function materializeQueries(
  repo: Repository,
  rootDir: string,
  outputPath: string = 'src/generated/queries.ts',
): Promise<string | null> {
  const queries = await readQueries(repo);
  const mutations = await readMutations(repo);

  if (queries.length === 0 && mutations.length === 0) return null;

  const imports: string[] = [];
  const tanstackImports: string[] = [];

  if (queries.length > 0) tanstackImports.push('useQuery');
  if (mutations.length > 0) {
    tanstackImports.push('useMutation');
    // Check if any mutation needs queryClient
    const needsQueryClient = mutations.some(m =>
      ['onSuccess', 'onError', 'onSettled', 'onMutate'].some(
        f => m.fields[f]?.includes('queryClient')
      )
    );
    if (needsQueryClient) tanstackImports.push('useQueryClient');
  }

  imports.push(`import { ${tanstackImports.join(', ')} } from '@tanstack/react-query'`);

  const hooks: string[] = [];
  for (const q of queries) {
    hooks.push(generateQueryHook(q.key, q.fields));
  }
  for (const m of mutations) {
    hooks.push(generateMutationHook(m.key, m.fields));
  }

  const output = [imports.join('\n'), '', ...hooks, ''].join('\n\n');

  const fullPath = join(rootDir, outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, output);

  return outputPath;
}
