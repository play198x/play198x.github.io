// Pure unit tests for the two decision functions the archive entry list and
// the file-size gate rest on — no DOM, no wasm. Both take plain data in and
// hand plain data back, so they're exercised directly with fixture values,
// the same way tests/probe-routing.test.mjs exercises classify().
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeEntry, sizeError, MAX_CONTAINER_BYTES } from '../src/scripts/player.ts';

test('an image-format entry is openable, with a friendly label', () => {
  const result = describeEntry({ format: 'scr', confidence: 'certain' }, 6912);

  assert.equal(result.route, 'image');
  assert.equal(result.openable, true);
  assert.match(result.label, /ZX Spectrum SCREEN\$/);
});

test('a probable (not certain) image entry says so in its label', () => {
  const result = describeEntry({ format: 'scr', confidence: 'probable' }, 6912);

  assert.equal(result.openable, true);
  assert.match(result.label, /^probably /);
});

test('an audio-format entry is openable, with a friendly label', () => {
  const result = describeEntry({ format: 'protracker', confidence: 'certain' }, 1084);

  assert.equal(result.route, 'audio');
  assert.equal(result.openable, true);
  assert.match(result.label, /ProTracker module/);
});

test('a probable (not certain) audio entry says so in its label', () => {
  const result = describeEntry({ format: 'protracker', confidence: 'probable' }, 1084);

  assert.equal(result.openable, true);
  assert.match(result.label, /^probably /);
});

test('a recognised-but-unrouted format is named but not openable', () => {
  const result = describeEntry({ format: 'made-up-format', confidence: 'certain' }, 42);

  assert.equal(result.route, 'unknown');
  assert.equal(result.openable, false);
  assert.match(result.label, /made-up-format/);
});

test('no probe match at all is not openable, with a generic label', () => {
  const result = describeEntry(undefined, 3);

  assert.equal(result.route, 'unknown');
  assert.equal(result.openable, false);
  assert.match(result.label, /unrecognised format/);
});

test('sizeError allows a file exactly at the 64 MiB container limit', () => {
  assert.equal(sizeError(MAX_CONTAINER_BYTES), undefined);
  assert.equal(sizeError(1024), undefined);
});

test('sizeError refuses a file one byte over the limit, naming both sizes', () => {
  const message = sizeError(MAX_CONTAINER_BYTES + 1);

  assert.ok(message);
  assert.match(message, /64 MiB/);
});

test('sizeError names a large refused file in human units', () => {
  const twoGiB = 2 * 1024 * 1024 * 1024;
  const message = sizeError(twoGiB);

  assert.ok(message);
  assert.match(message, /2 GiB/);
});
