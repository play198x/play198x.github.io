// Takes a file — dropped or picked, it makes no difference — and says what
// it is. Both DropTarget.astro's drag-and-drop zone and its file picker call
// onFile() with the same File object; the picker is the accessible path
// (keyboard, touch, screen reader), not a fallback bolted on afterwards.
//
// Task 5 adds the image path: a file that classifies as `image` is decoded
// and drawn to Player.astro's canvas, with its metadata and a manual format
// override shown beside it. Playing a module is Task 8 — nothing here
// touches audio bytes.

import init, { decode_image, probe, type DecodedImage } from '@play198x/web';

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

/** How the format shown was arrived at, for the note beside the canvas. */
type Identification = 'certain' | 'probable' | 'manual';

/** The last successfully decoded file's bytes, kept so the format-override
 * <select> in Player.astro can re-decode the same bytes as a different
 * format without asking the visitor to drop the file again. */
let lastImage: { bytes: Uint8Array; file: File } | undefined;

function playerElements() {
  const panel = document.getElementById('player-panel');
  const canvas = document.getElementById('player-canvas');
  return {
    panel,
    canvas: canvas instanceof HTMLCanvasElement ? canvas : undefined,
    source: document.getElementById('player-source'),
    format: document.getElementById('player-format'),
    dimensions: document.getElementById('player-dimensions'),
    confidenceNote: document.getElementById('player-confidence-note'),
    overrideWrap: document.getElementById('player-override-wrap'),
    override: document.getElementById('player-override'),
    palette: document.getElementById('player-palette'),
  };
}

/**
 * Draw a decoded picture to `canvas`.
 *
 * The canvas *buffer* is sized in mode pixels (`width`/`height`) — that is
 * what `rgba` is laid out for. The canvas's *CSS* size is sized from
 * `pixel_aspect_w`/`pixel_aspect_h` instead: mode pixels are not display
 * pixels, and a C64 multicolour bitmap (160×200 mode pixels at 2:1) drawn
 * at a 160-wide CSS size is drawn at half its real width. `image-rendering:
 * pixelated` (set in Player.astro's stylesheet) keeps the upscale sharp.
 */
function drawImage(canvas: HTMLCanvasElement, image: DecodedImage): void {
  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const rgba = new Uint8ClampedArray(image.rgba);
  context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);

  canvas.style.width = `${image.width * image.pixel_aspect_w}px`;
  canvas.style.height = `${image.height * image.pixel_aspect_h}px`;
}

function paletteSwatches(palette: Uint8Array): HTMLSpanElement[] {
  const swatches: HTMLSpanElement[] = [];
  for (let i = 0; i + 2 < palette.length; i += 3) {
    const [r, g, b] = [palette[i], palette[i + 1], palette[i + 2]];
    const swatch = document.createElement('span');
    swatch.className = 'player-swatch';
    swatch.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    swatch.title = `rgb(${r}, ${g}, ${b})`;
    swatches.push(swatch);
  }
  return swatches;
}

const CONFIDENCE_NOTES: Record<Identification, string | undefined> = {
  certain: undefined,
  probable:
    "This identification is probable, not certain — some formats have no reliable signature to check. If this isn't your picture, pick a format below.",
  manual: 'Format chosen manually.',
};

/**
 * Show what's known about a decoded picture beside the canvas: the format
 * (and whether that identification is certain), its size in mode pixels,
 * and its palette. Also fills the override <select> with every image
 * format this player knows, so a visitor whose file was misidentified —
 * or who just wants to try another reading of it — can correct it.
 */
function showMetadata(
  els: ReturnType<typeof playerElements>,
  file: File,
  format: string,
  identification: Identification,
  image: DecodedImage,
): void {
  if (els.source) {
    els.source.textContent = file.name || '(unnamed file)';
  }
  if (els.format) {
    els.format.textContent = IMAGE_FORMATS[format] ?? format;
  }
  if (els.dimensions) {
    els.dimensions.textContent = `${image.width} × ${image.height} mode pixels`;
  }

  const note = CONFIDENCE_NOTES[identification];
  if (els.confidenceNote) {
    els.confidenceNote.hidden = !note;
    els.confidenceNote.textContent = note ?? '';
  }

  if (els.override instanceof HTMLSelectElement) {
    els.override.replaceChildren(
      ...Object.entries(IMAGE_FORMATS).map(([key, name]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = name;
        option.selected = key === format;
        return option;
      }),
    );
  }
  if (els.overrideWrap) {
    els.overrideWrap.hidden = false;
  }

  if (els.palette) {
    els.palette.replaceChildren(...paletteSwatches(image.palette));
  }
}

/**
 * Decode `bytes` as `format` and show the result: draw it to the canvas,
 * fill in the metadata panel, and reveal Player.astro's panel. On a decode
 * failure (most likely after a manual override to the wrong format) the
 * canvas and metadata are left as they were and the failure is reported
 * through the same status line `onFile` uses — the override control stays
 * visible so the visitor can try something else.
 */
function decodeAndShow(bytes: Uint8Array, file: File, format: string, identification: Identification): void {
  const els = playerElements();
  if (!els.panel || !els.canvas) {
    return;
  }

  try {
    const image = decode_image(bytes, format);
    drawImage(els.canvas, image);
    showMetadata(els, file, format, identification, image);
    els.panel.hidden = false;
    lastImage = { bytes, file };
    // onFile already reports the initial identification through classify()'s
    // message; only an override needs a report here, both to confirm the
    // redraw and to clear out a stale error from a previous failed attempt.
    if (identification === 'manual') {
      report(`Redrawn as ${IMAGE_FORMATS[format] ?? format}.`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't draw that as ${IMAGE_FORMATS[format] ?? format}: ${detail}`);
  }
}

function hidePlayer(): void {
  const { panel } = playerElements();
  if (panel) {
    panel.hidden = true;
  }
  lastImage = undefined;
}

/**
 * Wire Player.astro's format-override <select> to re-decode the last shown
 * file's bytes as whatever format the visitor picks. Called once, from
 * Player.astro's own script, at page load — before any file has been
 * dropped, so it only attaches the listener and does nothing until
 * `lastImage` is set by a successful decode.
 */
export function wireFormatOverride(): void {
  const { override } = playerElements();
  if (!(override instanceof HTMLSelectElement)) {
    return;
  }

  override.addEventListener('change', () => {
    if (!lastImage) {
      return;
    }
    decodeAndShow(lastImage.bytes, lastImage.file, override.value, 'manual');
  });
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
    const result = classify(probed, bytes.byteLength);
    report(result.message);

    if (result.route === 'image' && probed) {
      decodeAndShow(bytes, file, probed.format, probed.confidence === 'certain' ? 'certain' : 'probable');
    } else {
      hidePlayer();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't read that file: ${detail}`);
    hidePlayer();
  }
}
