// Drives the real built page in a real browser with a real `.ay` tune, and
// proves the parts of it a unit test cannot reach: that the song table
// becomes a list a visitor can choose from, that choosing restarts playback
// on the chosen song, and that a tune reports a position in its own terms
// rather than a module's.
//
// The tune is read from the local World of Spectrum archive rather than
// committed here — no media file enters this repository — so the test skips
// when that volume is not mounted, the same way the core's corpus sweep is
// `#[ignore]`d. A synthetic `.ay` would prove the wiring but not that the
// wiring survives a real file's song table, which is the half worth testing
// in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveDist } from '../scripts/serve-dist.mjs';

const SITE_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(SITE_ROOT, 'dist');

// Four songs, and audible on every one of them per the core's corpus sweep,
// which is what makes it a fixture rather than an arbitrary pick.
const TUNE = '/Volumes/Data/WOS-Archive/music/ay/games/p/Plotting.ay.zip';

test('a dropped multi-song .ay offers its songs and plays the chosen one', async (t) => {
  if (!existsSync(TUNE)) {
    t.skip(`no local archive at ${TUNE}`);
    return;
  }
  if (!existsSync(DIST)) {
    throw new Error('ay-player.spec: no dist/ — run `npm run build` first.');
  }

  const bytes = Array.from(readFileSync(TUNE));
  const { server, baseUrl } = await serveDist(DIST);

  try {
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    try {
      const page = await browser.newPage();
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });

      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForSelector('#drop-target');

      await page.evaluate((data: number[]) => {
        const file = new File([new Uint8Array(data)], 'Plotting.ay.zip', {
          type: 'application/octet-stream',
        });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const target = document.getElementById('drop-target');
        if (!target) {
          throw new Error('no #drop-target in the built page');
        }
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
        );
      }, bytes);

      // Dropped as the collection stores it: one `.ay` inside a `.zip`,
      // which is how all 696 of these files arrive. An archive holding a
      // single playable entry opens straight into the player rather than
      // asking which one — so there is no entry list to click through here.
      const audioPanel = page.locator('#audio-player-panel');
      await audioPanel.waitFor({ state: 'visible', timeout: 10_000 });

      const format = await audioPanel.locator('#audio-format').textContent();
      assert.match(format ?? '', /AY/i, `expected an .ay identification, got "${format}"`);

      // The song list is the point of this slice: without it, three of this
      // file's four tunes are unreachable from the page.
      const songSelect = page.locator('#audio-song');
      await songSelect.waitFor({ state: 'visible', timeout: 5_000 });
      const options = await songSelect.locator('option').allTextContents();
      assert.equal(options.length, 4, `expected four songs, got ${options.length}`);
      assert.match(options[0], /^1\./, `songs are numbered from 1 for a listener: "${options[0]}"`);
      // The file's own song names, not placeholders — the point of reading
      // the song table rather than counting entries.
      assert.match(options[1], /In-Game/, `expected the file's song names, got "${options[1]}"`);

      // All four songs of this file declare SongLength 0, which means "not
      // stated" rather than "zero seconds", so the panel shows the file size
      // instead of printing a duration the file never claimed.
      const length = await audioPanel.locator('#audio-length').textContent();
      assert.match(length ?? '', /KiB/, `an undeclared length should fall back to a size, got "${length}"`);

      await page.locator('#audio-play-button').click();

      // A tune reports where it is in its own terms. "Order/pattern/row"
      // here would mean the panel was showing a module's position for
      // something that has none.
      const position = page.locator('#audio-position');
      await position.filter({ hasText: /^Song 1, frame \d+/ }).waitFor({ timeout: 10_000 });

      // Choosing another song restarts on it — a `.ay` has no seek, so this
      // is a new player, and the position must say so.
      await songSelect.selectOption('2');
      await position.filter({ hasText: /^Song 3, frame \d+/ }).waitFor({ timeout: 10_000 });

      assert.deepEqual(consoleErrors, [], 'the page logged errors while playing a tune');
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
});
