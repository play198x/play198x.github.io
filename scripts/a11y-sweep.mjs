/**
 * Accessibility sweep — every built route, both themes. Ported from
 * emu198x.github.io.
 *
 * Serves dist/ and runs axe over each route in light and dark, because half
 * this family's contrast defects only exist in one theme. Exits non-zero if
 * anything serious or critical survives, so it can gate a build.
 *
 *   npm run a11y            # after a build
 *   node scripts/a11y-sweep.mjs [dist-dir]
 *
 * Needs a browser: `npx playwright install chromium` once locally, and
 * `npx playwright install --with-deps chromium` in CI before this runs.
 *
 * Findings are keyed by *defect*, not by element instance. Keying by selector
 * path made one broken CSS rule look like hundreds of problems and a list that
 * long reads as hopeless rather than as a morning's work. The signature is the
 * failing element's own tag and classes — that is what a CSS rule is written
 * against, and what you have to go and change.
 *
 * A route is not a state. This page hides the player until a file is dropped
 * on it, so a sweep that only ever loaded the URL audited the drop target and
 * nothing else: the canvas, the format and confidence readout, the override
 * control and the transport — everything a visitor sees *after* the
 * interaction the site exists for — went out unmeasured, while the gate
 * reported the page as passing WCAG AA. So each route is audited in its
 * initial state and then again after each interaction that reveals a panel,
 * and the summary below names the states it reached rather than counting
 * routes and letting the reader assume the rest.
 *
 * The dropped files are built byte by byte rather than committed: no media
 * lives in this repository, the same rule tests/player.spec.ts states.
 * scripts/zip-fixture.mjs builds the archive, shared with
 * tests/open-archive.test.mjs so the two cannot disagree about what a valid
 * ZIP looks like.
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from './serve-dist.mjs';
import { storedZip } from './zip-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.argv[2] ?? join(HERE, '..', 'dist');

// No dist, no sweep. Falling back to an empty route list would report success
// having measured nothing at all, which is the worst kind of green.
if (!existsSync(DIST)) {
  console.error(`a11y: no build at ${DIST} — run \`npm run build\` first.`);
  process.exit(1);
}

const AXE = readFileSync(
  fileURLToPath(import.meta.resolve('axe-core/axe.min.js')),
  'utf8',
);

function routes(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (name === 'index.html') {
      const rel = relative(DIST, dir).split(sep).join('/');
      out.push(rel === '' ? '/' : `/${rel}/`);
    }
  }
  return out;
}

const { server, baseUrl: base } = await serveDist(DIST);

const ALL = routes(DIST).sort();

// A dist/ that exists but holds no built pages walks to zero routes, and the
// sweep below would then run zero times and report "0 defect(s)" — success
// having measured nothing. That is the same silent-skip failure this whole
// gate exists to remove, just relocated into the check meant to catch it.
if (ALL.length === 0) {
  console.error(`a11y: found no pages under ${DIST} — run \`npm run build\` first`);
  server.close();
  process.exit(1);
}

const findings = new Map();
const skipped = [];
/** Every state actually audited, as "<state> (<theme>)". The summary counts
 * this rather than the route list, so the line cannot claim coverage the run
 * did not reach. */
const audited = new Set();

const signature = (html) => {
  const m = html.match(/^<\s*([a-z0-9-]+)([^>]*)>/i);
  if (!m) return html.slice(0, 40);
  const classes = (m[2].match(/class="([^"]*)"/) || [, ''])[1]
    .trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return m[1].toLowerCase() + (classes.length ? `.${classes.join('.')}` : '');
};

/**
 * A blank but validly-coloured ZX Spectrum SCREEN$: 6144 bytes of pixels then
 * 768 attributes, 0x38 being black ink on white paper. Enough to bring the
 * image panel up with a real decode behind it.
 */
function screen() {
  const bytes = new Uint8Array(6912);
  bytes.fill(0x38, 6144, 6912);
  return bytes;
}

/** The same 1084-byte "M.K." shape tests/probe-routing.test.mjs proves probes
 * as ProTracker. */
function module_() {
  const bytes = new Uint8Array(1084);
  bytes.set([0x4d, 0x2e, 0x4b, 0x2e], 1080); // 'M.K.'
  return bytes;
}

/**
 * The states this sweep drives the page through, beyond simply loading it.
 * Each names a panel that is `hidden` until an interaction reveals it, and the
 * whole sequence runs only on a route that actually has the drop target — if
 * the player ever moves to another URL, the sweep follows it rather than
 * silently auditing nothing.
 *
 * Order is deliberate. Dropping the module after the image is not redundant:
 * showAudioPlayer() hides the image panel, so the two are audited separately
 * rather than overlapping. The archive comes last and reaches two more states
 * — the entry list, and the picture panel opened *from* a list click, which
 * is a different path into that panel than a direct drop and can differ in
 * what it leaves on screen.
 *
 * The archive deliberately holds one entry the player can open and one it
 * cannot: an unrecognised entry renders as a real disabled <button> (see
 * archiveEntryRow() in src/scripts/player.ts), and disabled controls are
 * exactly where contrast defects hide from a casual look.
 */
