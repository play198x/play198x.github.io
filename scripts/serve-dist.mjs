/**
 * A minimal static file server for a built `dist/` directory.
 *
 * Shared by scripts/a11y-sweep.mjs and tests/player.spec.ts — both need to
 * hand a real headless browser the built site, and used to carry two
 * independently written copies of this instead: one task wrote the a11y
 * sweep's server, a second task couldn't see it and wrote its own for the
 * browser player test, and the two had already drifted (14 MIME types
 * against 8) while the second copy's own comment claimed it was "the same
 * minimal one" as the first. One module, imported by both, so they can't
 * drift again.
 */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

/**
 * Start serving `distDir` on an OS-assigned free port. Resolves once it's
 * listening, with the server (call `.close()` on it when done) and the base
 * URL to fetch from.
 *
 * @param {string} distDir
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string }>}
 */
export async function serveDist(distDir) {
  const server = createServer((req, res) => {
    const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = join(distDir, requestPath);
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
    } catch {
      // Not a directory (or doesn't exist) — fall through to the read
      // below, which reports a 404 either way.
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://localhost:${port}` };
}
