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
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from './serve-dist.mjs';

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

const signature = (html) => {
  const m = html.match(/^<\s*([a-z0-9-]+)([^>]*)>/i);
  if (!m) return html.slice(0, 40);
  const classes = (m[2].match(/class="([^"]*)"/) || [, ''])[1]
    .trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return m[1].toLowerCase() + (classes.length ? `.${classes.join('.')}` : '');
};

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
    await page.addScriptTag({ content: AXE });
    const result = await page.evaluate(async () => await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    }));

    for (const violation of result.violations) {
      if (!['serious', 'critical'].includes(violation.impact)) continue;
      for (const node of violation.nodes) {
        const key = `${violation.id}|${signature(node.html)}`;
        if (!findings.has(key)) {
          findings.set(key, {
            rule: violation.id, impact: violation.impact, help: violation.help,
            element: signature(node.html), count: 0, routes: new Set(),
            themes: new Set(), example: node.html.slice(0, 160), worst: null,
          });
        }
        const defect = findings.get(key);
        defect.count++;
        defect.routes.add(route);
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
  await context.close();
}
await browser.close();
server.close();

const out = [...findings.values()].sort((a, b) => (a.worst?.ratio ?? 99) - (b.worst?.ratio ?? 99));
const audited = ALL.length - skipped.length / 2;
console.log(`a11y: ${audited} routes × 2 themes, ${skipped.length / 2} redirect stubs skipped — ${out.length} defect(s)\n`);

for (const d of out) {
  console.log(`[${d.impact}] ${d.rule} — ${d.element}`);
  console.log(`  ${d.help}`);
  if (d.worst) {
    console.log(`  worst ${d.worst.ratio}:1 (needs ${d.worst.required}) — ${d.worst.fg} on ${d.worst.bg}`);
  }
  console.log(`  ${d.count} instances across ${d.routes.size} route(s) [${[...d.themes].join(', ')}]`);
  console.log(`  e.g. ${[...d.routes].slice(0, 3).join('  ')}`);
  console.log(`  ${d.example.replace(/\s+/g, ' ')}\n`);
}

process.exit(out.length > 0 ? 1 : 0);
