// Takes a file — dropped or picked, it makes no difference — and says what
// it is. Both DropTarget.astro's drag-and-drop zone and its file picker call
// onFile() with the same File object; the picker is the accessible path
// (keyboard, touch, screen reader), not a fallback bolted on afterwards.
//
// This is as far as this task goes: it identifies the file and names where
// it will go next. Drawing the picture is Task 5; playing a module is
// Task 8. Nothing here decodes anything.

import init, { probe } from '@play198x/web';

export type Route = 'image' | 'audio' | 'unknown';

/** Mirrors the shape wasm-bindgen's `Probed` exposes across the JS boundary. */
export interface ProbeResult {
  readonly format: string;
  readonly confidence: string;
}

export interface RouteResult {
  route: Route;
  message: string;
}

// Names a human recognises, keyed by what `probe` returns. A SCREEN$ has no
// magic number — its length is the entire signal — so every name here is
// worth saying even when the confidence is only "probable".
const IMAGE_FORMATS: Record<string, string> = {
  scr: 'a ZX Spectrum SCREEN$',
  koala: 'a Commodore 64 Koala Paint image',
  'art-studio': 'a Commodore 64 Art Studio image',
  ilbm: 'an Amiga IFF ILBM image',
};

const AUDIO_FORMATS: Record<string, string> = {
  protracker: 'a ProTracker module',
};

/**
 * Turn what `probe` found into where the file goes and what to tell the
 * visitor. Pure — no DOM, no wasm — so it can be exercised directly with
 * bytes built in code; see tests/probe-routing.test.mjs.
 */
export function classify(probed: ProbeResult | undefined, byteLength: number): RouteResult {
  if (!probed) {
    return {
      route: 'unknown',
      message: `That's a ${byteLength}-byte file — it doesn't match a format this player recognises.`,
    };
  }

  const { format, confidence } = probed;
  const qualifier = confidence === 'certain' ? '' : 'probably ';

  const imageName = IMAGE_FORMATS[format];
  if (imageName) {
    return {
      route: 'image',
      message: `That's a ${byteLength}-byte file — ${qualifier}${imageName}. It'll draw to the canvas.`,
    };
  }

  const audioName = AUDIO_FORMATS[format];
  if (audioName) {
    return {
      route: 'audio',
      message: `That's a ${byteLength}-byte file — ${qualifier}${audioName}. It'll play in the module player.`,
    };
  }

  return {
    route: 'unknown',
    message: `That's a ${byteLength}-byte file, identified as "${format}" — but this player doesn't route that format yet.`,
  };
}

let wasmReady: Promise<void> | undefined;

// A STATIC import, deliberately. @play198x/web's init() resolves its .wasm
// binary via `new URL('play198x_web_bg.wasm', import.meta.url)`, a pattern
// Vite recognises natively on a static import and rewrites into a hashed,
// bundled asset — no copied file at a fixed path, no plugin, no manual URL
// handling needed. This is the only way the decoder gets loaded anywhere in
// this repo now; there used to be a second, hand-copied path (a
// public/wasm/ directory populated by a prebuild step, consumed by an
// is:inline probe script on the index page) but it had no reason to exist
// once this file could load the package directly, so both were removed.
//
// Do not turn this back into a dynamic `import()`. A dynamic import here is
// what triggered a real bug: Vite's modulepreload helper wraps dynamic
// import() calls and leaves an unresolved `__VITE_PRELOAD__` token in the
// output when the importing script gets inlined into the page rather than
// emitted as its own chunk — the substitution pass that normally fills that
// token in never runs, and the page throws a ReferenceError the first time a
// file is dropped. A dynamic import also carries `unsafe-eval` risk the
// moment anyone reaches for `Function`/`eval` to dodge that bug, which
// defeats the point of a script-src CSP on a site whose whole pitch is that
// nothing the visitor feeds it leaves their browser. If a future task needs
// raw wasm bytes at a stable URL (Task 8's AudioWorklet, maybe), reach for
// `new URL('@play198x/web/play198x_web_bg.wasm', import.meta.url)` first —
// Vite resolves that to the same hashed asset without a copy step — and
// only bring a copy step back if that turns out not to be enough.
function loadWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = init().then(() => undefined);
  }
  return wasmReady;
}

function report(message: string): void {
  const status = document.getElementById('drop-target-status');
  if (status) {
    status.textContent = message;
  }
}

/**
 * Read a dropped or picked file, identify it, and report where it will go.
 * Called identically from both input paths in DropTarget.astro.
 */
export async function onFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  try {
    await loadWasm();
    const probed = probe(bytes);
    report(classify(probed, bytes.byteLength).message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't read that file: ${detail}`);
  }
}
