// Takes a file — dropped or picked, it makes no difference — and says what
// it is. Both DropTarget.astro's drag-and-drop zone and its file picker call
// onFile() with the same File object; the picker is the accessible path
// (keyboard, touch, screen reader), not a fallback bolted on afterwards.
//
// Task 5 added the image path: a file that classifies as `image` is decoded
// and drawn to Player.astro's canvas, with its metadata and a manual format
// override shown beside it.
//
// Task 6 adds the container path: every dropped file is opened as a
// `Container` — a plain file is a container of exactly one entry, a ZIP or
// an Amiga ADF disk image is a container of many. A single entry may open
// directly; several are listed in DropTarget.astro's entry list for the
// visitor to pick from, each one probed so the list says what it is, with
// what cannot be opened greyed out rather than hidden.
//
// Playing a module is Task 8 — nothing here touches audio bytes, so a
// ProTracker entry is identified but never marked openable yet.

import init, { decode_image, probe, Container, type DecodedImage, type ImageMeta } from '@play198x/web';

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

// Names a human recognises, keyed by what `probe` (and `ImageMeta.format`)
// return. A SCREEN$ has no magic number — its length is the entire signal —
// so every name here is worth saying even when the confidence is only
// "probable". This mapping is presentation copy the wasm boundary has no
// business owning (English display strings, not decoded data), so it stays
// here even though `ImageMeta` now supplies everything else about a decoded
// picture — see showMetadata() below.
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

/** What one row in DropTarget.astro's archive entry list shows and whether
 * it can be clicked. */
export interface EntryDescription {
  route: Route;
  label: string;
  openable: boolean;
}

/**
 * Describe one container entry for the entry list: a short label plus
 * whether it can be opened. Reuses classify()'s route decision — the same
 * probe result must never be routed two different ways by two copies of the
 * same logic — but writes a label sized for a list row rather than a full
 * sentence.
 *
 * Only the `image` route is openable: audio playback (Task 8) doesn't exist
 * yet, so a recognised ProTracker module is named honestly rather than
 * offered as something this player can actually do yet.
 */
export function describeEntry(probed: ProbeResult | undefined, byteLength: number): EntryDescription {
  const { route } = classify(probed, byteLength);

  if (route === 'image' && probed) {
    const qualifier = probed.confidence === 'certain' ? '' : 'probably ';
    return { route, label: `${qualifier}${IMAGE_FORMATS[probed.format]}`, openable: true };
  }

  if (route === 'audio' && probed) {
    const qualifier = probed.confidence === 'certain' ? '' : 'probably ';
    return { route, label: `${qualifier}${AUDIO_FORMATS[probed.format]} — playback isn't wired up yet`, openable: false };
  }

  if (probed) {
    return { route: 'unknown', label: `identified as "${probed.format}", not supported here`, openable: false };
  }

  return { route: 'unknown', label: 'unrecognised format', openable: false };
}

// The core caps a container's resident bytes at 64 MiB (see
// play198x-core's MAX_ARCHIVE_LEN) — restated here as a literal since the
// constant itself is private to that crate. `Container`'s constructor takes
// ownership of a `Vec<u8>` copied out of whatever `Uint8Array` it's handed,
// so it cannot undo an oversized allocation this file already made by
// reading a huge `File` into memory. The check below runs on `File.size`
// BEFORE `arrayBuffer()` is ever called, so a visitor dropping a multi-
// gigabyte file gets a clear refusal instead of the tab locking up trying to
// read it in.
export const MAX_CONTAINER_BYTES = 64 * 1024 * 1024;

function describeSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : value.toFixed(0);
  const trimmed = rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
  return `${trimmed} ${units[unitIndex]}`;
}

/**
 * `undefined` when `byteLength` is within the limit this player will read
 * into memory; otherwise a message naming both the file's size and the
 * limit, fit to show directly in the status line.
 */
