// Exercises the real @play198x/web `Container` — not a stand-in for it —
// against a stored (uncompressed) ZIP built in memory by
// scripts/zip-fixture.mjs: a local header, the data, a central directory and
// an end record, per entry. No media in this repository, ever. Mirrors
// play198x-web's own tests/container.rs fixture approach, in JS, for the
// JS-facing contract src/scripts/player.ts's archive list depends on.
//
// See tests/probe-routing.test.mjs's header comment for why init() is
// handed the wasm bytes directly rather than left to fetch a URL: Node's
// fetch can't resolve a file:// path the way a browser resolves an
// import.meta.url-relative one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { describeEntry } from '../src/scripts/player.ts';
import { storedZip } from '../scripts/zip-fixture.mjs';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('@play198x/web/package.json'));

const wasmBytes = await readFile(path.join(pkgDir, 'play198x_web_bg.wasm'));
const { default: init, probe, Container } = await import(pathToFileURL(path.join(pkgDir, 'play198x_web.js')));
await init({ module_or_path: wasmBytes });

function screenBytes(attribute) {
  const bytes = new Uint8Array(6912);
  bytes.fill(attribute, 6144, 6912);
  return bytes;
}

test('a plain (non-archive) file opens as a container of exactly one entry', () => {
  const bytes = screenBytes(0x28);
  const container = new Container(bytes, 'screen.scr');

  assert.equal(container.entry_count, 1);
  assert.equal(container.entry_path(0), 'screen.scr');
  assert.equal(container.entry_len(0), bytes.length);
  assert.deepEqual(container.read('screen.scr'), bytes);

  assert.equal(container.entry_path(1), undefined);
  assert.equal(container.entry_len(1), undefined);

  container.free();
});

test('a stored ZIP lists every entry, and each reads back its original bytes', () => {
  const scr = screenBytes(0x28);
  const tune = new Uint8Array(1084);
  tune.set([0x4d, 0x2e, 0x4b, 0x2e], 1080); // 'M.K.'
  const readme = new TextEncoder().encode('hello from a TOSEC-shaped disk');

  const zip = storedZip([
    { name: 'screen.scr', bytes: scr },
    { name: 'tune.mod', bytes: tune },
    { name: 'readme.txt', bytes: readme },
  ]);

  const container = new Container(zip, 'disk.zip');
  assert.equal(container.entry_count, 3);

  assert.equal(container.entry_path(0), 'screen.scr');
  assert.equal(container.entry_path(1), 'tune.mod');
  assert.equal(container.entry_path(2), 'readme.txt');
  assert.equal(container.entry_path(3), undefined);
  assert.equal(container.entry_len(3), undefined);

  assert.deepEqual(container.read('screen.scr'), scr);
  assert.deepEqual(container.read('tune.mod'), tune);
  assert.deepEqual(container.read('readme.txt'), readme);

  container.free();
});

test('reading a name the archive does not hold is an error, not a crash', () => {
  const zip = storedZip([{ name: 'screen.scr', bytes: screenBytes(0x28) }]);
  const container = new Container(zip, 'disk.zip');

  assert.throws(() => container.read('missing.scr'));

  container.free();
});

test('describeEntry, fed real probe() output for each zip entry, matches what the archive list should show', () => {
  const scr = screenBytes(0x28);
  const tune = new Uint8Array(1084);
  tune.set([0x4d, 0x2e, 0x4b, 0x2e], 1080);
  const readme = new TextEncoder().encode('not a recognised format');

  const zip = storedZip([
    { name: 'screen.scr', bytes: scr },
    { name: 'tune.mod', bytes: tune },
    { name: 'readme.txt', bytes: readme },
  ]);
  const container = new Container(zip, 'disk.zip');

  const results = [];
  for (let i = 0; i < container.entry_count; i++) {
    const path = container.entry_path(i);
    const bytes = container.read(path);
    const probed = probe(bytes);
    results.push([path, describeEntry(probed, bytes.length)]);
    probed?.free();
  }

  container.free();

  const [[, scrResult], [, tuneResult], [, readmeResult]] = results;

  assert.equal(scrResult.route, 'image');
  assert.equal(scrResult.openable, true);

  assert.equal(tuneResult.route, 'audio');
  assert.equal(tuneResult.openable, true);

  assert.equal(readmeResult.route, 'unknown');
  assert.equal(readmeResult.openable, false);
});
