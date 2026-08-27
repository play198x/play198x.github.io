/**
 * Compares the built route set against a committed expected list, so a page
 * cannot silently disappear or a new one go unnoticed. Ported from
 * emu198x.github.io, which added this after five pages that never existed
 * shipped past a home-page-only link checker while CI still reported success
 * — see check-internal-links.mjs.
 *
 * This does the two things a route-disappearance check has to do:
 *   - fail, naming the route, when something the list expects is gone
 *   - fail, naming the route, when the build has a route the list doesn't
 *     know about yet — so adding a page is a one-command, visible change
 *     (`npm run check:routes -- --update`), not silent drift that erodes
 *     what the list is for.
 *
 * Like the other build gates, an empty dist/ is not a passing run — it is a
 * check that measured nothing, so it fails loudly instead of reporting a
 * clean route set over zero pages.
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const siteRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const distRoot = join(siteRoot, 'dist');
const expectedPath = join(siteRoot, 'scripts', 'expected-routes.txt');

const shouldUpdate = process.argv.includes('--update') || process.env.UPDATE_ROUTES === '1';

// Adapted from emu198x.github.io, which tracks only `index.html` pages —
// this site also has a public entry point that is not a page: the sitemap
// `@astrojs/sitemap` writes at the dist root. `sitemap-index.xml` is a
// stable URL a crawler hits directly, so it is tracked here by name, the
// same as a page route. Its sibling shard files (`sitemap-0.xml`, and
// however many more a larger site would need) are an internal encoding
// detail of the integration, not a URL anyone is meant to visit or approve
// one at a time, so they are deliberately left untracked — including them
// would make this gate fail every time the site grows past a shard
// boundary, over a file nobody was ever meant to look at directly.
const TRACKED_ROOT_FILES = new Set(['sitemap-index.xml']);

function walk(dir, out = [], isRoot = true) {
  for (const entry of readdirSync(dir)) {
    // _astro/ holds hashed build assets (JS, CSS, the wasm bundle) — content,
    // not routes, and their names change on every build by design.
    if (isRoot && entry === '_astro') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, out, false);
    } else if (entry === 'index.html' || (isRoot && TRACKED_ROOT_FILES.has(entry))) {
      out.push(path);
    }
  }
  return out;
}

function routeFor(pagePath) {
  const rel = relative(distRoot, pagePath).split(sep).join('/');
  return rel.endsWith('index.html') ? '/' + rel.replace(/index\.html$/, '') : '/' + rel;
}

const pages = existsSync(distRoot) ? walk(distRoot) : [];

if (pages.length === 0) {
  console.error(`check-routes: found no pages under ${distRoot} — run \`npm run build\` first`);
  process.exit(1);
}

const actualRoutes = [...new Set(pages.map(routeFor))].sort();

if (shouldUpdate) {
  writeFileSync(expectedPath, actualRoutes.join('\n') + '\n');
  console.log(`check-routes: wrote ${actualRoutes.length} route(s) to ${expectedPath}`);
  process.exit(0);
}

if (!existsSync(expectedPath)) {
  console.error(
    `check-routes: no expected route list at ${expectedPath}. ` +
      'Run `npm run check:routes -- --update` (or UPDATE_ROUTES=1) to create it.',
  );
  process.exit(1);
}

const expectedRoutes = readFileSync(expectedPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (expectedRoutes.length === 0) {
  console.error(`check-routes: ${expectedPath} has no routes recorded — run \`npm run build\` first`);
  process.exit(1);
}

const actualSet = new Set(actualRoutes);
const expectedSet = new Set(expectedRoutes);

const vanished = expectedRoutes.filter((route) => !actualSet.has(route));
const added = actualRoutes.filter((route) => !expectedSet.has(route));

console.log(`check-routes: compared ${actualRoutes.length} built route(s) against ${expectedRoutes.length} expected`);

if (vanished.length > 0 || added.length > 0) {
  if (vanished.length > 0) {
    console.error(`\n${vanished.length} route(s) vanished from the build:\n`);
    for (const route of vanished) {
      console.error(`  MISSING ${route}`);
    }
  }
  if (added.length > 0) {
    console.error(`\n${added.length} route(s) built that aren't in the expected list yet:\n`);
    for (const route of added) {
      console.error(`  NEW ${route}`);
    }
  }
  console.error(
    '\nIf this is a deliberate page addition or removal, run ' +
      '`npm run check:routes -- --update` (or UPDATE_ROUTES=1) and commit the updated list.',
  );
  process.exit(1);
}

console.log('route set matches the expected list');
