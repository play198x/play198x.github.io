// Regression test for the bug review round 2 found: drawImage() used to set
// BOTH canvas.style.width and canvas.style.height as fixed pixel values. An
// inline style wins over a stylesheet rule for the same property regardless
// of selector specificity, so Player.astro's `max-width: 100%; height:
// auto;` (meant to shrink the picture on a narrow viewport) went dead the
// instant a picture was drawn: width shrank, height stayed pinned, and the
// picture distorted below its natural width.
//
// This file can only pin what drawImage() *sets* — Node has no layout
// engine, so it cannot show the ratio actually holding as a real canvas is
// laid out narrower than its natural width. That half was checked in a real
// browser at two viewport widths; see task-5-report.md. A test that only
// asserted "the code computes 320x200" would have passed before this fix
// too, since that arithmetic was never wrong — only the second inline
// dimension it was drawn with was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawImage } from '../src/scripts/player.ts';

// drawImage's only DOM dependencies are canvas.width/height, canvas.style,
// canvas.getContext('2d')?.putImageData, and `new ImageData(...)`. None of
// those exist in Node, so they're stubbed just far enough to run the
// function and observe what it assigns — no rendering happens or is
// claimed.
global.ImageData = class {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ({ putImageData: () => {} }),
  };
}

test('drawImage sets exactly one fixed CSS dimension (width) plus aspect-ratio, never a fixed height', () => {
  const canvas = fakeCanvas();
  const image = {
    width: 160,
    height: 200,
    pixel_aspect_w: 2,
    pixel_aspect_h: 1,
    rgba: new Uint8Array(160 * 200 * 4),
  };

  drawImage(canvas, image);

  assert.equal(canvas.width, 160, 'buffer width is mode pixels, unaffected by this fix');
  assert.equal(canvas.height, 200, 'buffer height is mode pixels, unaffected by this fix');
  assert.equal(canvas.style.width, '320px');
  assert.equal(canvas.style.aspectRatio, '320 / 200');
  assert.equal(
    canvas.style.height,
    undefined,
    "a fixed inline height would beat Player.astro's stylesheet `height: auto` and break `max-width: 100%` scaling on a narrow viewport",
  );
});

test('a 1:1 format (Spectrum SCREEN$) also gets aspect-ratio, not a redundant fixed height', () => {
  const canvas = fakeCanvas();
  const image = {
    width: 256,
    height: 192,
    pixel_aspect_w: 1,
    pixel_aspect_h: 1,
    rgba: new Uint8Array(256 * 192 * 4),
  };

  drawImage(canvas, image);

  assert.equal(canvas.style.width, '256px');
  assert.equal(canvas.style.aspectRatio, '256 / 192');
  assert.equal(canvas.style.height, undefined);
});
