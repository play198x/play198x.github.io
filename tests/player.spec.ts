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
// Serves dist/ via scripts/serve-dist.mjs rather than shelling out to
// `astro preview`: a first version spawned that CLI as a child process, and
// on every run it left an orphaned server bound to the port after the test
// finished — `astro preview` starts its own internal sub-process for the
// actual server, which does not share `spawn()`'s process group, so no
// signal sent to the CLI process killed it. That shared module is the same
// server scripts/a11y-sweep.mjs uses — this file used to carry its own,
// independently drifted copy; see serve-dist.mjs's own header comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveDist } from '../scripts/serve-dist.mjs';

const SITE_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(SITE_ROOT, 'dist');

test('a dropped synthetic ProTracker module plays in the real, built page', async () => {
  if (!existsSync(DIST)) {
    throw new Error('player.spec: no dist/ — run `npm run build` first.');
  }

  const { server, baseUrl } = await serveDist(DIST);

  try {
    // Without this flag, a click dispatched by Playwright in headless
    // Chromium does not reliably count as the "user gesture" the Web Audio
    // spec requires before an AudioContext can produce sound — the click
    // lands, but audio.ts's playModule() never gets past constructing the
    // context. This is a test-environment concession, not something the
    // real page relies on: an actual visitor's click is a real gesture.
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    try {
      const page = await browser.newPage();
      // Named `consoleErrors` and not just `pageErrors`: `pageerror` alone
      // only catches an uncaught exception. audio.ts's own worklet-failure
      // path (see its 'error'/onprocessorerror handlers) reports through
      // `console.error`, not a thrown error — a broken worklet would leave
      // this array empty, and the assertion at the end of this test would
      // pass, if `console` messages weren't also collected here.
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });

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
      // as "1.1 KiB" (1084 / 1024, toFixed(1)) — the length the player
      // reports must reflect the dropped file's real size, not a placeholder.
      const length = await audioPanel.locator('#audio-length').textContent();
      assert.equal(length, '1.1 KiB', `expected the real file size, got "${length}"`);

      // The transport: a visitor must see a way to start playback.
      const playButton = audioPanel.locator('#audio-play-button');
      await assert.doesNotReject(playButton.waitFor({ state: 'visible' }));
      assert.equal(await playButton.isEnabled(), true);

      // The point of this test: press Play and confirm the wasm player
      // actually plays the module, not just that a button for it exists.
      // This is what used to be missing — the test stopped at "the button
      // is visible and enabled" and never clicked it, so nothing in CI ever
      // exercised playModule(), the glue fetch, the worklet's
      // TextDecoder/TextEncoder polyfill, initSync inside the worklet,
      // ModulePlayer construction, or the 'ready' handshake — the least
      // standard, most fragile code in this repo.
      const positionEl = audioPanel.locator('#audio-position');
      const positionBeforePlay = (await positionEl.textContent()) ?? '';

      await playButton.click();

      // Fails with Playwright's own timeout error (naming the locator and
      // the wait) if the label never flips — no separate assertion needed.
      await playButton.filter({ hasText: 'Pause' }).waitFor({ timeout: 10_000 });

      const statusText = (await audioPanel.locator('#audio-status').textContent())?.trim() ?? '';
      assert.equal(statusText, '', `expected no playback error, got "${statusText}"`);

      // The worklet posts a position update only once it has actually
      // rendered past the start — waiting for the text to change (rather
      // than just checking it's non-empty) is what proves playback is
      // actually advancing, not just that the panel initialised its text.
      await page.waitForFunction(
        (before) => document.getElementById('audio-position')?.textContent !== before,
        positionBeforePlay,
        { timeout: 10_000 },
      );

      assert.deepEqual(consoleErrors, [], `page logged an error: ${consoleErrors.join('; ')}`);
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