export function sizeError(byteLength: number): string | undefined {
  if (byteLength <= MAX_CONTAINER_BYTES) {
    return undefined;
  }
  return `That file is ${describeSize(byteLength)} — this player only opens files up to ${describeSize(MAX_CONTAINER_BYTES)}.`;
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

/** The last successfully decoded entry's bytes and the label it was read
 * from, kept so the format-override <select> in Player.astro can re-decode
 * the same bytes as a different format without asking the visitor to drop
 * the file again. */
let lastImage: { bytes: Uint8Array; sourceLabel: string } | undefined;

/** The currently open multi-entry archive, kept resident so clicking
 * through several entries — a music disk's tunes — reads and probes each
 * one on demand without re-parsing the whole archive. `undefined` whenever
 * nothing is open, or the last opened container held exactly one entry (in
 * which case it was read and freed immediately; there's nothing to browse
 * back to). Freed and replaced, never left to accumulate, the moment a new
 * file is dropped — see freeContainer(). */
let currentContainer: Container | undefined;

function freeContainer(): void {
  if (currentContainer) {
    currentContainer.free();
    currentContainer = undefined;
  }
}

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
 *
 * Only ONE fixed CSS dimension is set here (`width`), never both. Player
 * Astro's stylesheet declares `max-width: 100%; height: auto;` so the
 * picture shrinks to fit a narrow viewport — but an inline `style.height`
 * would win over that stylesheet rule regardless of selector specificity,
 * pinning the height while `max-width` shrank the width and distorting
 * the picture. Setting `aspect-ratio` alongside the single fixed `width`
 * lets `height: auto` do its job: the browser derives the used height from
 * whatever width the layout actually gives the canvas, at the picture's
 * real (aspect-corrected) ratio, at every viewport width.
 */
// Exported only so tests/draw-image.test.mjs can pin the CSS-dimension
// contract (exactly one fixed dimension, plus aspect-ratio) without a real
// <canvas>. Not part of this module's public API for any other caller.
export function drawImage(canvas: HTMLCanvasElement, image: DecodedImage): void {
  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const rgba = new Uint8ClampedArray(image.rgba);
  context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);

  const displayWidth = image.width * image.pixel_aspect_w;
  const displayHeight = image.height * image.pixel_aspect_h;
  canvas.style.width = `${displayWidth}px`;
  canvas.style.aspectRatio = `${displayWidth} / ${displayHeight}`;
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
 *
 * Everything shown here — format, dimensions, palette — comes from a single
 * `image.metadata(sourceLabel)` call, not from separately re-deriving a
 * dimensions string or palette swatches from `image`'s own raw fields: see
 * `ImageMeta`'s doc comment in @play198x/web for why a second copy of that
 * isn't allowed to exist. `IMAGE_FORMATS` stays local even so — it maps
 * `meta.format`'s short code to an English display string, and English
 * display copy is this shell's job, not the wasm boundary's.
 */
function showMetadata(
  els: ReturnType<typeof playerElements>,
  sourceLabel: string,
  identification: Identification,
  image: DecodedImage,
): void {
  const meta: ImageMeta = image.metadata(sourceLabel);
  try {
    if (els.source) {
      els.source.textContent = meta.source || '(unnamed file)';
    }
    if (els.format) {
      els.format.textContent = IMAGE_FORMATS[meta.format] ?? meta.format;
    }
    if (els.dimensions) {
      els.dimensions.textContent = `${meta.width} × ${meta.height} mode pixels`;
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
          option.selected = key === meta.format;
          return option;
        }),
      );
    }
    if (els.overrideWrap) {
      els.overrideWrap.hidden = false;
    }

    if (els.palette) {
      els.palette.replaceChildren(...paletteSwatches(meta.palette));
    }
  } finally {
    meta.free();
  }
}

/**
 * Decode `bytes` as `format` and show the result: draw it to the canvas,
 * fill in the metadata panel, and reveal Player.astro's panel. On a decode
 * failure (most likely after a manual override to the wrong format) the
 * canvas and metadata are left as they were and the failure is reported
 * through the same status line `onFile` uses — the override control stays
 * visible so the visitor can try something else.
 *
 * `sourceLabel` is what's shown as the picture's source and passed to
 * `image.metadata()` — the outer file's name for a plain drop, or the
 * entry's own path when it came from inside an archive (see openEntry()),
 * since "disk.adf" tells a visitor nothing about which tune they picked.
 */
