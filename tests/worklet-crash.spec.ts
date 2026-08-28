// Proves that a worklet dying *mid-tune* stops the transport rather than
// leaving it claiming a tune is still running.
//
// The startup half of that failure is covered by playModule()'s `ready`
// promise, and tests/player.spec.ts exercises the healthy path. Neither
// reaches the case this file exists for: a processor that throws after
// playback is already under way, when `ready` has long since settled and the
// startup handler can only no-op. That state used to leave `playing` true,
// the button reading Pause and the status line empty, with a console.error
// as the only trace — silence that looked exactly like a quiet tune.
//
// There is no way to ask a healthy worklet to fail, and adding a hook to
// production code so a test can crash it would put a trapdoor in the shipping
// page. So the crash is injected into the *built* bundle instead: dist/ is
// copied, the one chunk carrying the processor source gets a throw spliced
// into its render callback, and the copy is served. Nothing under src/ knows
// this test exists.
//
// The injection is anchored on `this.callCount += 1;`, which lives inside
// audio.ts's worklet source template and survives bundling verbatim. If that
// line ever moves or is minified away the assertions below would silently
// stop testing anything, so the anchor is checked and the test fails loudly
// rather than passing over a build it never crashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { serveDist } from '../scripts/serve-dist.mjs';

const SITE_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(SITE_ROOT, 'dist');

const ANCHOR = 'this.callCount += 1;';
// 400 quanta is roughly a second of audio at 128 samples and 48kHz — long
// enough that playback is unambiguously under way and `ready` has settled,
// short enough not to stretch the test. `this.player` gates it so a crash
// cannot land during the pre-init silence, which would reproduce the startup
// failure this test is not about.
const CRASH = `${ANCHOR} if (this.player && this.callCount > 400) throw new Error('injected worklet crash');`;

function buildCrashingCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'play198x-crash-'));
  const copy = join(root, 'dist');
  cpSync(DIST, copy, { recursive: true });

  const assets = join(copy, '_astro');
  const chunks = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(assets, name))
    .filter((path) => readFileSync(path, 'utf8').includes(ANCHOR));

  assert.equal(
    chunks.length,
    1,
    `worklet-crash: expected exactly one built chunk containing "${ANCHOR}", found ${chunks.length}. ` +
      'The worklet source moved or was minified — this test cannot crash the build it is given.',
  );

  const chunk = chunks[0];
  writeFileSync(chunk, readFileSync(chunk, 'utf8').replace(ANCHOR, CRASH));
  return copy;
}

test('a worklet that throws mid-tune stops the transport instead of lying about it', async () => {
  if (!existsSync(DIST)) {
    throw new Error('worklet-crash: no dist/ — run `npm run build` first.');
  }

  const { server, baseUrl } = await serveDist(buildCrashingCopy());

  try {
    // Same headless-audio concession tests/player.spec.ts documents: a
    // Playwright click is not reliably a user gesture, and without this the
    // AudioContext never starts.
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    try {
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForSelector('#drop-target');

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

      await page.locator('#audio-player-panel').waitFor({ state: 'visible', timeout: 10_000 });

      const playButton = page.locator('#audio-play-button');
      await playButton.click();

      // Playback has to actually start, or what follows would be testing the
      // startup path by accident.
      await page.waitForFunction(
        () => document.getElementById('audio-play-button')?.textContent?.trim() === 'Pause',
        null,
        { timeout: 10_000 },
      );

      // The assertion this file exists for: the injected throw must take the
      // transport back to a state a visitor can act on.
      await page.waitForFunction(
        () => document.getElementById('audio-play-button')?.textContent?.trim() === 'Play',
        null,
        { timeout: 15_000 },
      );

      const status = (await page.locator('#audio-status').textContent())?.trim() ?? '';
      assert.match(
        status,
        /Playback stopped/,
        `expected the crash on the status line, got "${status}"`,
      );

      // Recoverable, not just honest: the visitor can press Play again and
      // start the tune over on a fresh context.
      assert.equal(await playButton.isEnabled(), true, 'Play must be pressable again after a crash');
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
});
