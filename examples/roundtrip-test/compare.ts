/**
 * Compares original TypeScript source files with materialized output.
 * Reports matches, diffs, and missing files.
 *
 * Usage: bun run compare.ts <original-dir> <materialized-dir>
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const [originalDir, materializedDir] = process.argv.slice(2);
if (!originalDir || !materializedDir) {
  console.error('Usage: bun run compare.ts <original-dir> <materialized-dir>');
  process.exit(1);
}

const absOriginal = resolve(originalDir);
const absMaterialized = resolve(materializedDir);

// Collect .ts files
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'test' || entry === 'dist') continue;
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

// Normalize whitespace for comparison: trim trailing whitespace per line, normalize line endings
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

const originalFiles = collectTsFiles(absOriginal);
const matches: string[] = [];
const diffs: Array<{ file: string; originalLines: number; materializedLines: number; gaps: string[] }> = [];
const missing: string[] = [];

for (const origFile of originalFiles) {
  const relPath = relative(absOriginal, origFile);
  const matFile = join(absMaterialized, relPath);

  if (!existsSync(matFile)) {
    missing.push(relPath);
    continue;
  }

  const origText = normalize(readFileSync(origFile, 'utf-8'));
  const matText = normalize(readFileSync(matFile, 'utf-8'));

  if (origText === matText) {
    matches.push(relPath);
  } else {
    // Identify what's missing
    const origLines = origText.split('\n');
    const matLines = matText.split('\n');
    const gaps: string[] = [];

    // Check for constructs in original that are missing from materialized
    const matContent = matText;
    for (const line of origLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed === ';') continue;
      // Check if key identifiers are present
      if (trimmed.startsWith('export ') || trimmed.startsWith('import ') ||
          trimmed.startsWith('function ') || trimmed.startsWith('class ') ||
          trimmed.startsWith('interface ') || trimmed.startsWith('type ') ||
          trimmed.startsWith('enum ') || trimmed.startsWith('const ') ||
          trimmed.startsWith('let ') || trimmed.startsWith('var ')) {
        if (!matContent.includes(trimmed)) {
          gaps.push(`  missing: ${trimmed.slice(0, 100)}`);
        }
      }
    }

    // Check for extra content in materialized
    for (const line of matLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed === ';') continue;
      if (trimmed.startsWith('export ') || trimmed.startsWith('import ') ||
          trimmed.startsWith('function ') || trimmed.startsWith('class ') ||
          trimmed.startsWith('interface ') || trimmed.startsWith('type ') ||
          trimmed.startsWith('enum ') || trimmed.startsWith('const ') ||
          trimmed.startsWith('let ') || trimmed.startsWith('var ')) {
        if (!origText.includes(trimmed)) {
          gaps.push(`  extra:   ${trimmed.slice(0, 100)}`);
        }
      }
    }

    diffs.push({
      file: relPath,
      originalLines: origLines.length,
      materializedLines: matLines.length,
      gaps,
    });
  }
}

// Report
console.log('=== Roundtrip Fidelity Report ===\n');

console.log(`Files compared: ${originalFiles.length}`);
console.log(`  Matches:  ${matches.length}`);
console.log(`  Diffs:    ${diffs.length}`);
console.log(`  Missing:  ${missing.length}`);

if (matches.length > 0) {
  console.log('\n--- Exact matches ---');
  for (const m of matches) console.log(`  ${m}`);
}

if (diffs.length > 0) {
  console.log('\n--- Diffs ---');
  for (const d of diffs) {
    console.log(`\n  ${d.file} (${d.originalLines} -> ${d.materializedLines} lines)`);
    if (d.gaps.length > 0) {
      for (const g of d.gaps) console.log(`  ${g}`);
    } else {
      console.log('    (whitespace/formatting differences only)');
    }
  }
}

if (missing.length > 0) {
  console.log('\n--- Missing (not materialized) ---');
  for (const m of missing) console.log(`  ${m}`);
}

// Exit with code 1 if there are diffs or missing files
const exitCode = (diffs.length > 0 || missing.length > 0) ? 1 : 0;
console.log(`\nExit code: ${exitCode}`);
process.exit(exitCode);
