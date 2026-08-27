// Exercises player.ts's routing decision against the real @play198x/web
// probe — not a stand-in for it — using bytes built in code. No media in
// this repository, ever: every fixture here is a Uint8Array this file
// constructs itself.
//
// @play198x/web's default init() fetches its .wasm file by URL, which
// Node's fetch can't do for a file:// path (see play198x_web.js's
// __wbg_init). Reading the bytes ourselves and handing them to init()
// directly skips that fetch: __wbg_load takes the
// WebAssembly.instantiate(bytes, imports) branch whenever the argument
// isn't a Response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { classify } from '../src/scripts/player.ts';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('@play198x/web/package.json'));

const wasmBytes = await readFile(path.join(pkgDir, 'play198x_web_bg.wasm'));
const { default: init, probe } = await import(pathToFileURL(path.join(pkgDir, 'play198x_web.js')));
await init({ module_or_path: wasmBytes });

test('a 6912-byte SCREEN$-shaped file routes to the image path', () => {
  const bytes = new Uint8Array(6912);

  const probed = probe(bytes);
  const result = classify(probed, bytes.byteLength);

  assert.equal(result.route, 'image');
  assert.match(result.message, /SCREEN\$/);
});

test('a 1084-byte file with M.K. at offset 1080 routes to the audio path', () => {
  const bytes = new Uint8Array(1084);
  bytes.set([0x4d, 0x2e, 0x4b, 0x2e], 1080); // 'M.K.'

  const probed = probe(bytes);
  const result = classify(probed, bytes.byteLength);

  assert.equal(result.route, 'audio');
  assert.match(result.message, /ProTracker/);
});

test('three bytes match no format and route to neither path', () => {
  const bytes = new Uint8Array(3);

  const probed = probe(bytes);
  const result = classify(probed, bytes.byteLength);

  assert.equal(probed, undefined);
  assert.equal(result.route, 'unknown');
  assert.match(result.message, /3-byte/);
});
