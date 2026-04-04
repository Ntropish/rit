/**
 * Build the rit framework runtime for the browser.
 * Outputs a single JS file that can be loaded via <script> tag.
 */

const result = await Bun.build({
  entrypoints: ['./src/browser.ts'],
  outdir: './dist',
  target: 'browser',
  format: 'esm',
  minify: false,
  sourcemap: 'external',
  naming: 'rit-runtime.js',
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built: dist/rit-runtime.js (${result.outputs[0].size} bytes)`);