function decodeAndShow(bytes: Uint8Array, sourceLabel: string, format: string, identification: Identification): void {
  const els = playerElements();
  if (!els.panel || !els.canvas) {
    return;
  }

  try {
    const image = decode_image(bytes, format);
    try {
      drawImage(els.canvas, image);
      showMetadata(els, sourceLabel, identification, image);
    } finally {
      image.free();
    }
    els.panel.hidden = false;
    lastImage = { bytes, sourceLabel };
    // onFile/openEntry already report the initial identification through
    // classify()'s message; only an override needs a report here, both to
    // confirm the redraw and to clear out a stale error from a previous
    // failed attempt.
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

function archiveListElement(): HTMLElement | undefined {
  const list = document.getElementById('archive-entries');
  return list instanceof HTMLElement ? list : undefined;
}

function hideArchiveList(): void {
  const list = archiveListElement();
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
}

/**
 * Read one entry's bytes, identify them, and either draw them (an image) or
 * report what they are (audio or unknown — see describeEntry()'s note on
 * why audio isn't opened yet). Shared by the single-entry path in
 * openContainer() and by a click on one of several entries in
 * archiveEntryRow(): picking a second tune from the same disk calls this
 * exactly the same way the first one did.
 *
 * Frees the `Probed` `probe()` hands back as soon as its two fields
 * (`format`, `confidence`) are read out into plain locals — after that,
 * everything downstream works from those locals, never from the freed
 * wasm object.
 */
function openEntry(container: Container, path: string, file: File): void {
  let bytes: Uint8Array;
  try {
    bytes = container.read(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't read "${path}" from ${file.name}: ${detail}`);
    hidePlayer();
    return;
  }

  const probed = probe(bytes);
  const result = classify(probed, bytes.byteLength);
  const format = probed?.format;
  const certain = probed?.confidence === 'certain';
  probed?.free();

  report(result.message);
  if (result.route === 'image' && format) {
    decodeAndShow(bytes, path, format, certain ? 'certain' : 'probable');
  } else {
    hidePlayer();
  }
}

/**
 * Build one <li> for DropTarget.astro's archive entry list: a clickable
 * button naming the entry and what it is when it can be opened, or a
 * disabled row saying why not when it can't — greyed out rather than left
 * off the list, so a visitor who dropped a disk expecting a tune can see
 * the disk holds no tune, which reads differently from an empty list.
 *
 * Reads the entry's bytes to probe them (there is no way to know what an
 * entry is without looking at it), then frees the `Probed` immediately —
 * the same discipline as openEntry(). The bytes read here are discarded
 * once probed; a click re-reads them fresh from `container`, which stays
 * resident for exactly that.
 */
function archiveEntryRow(container: Container, path: string, file: File): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'archive-entry';

  let description: EntryDescription;
  try {
    const bytes = container.read(path);
    const probed = probe(bytes);
    description = describeEntry(probed, bytes.byteLength);
    probed?.free();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    description = { route: 'unknown', label: `couldn't be read: ${detail}`, openable: false };
  }

  if (description.openable) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'archive-entry-button';
    button.textContent = `${path} — ${description.label}`;
    button.addEventListener('click', () => {
      // Guards against a stale row from an archive that's since been
      // replaced by a new drop — freeContainer() clears currentContainer
      // before this one could ever be read from again.
      if (currentContainer === container) {
        openEntry(container, path, file);
      }
    });
    li.appendChild(button);
  } else {
    const span = document.createElement('span');
    span.className = 'archive-entry-disabled';
    span.setAttribute('aria-disabled', 'true');
    span.textContent = `${path} — ${description.label}`;
    li.appendChild(span);
  }

  return li;
}

function renderArchiveList(container: Container, file: File): void {
  const list = archiveListElement();
  if (!list) {
    return;
  }

  const rows: HTMLLIElement[] = [];
  for (let i = 0; i < container.entry_count; i++) {
    const path = container.entry_path(i);
    if (path === undefined) {
      break;
    }
    rows.push(archiveEntryRow(container, path, file));
  }

  list.replaceChildren(...rows);
  list.hidden = false;
}

/**
 * Decide what to do with a just-opened container: a single entry opens
 * directly (the common case — most dropped files are plain files, which
 * `Container` always reports as one entry named by `file.name`); several
 * entries are listed for the visitor to choose from, because an Amiga disk
 * holds many modules and picking one for them is picking wrong most of the
 * time.
 *
 * Takes ownership of `container` for the single-entry and empty cases —
 * both free it before returning, since nothing more will ever be read from
 * it. The multi-entry case instead hands ownership to `currentContainer`,
 * kept resident until freeContainer() runs for the next drop.
 */
function openContainer(container: Container, file: File): void {
  hideArchiveList();

  const count = container.entry_count;

  if (count === 0) {
    report(`${file.name} is an empty archive — there's nothing inside to open.`);
    hidePlayer();
    container.free();
    return;
  }

  if (count === 1) {
    const path = container.entry_path(0) ?? file.name;
    openEntry(container, path, file);
    container.free();
    return;
  }

  currentContainer = container;
  report(`That's an archive with ${count} entries — pick one below to open it.`);
  renderArchiveList(container, file);
}

/**
 * Read a dropped or picked file and open it. Called identically from both
 * input paths in DropTarget.astro.
 *
 * Every file — plain, ZIP, or Amiga ADF disk image — is opened the same way,
 * as a `Container`: see openContainer() for what happens next. `file.size`
 * is checked before `arrayBuffer()` is ever called, so an oversized file is
 * refused before its bytes are read into memory at all — see
 * MAX_CONTAINER_BYTES's comment for why that ordering matters.
 */
export async function onFile(file: File): Promise<void> {
  const sizeProblem = sizeError(file.size);
  if (sizeProblem) {
    report(sizeProblem);
    return;
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  try {
    await loadWasm();
    freeContainer();
    const container = new Container(bytes, file.name);
    openContainer(container, file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't read that file: ${detail}`);
    hidePlayer();
    hideArchiveList();
  }
}

/**
 * Wire Player.astro's format-override <select> to re-decode the last shown
 * entry's bytes as whatever format the visitor picks. Called once, from
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
    decodeAndShow(lastImage.bytes, lastImage.sourceLabel, override.value, 'manual');
  });
}