const PLAYER_STATES = [
  {
    name: 'image dropped',
    reveals: '#player-panel',
    act: (page) => drop(page, 'sweep.scr', screen()),
  },
  {
    name: 'module dropped',
    reveals: '#audio-player-panel',
    act: (page) => drop(page, 'sweep.mod', module_()),
  },
  {
    name: 'archive dropped',
    reveals: '#archive-entries',
    act: (page) =>
      drop(
        page,
        'sweep.zip',
        storedZip([
          { name: 'picture.scr', bytes: screen() },
          { name: 'notes.txt', bytes: new TextEncoder().encode('not a format this player knows') },
        ]),
      ),
  },
  {
    name: 'archive entry opened',
    reveals: '#player-panel',
    act: (page) => page.click('#archive-entries .archive-entry-button:not([disabled])'),
  },
];

/** Drops `bytes` on the page as a real DragEvent — the same path a visitor
 * takes, and the same one tests/player.spec.ts drives. */
async function drop(page, file, bytes) {
  await page.evaluate(
    ({ file, data }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array(data)], file, { type: 'application/octet-stream' }));
      const target = document.getElementById('drop-target');
      if (!target) throw new Error('no #drop-target to drop on');
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    },
    { file, data: [...bytes] },
  );
}

/** Runs axe over whatever the page is currently showing and folds any
 * serious or critical violation into `findings`. Called once per state, not
 * once per route — see this file's header comment. */
async function audit(page, state, theme) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => await window.axe.run(document, {
    resultTypes: ['violations'],
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  }));
  audited.add(`${state} (${theme})`);

  for (const violation of result.violations) {
    if (!['serious', 'critical'].includes(violation.impact)) continue;
    for (const node of violation.nodes) {
      const key = `${violation.id}|${signature(node.html)}`;
      if (!findings.has(key)) {
        findings.set(key, {
          rule: violation.id, impact: violation.impact, help: violation.help,
          element: signature(node.html), count: 0, states: new Set(),
          themes: new Set(), example: node.html.slice(0, 160), worst: null,
        });
      }
      const defect = findings.get(key);
      defect.count++;
      defect.states.add(state);
      defect.themes.add(theme);

      // The worst ratio is the one to fix against.
      const contrast = node.any.find((check) => check.data && check.data.contrastRatio);
      if (contrast) {
        const ratio = contrast.data.contrastRatio;
        if (!defect.worst || ratio < defect.worst.ratio) {
          defect.worst = {
            ratio, required: contrast.data.expectedContrastRatio,
            fg: contrast.data.fgColor, bg: contrast.data.bgColor,
          };
        }
      }
    }
  }
}

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({
    colorScheme: theme,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  for (const route of ALL) {
    // Redirect stubs navigate out from under the audit, and are not content.
    const html = readFileSync(join(DIST, route === '/' ? '' : route, 'index.html'), 'utf8');
    if (/http-equiv=["']?refresh/i.test(html)) { skipped.push(route); continue; }

    await page.goto(base + route, { waitUntil: 'load' });
    await audit(page, route, theme);

    // The drop target is what makes a route interactive, so its presence —
    // not a hardcoded '/' — decides whether there are further states to
    // reach. A route without one is fully audited by the pass above.
    if (await page.$('#drop-target')) {
      for (const state of PLAYER_STATES) {
        await state.act(page);
        // A panel that never appears means the sweep is about to audit the
        // state before it instead, and report that as coverage. Fail rather
        // than quietly measure the wrong thing.
        try {
          await page.waitForSelector(`${state.reveals}:not([hidden])`, { timeout: 10_000 });
        } catch {
          console.error(`a11y: "${state.name}" left ${state.reveals} unrevealed on ${route} (${theme}).`);
          await context.close();
          await browser.close();
          server.close();
          process.exit(1);
        }
        await audit(page, `${route} [${state.name}]`, theme);
      }
    }
  }
  await context.close();
}
await browser.close();
server.close();

const out = [...findings.values()].sort((a, b) => (a.worst?.ratio ?? 99) - (b.worst?.ratio ?? 99));
// `skipped` and `audited` both accumulate once per theme, so both are halved
// to report pages rather than passes.
const states = audited.size / 2;
console.log(`a11y: ${states} page state(s) × 2 themes, ${skipped.length / 2} redirect stub(s) skipped — ${out.length} defect(s)`);
for (const state of [...audited].filter((entry) => entry.endsWith('(light)'))) {
  console.log(`  audited: ${state.replace(' (light)', '')}`);
}
console.log('');

for (const d of out) {
  console.log(`[${d.impact}] ${d.rule} — ${d.element}`);
  console.log(`  ${d.help}`);
  if (d.worst) {
    console.log(`  worst ${d.worst.ratio}:1 (needs ${d.worst.required}) — ${d.worst.fg} on ${d.worst.bg}`);
  }
  console.log(`  ${d.count} instances across ${d.states.size} state(s) [${[...d.themes].join(', ')}]`);
  console.log(`  e.g. ${[...d.states].slice(0, 3).join('  ')}`);
  console.log(`  ${d.example.replace(/\s+/g, ' ')}\n`);
}

process.exit(out.length > 0 ? 1 : 0);
