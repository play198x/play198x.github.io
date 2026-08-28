/**
 * Runs the house prose style over the built site. Ported from
 * emu198x.github.io.
 *
 * Bare `vale` cannot be the gate. Vale does not recognise the .astro
 * extension, so `vale src/pages/index.astro` prints "0 errors ... in 0
 * files" and exits 0 — a pass earned by reading nothing. This page is
 * .astro, so a prose gate run that way would be green over prose it had
 * never seen.
 *
 * So this checks the built HTML, which is what a reader is actually served,
 * and it fails when the file count is zero. A gate that cannot report having
 * done nothing is the only kind worth running.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.cwd(), 'dist');

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

if (!existsSync(dist)) {
  console.error('prose: no dist/ — run `npm run build` first.');
  process.exit(1);
}

const files = pages(dist);

if (files.length === 0) {
  console.error('prose: dist/ holds no HTML. Refusing to report a pass over nothing.');
  process.exit(1);
}

// Counting alerts still cannot tell "nothing was wrong" from "nothing was
// checked". `.vale/` is gitignored and filled by `vale sync` from the release
// named in .vale.ini, so the styles can legitimately be missing on a fresh
// clone or in a CI job whose sync step did not run.
//
// Vale splits that state in two, and only one half is already covered. A
// style family absent from StylesPath is an error: E100 on stderr, nothing on
// stdout, exit 2 — which the empty-report guard below turns into a failure. A
// style *directory* that exists but holds no rule files is not an error to
// vale. It lints with an empty rule set, prints `{}` and exits 0, and the
// alert count is then zero because no rule ever ran.
//
// `vale ls-config` cannot separate them: its `Checks` and `SBaseStyles` are
// read back out of .vale.ini, so they name House198x whether or not a single
// rule was loaded from disk. Both states report the same configuration.
//
// So prove it from the outside instead — lint copy the house style is known
// to flag and require the alerts to come back. This sentence trips four rules
// from four different files ("utilize", "very", "simple", "color"), and one
// surviving alert is enough, so retiring any one rule upstream does not turn
// the check into a false failure.
const CANARY =
  '<html><body><p>We utilize a very simple approach to optimize the color.</p></body></html>';

function canaryReport() {
  try {
    return execFileSync('vale', ['--ext=.html', '--output=JSON'], {
      input: CANARY,
      encoding: 'utf8',
    });
  } catch (err) {
    // A house style carrying an error-severity rule would make vale exit
    // non-zero over the canary while still reporting properly, so a usable
    // report on stdout counts as a run. Anything else is vale failing.
    if (err.stdout?.trim()) return err.stdout;
    const detail = (err.stderr || err.message || '').trim();
    console.error(`prose: vale could not lint its own canary: ${detail}`);
    process.exit(1);
  }
}

let canaryAlerts = 0;
try {
  const parsed = JSON.parse(canaryReport());
  canaryAlerts = Object.values(parsed)
    .filter(Array.isArray)
    .reduce((total, list) => total + list.length, 0);
} catch {
  console.error('prose: vale did not return JSON for its own canary.');
  process.exit(1);
}

if (canaryAlerts === 0) {
  console.error('prose: vale found nothing in a sentence the house style is written to flag.');
  console.error('prose: the styles are not loaded — run `vale sync`, then build and try again.');
  process.exit(1);
}

// Vale's exit code tracks errors, not suggestions, so trusting it would let
// every suggestion through while printing a pass — the same hollow green this
// script exists to stop. Count the alerts instead.
let report = '{}';
try {
  report = execFileSync('vale', ['--output=JSON', ...files], { encoding: 'utf8' });
} catch (err) {
  report = err.stdout || '';
  if (!report.trim()) {
    console.error(`prose: vale failed to run: ${err.message}`);
    process.exit(1);
  }
}

let parsed;
try {
  parsed = JSON.parse(report);
} catch {
  console.error('prose: vale did not return JSON. Refusing to guess whether the copy passed.');
  process.exit(1);
}

// A working `--output=JSON` run reports {"<path>": [<alert>, ...], ...} — an
// object whose values are arrays. A broken vale config (e.g. a StylesPath
// that needs `vale sync`) instead emits a single flat alert object, such as
// {"Line":0,"Path":...,"Code":"E201"}, and exits 2. That still parses as
// JSON, so the catch above never fires, and Object.entries(...).flatMap on a
// number's non-array values would throw a TypeError that hides the real
// config problem behind a stack trace. Check the shape before flattening so
// a config failure is reported as what it is.
if (
  parsed === null ||
  typeof parsed !== 'object' ||
  Array.isArray(parsed) ||
  !Object.values(parsed).every((value) => Array.isArray(value))
) {
  console.error('prose: vale returned JSON, but not a { file: [alerts] } report.');
  console.error(`prose: this usually means vale itself failed (styles not synced?): ${report.trim()}`);
  process.exit(1);
}

const alerts = Object.entries(parsed).flatMap(([file, list]) =>
  (list ?? []).map((alert) => ({ file, ...alert })),
);

if (alerts.length > 0) {
  for (const alert of alerts) {
    const where = `${alert.file.replace(`${process.cwd()}/`, '')}:${alert.Line}`;
    console.error(`${where}  ${alert.Severity}  ${alert.Message}  [${alert.Check}]`);
  }
  console.error(`\nprose: ${alerts.length} house-style alert(s) across ${files.length} built pages.`);
  process.exit(1);
}

console.log(`prose: ${files.length} built pages checked, no house-style alerts.`);
