// Drives the real built page in a real browser and drops a synthetic
// ProTracker module on it — the one thing tests/probe-routing.test.mjs and
// friends cannot check, because they run @play198x/web under Node, not in a
// browser. player.ts's loadWasm() resolves its .wasm file with
// `new URL(..., import.meta.url)`, which only works the way a browser
// resolves it; a Vite asset path that 404s under real browser fetch is
// exactly the failure every node test in this repo would miss.
//
// No media on disk, ever: the module is built as a Uint8Array inside the
// page itself (see the page.evaluate() below), the same 1084-byte "M.K."
// shape tests/probe-routing.test.mjs already proves probes as ProTracker.
//
// This exercises the real drag-and-drop path, not the file-picker path:
// DropTarget.astro's `drop` handler is wired to the same onFile() the picker
// calls, so a real DragEvent with a DataTransfer holding a File covers the
// listener wiring the picker's `change` event cannot.
//
// Run against the built site (`npm run build` first), never src/ directly —
// the drop target's wasm loading is a property of the built asset graph.
//
// Serves dist/ with a plain Node http server rather than shelling out to
// `astro preview`: a first version spawned that CLI as a child process, and
// on every run it left an orphaned server bound to the port after the test
// finished — `astro preview` starts its own internal sub-process for the
// actual server, which does not share `spawn()`'s process group, so no
// signal sent to the CLI process killed it. This server (the same minimal
// one scripts/a11y-sweep.mjs already uses to serve dist/ for a real
// browser) is started and stopped in-process, so there is nothing left to
// leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const SITE_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(SITE_ROOT, 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.wasm': 'application/wasm',
};

test('a dropped synthetic ProTracker module plays in the real, built page', async () => {
  if (!existsSync(DIST)) {
    throw new Error('player.spec: no dist/ — run `npm run build` first.');
  }

  const server = createServer((req, res) => {
    const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = join(DIST, requestPath);
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
    } catch {
      // Not a directory (or doesn't exist) — fall through to the read below,
      // which reports a 404 the same way either case would.
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
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://localhost:${port}`;

  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => consoleErrors.push(String(error)));

      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForSelector('#drop-target');

      // Built entirely inside the browser: a minimal ProTracker module, 1084
      // bytes, 'M.K.' at offset 1080 — the same shape
      // tests/probe-routing.test.mjs already proves probes as ProTracker,
      // here dispatched as a real drop rather than handed to classify()
      // directly.
      await page.evaluate(() => {
        const bytes = new Uint8Array(1084);
        bytes.set([0x4d, 0x2e, 0x4b, 0x2e], 1080); // 'M.K.'
        const file = new File([bytes], 'synthetic.mod', { type: 'application/octet-stream' });

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        const target = document.getElementById('drop-target');
        if (!target) {
          throw new Error('no #drop-target in the built page');
        }
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
        );
      });

      const audioPanel = page.locator('#audio-player-panel');
      await audioPanel.waitFor({ state: 'visible', timeout: 10_000 });

      await assert.doesNotReject(
        audioPanel.locator('#audio-name').filter({ hasText: 'synthetic.mod' }).waitFor(),
      );

      const format = await audioPanel.locator('#audio-format').textContent();
      assert.match(format ?? '', /ProTracker/, `expected a ProTracker identification, got "${format}"`);

      // The module is 1084 bytes, which describeSize() in player.ts renders
      // in KiB, not bytes — the length the player reports must reflect the
      // dropped file's real size, not a placeholder.
      const length = await audioPanel.locator('#audio-length').textContent();
      assert.match(length ?? '', /KiB|B$/, `expected a size string, got "${length}"`);

      // The transport: a visitor must see a way to start playback.
      const playButton = audioPanel.locator('#audio-play-button');
      await assert.doesNotReject(playButton.waitFor({ state: 'visible' }));
      assert.equal(await playButton.isEnabled(), true);

      assert.deepEqual(consoleErrors, [], `page threw: ${consoleErrors.join('; ')}`);
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
