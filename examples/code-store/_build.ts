import { ritBuildPlugin } from '../../packages/rit-build/src/index.js';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';

const [entrypoint, ritFile] = process.argv.slice(2);
if (!entrypoint || !ritFile) {
  console.error('Usage: _build.ts <entrypoint> <ritfile>');
  process.exit(1);
}

const ritDir = dirname(resolve(ritFile));
const outdir = resolve(ritDir, 'dist');
mkdirSync(outdir, { recursive: true });

// If entrypoint starts with rit:, create a temporary bridge file
let entryFile = entrypoint;
let tempFile: string | null = null;

if (entrypoint.startsWith('rit:')) {
  const moduleName = entrypoint.slice(4);
  tempFile = resolve(ritDir, `${moduleName}.entry.ts`);
  writeFileSync(tempFile, `export * from "rit:${moduleName}";\n`);
  entryFile = tempFile;
}

try {
  // Use a clean output name for rit: entrypoints
  const naming = tempFile ? `${entrypoint.slice(4)}.[ext]` : undefined;

  const result = await Bun.build({
    entrypoints: [entryFile],
    target: 'node',
    outdir,
    naming,
    plugins: [ritBuildPlugin(ritFile)],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  for (const output of result.outputs) {
    console.log(output.path);
  }
} finally {
  if (tempFile) {
    try { unlinkSync(tempFile); } catch {}
  }
}
