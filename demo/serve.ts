/**
 * Minimal static file server for the demo.
 * Serves files from the project root so both demo/ and dist/ are accessible.
 */

import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PORT = 3000;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === '/' ? '/demo/index.html' : url.pathname;

    // Resolve relative to project root
    const filePath = join(ROOT, path);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`Demo server running at http://localhost:${PORT}`);
