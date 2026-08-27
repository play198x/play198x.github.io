// Verifies the SCREEN$ path the whole "show a picture" task rests on: a
// 6912-byte ZX Spectrum SCREEN$ with every bitmap byte clear and every
// attribute byte 0x28 (PAPER 5 cyan, INK 0 black, no BRIGHT) must decode to
// a canvas that is uniformly cyan, because every bit in the (cleared)
// bitmap selects PAPER.
//
// No media in this repository, ever: the fixture is a Uint8Array this file
// builds itself, the same way tests/probe-routing.test.mjs does.
//
// The expected colour is written here as a literal, sourced from
// mediaspec198x's own table (Build198x/build198x/crates/mediaspec198x/src/
// sinclair_zx_spectrum.rs, EMU198X_V1[5] = rgb(0x00, 0xC2, 0xC2)) — not read
// back from decode_image's own `palette` getter. A test that compared our
// decoder's rgba output to our decoder's own palette output would pass even
// if both were wrong in the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('@play198x/web/package.json'));

const wasmBytes = await readFile(path.join(pkgDir, 'play198x_web_bg.wasm'));
const { default: init, decode_image: decodeImage } = await import(
  pathToFileURL(path.join(pkgDir, 'play198x_web.js'))
);
await init({ module_or_path: wasmBytes });

// mediaspec198x's `emu198x-v1` Spectrum palette, index 5, normal (0xC2)
// brightness level — cyan. See this file's header comment for provenance.
const PAPER_5_CYAN = [0x00, 0xc2, 0xc2];

test('a SCREEN$ with every attribute 0x28 (PAPER 5, INK 0) decodes uniformly cyan', () => {
  const bytes = new Uint8Array(6912);
  // Bitmap (first 6144 bytes) stays clear: every pixel bit is 0, so every
  // pixel takes PAPER, never INK.
  // Attributes (last 768 bytes): 0x28 = 0b00101000 -> FLASH 0, BRIGHT 0,
  // PAPER 101 (5, cyan), INK 000 (0, black).
  bytes.fill(0x28, 6144, 6912);

  const image = decodeImage(bytes, 'scr');

  assert.equal(image.width, 256);
  assert.equal(image.height, 192);

  const rgba = image.rgba;
  assert.equal(rgba.length, image.width * image.height * 4);

  for (let i = 0; i < rgba.length; i += 4) {
    assert.deepEqual(
      [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]],
      [...PAPER_5_CYAN, 255],
      `pixel at byte offset ${i} was rgb(${rgba[i]}, ${rgba[i + 1]}, ${rgba[i + 2]}), not PAPER 5 cyan`,
    );
  }
});
