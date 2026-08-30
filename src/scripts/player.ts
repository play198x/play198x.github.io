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
// Task 8 adds the audio path: a ProTracker entry is now openable. Opening
// one shows its name and size beside a Play control in Player.astro's audio
// panel — it does not start an `AudioContext` until that control is
// pressed, because browsers refuse to let one produce sound outside a user
// gesture. Everything past that click is src/scripts/audio.ts's job; this
// file only ever holds a `ModulePlaybackHandle`, never an `AudioContext`, a
// wasm byte, or a worklet message.

import init, {
  decode_image,
  moduleMeta,
  ayMeta,
  probe,
  Container,
  type DecodedImage,
  type ImageMeta,
} from '@play198x/web';
import { playModule, type ModulePlaybackHandle, type PlayerPosition } from './audio.ts';

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
  // Not "an AY module": a `.ay` is Z80 code and data for a 128K Spectrum to
  // run, not sample data to step through, and calling it a module would
  // describe the wrong thing to anyone who knows the difference.
  ay: 'a ZX Spectrum AY tune',
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
 * Both `image` and `audio` routes are openable: Task 8 wires up playback,
 * so a recognised ProTracker module is offered the same way a recognised
 * picture is.
 */
export function describeEntry(probed: ProbeResult | undefined, byteLength: number): EntryDescription {
  const { route } = classify(probed, byteLength);

  if (route === 'image' && probed) {
    const qualifier = probed.confidence === 'certain' ? '' : 'probably ';
    return { route, label: `${qualifier}${IMAGE_FORMATS[probed.format]}`, openable: true };
  }

  if (route === 'audio' && probed) {
    const qualifier = probed.confidence === 'certain' ? '' : 'probably ';
    return { route, label: `${qualifier}${AUDIO_FORMATS[probed.format]}`, openable: true };
  }

  if (probed) {
    return { route: 'unknown', label: `identified as "${probed.format}", not supported here`, openable: false };
  }

  return { route: 'unknown', label: 'unrecognised format', openable: false };
}

// The core caps a container's resident bytes at 64 MiB — see
// play198x-core/crates/play198x-core/src/container.rs:40, `const
// MAX_ARCHIVE_LEN: u64 = 64 * 1024 * 1024` (67,108,864 bytes, matching the
// literal below) — restated here rather than imported, since the constant
// itself is private to that crate. `Container`'s constructor takes
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
  const limit = describeSize(MAX_CONTAINER_BYTES);
  const rounded = describeSize(byteLength);
  // describeSize() rounds anything ≥10 units to a whole number, so a file
  // only a few bytes over the limit renders identically to the limit itself
  // — "That file is 64 MiB — this player only opens files up to 64 MiB"
  // reads as a contradiction (same size, refused anyway). Fall back to an
  // exact byte count whenever rounding would produce that collision; a file
  // comfortably clear of the limit (the 2 GiB case, say) still gets the
  // friendly rounded form.
  const size = rounded === limit ? `${byteLength.toLocaleString()} bytes` : rounded;
  return `That file is ${size} — this player only opens files up to ${limit}.`;
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
    // Cache the promise, not a settled success: caching a rejection here
    // would brick the page the first time this fetch hits a transient 503 —
    // wasmReady would keep handing back the same dead promise forever, even
    // once the network recovered, because a rejected promise never
    // re-settles. Clearing the cache on rejection (guarded so a slower,
    // now-stale attempt can't clobber a newer one that already started) is
    // what lets the very next drop retry from scratch instead of replaying
    // the same stale error.
    const p = init().then(() => undefined);
    wasmReady = p;
    p.catch(() => {
      if (wasmReady === p) {
        wasmReady = undefined;
      }
    });
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

/** Bytes for an identified ProTracker entry, held until the visitor presses
 * Play — src/scripts/audio.ts's `playModule()` must run inside that click's
 * own call stack, so nothing here starts an `AudioContext` before then.
 * `undefined` once playback has actually started (see currentAudio below)
 * or whenever nothing audio is showing. */
let pendingAudioBytes: Uint8Array | undefined;

/** The handle audio.ts hands back once the visitor has pressed Play — the
 * only thing in this file that touches a live `AudioContext`, and even this
 * only through the handle's play/pause/dispose methods, never directly.
 * `undefined` before that click and after disposeAudio() runs. */
let currentAudio: ModulePlaybackHandle | undefined;
/** Which subtune the next Play starts, and which one a restart returns to.
 *
 * Held here rather than read from the `<select>` at the point of use so that
 * a file with no song table — every module, and a single-song `.ay` — has a
 * defined answer without the control existing. */
let currentSong = 0;

/** Bumped by disposeAudio(). handleAudioPlayClick() reads this before its
 * only `await` (starting playback) and compares it after — a mismatch means
 * a new drop ran disposeAudio() (via hideAllPanels()) while playback was
 * still starting, so the handle that just resolved belongs to a tune that's
 * no longer showing and must be disposed on arrival rather than published as
 * `currentAudio`. Without this, `currentAudio = handle` after the await could
 * publish a handle for audio the visitor never sees a transport for — see
 * handleAudioPlayClick()'s doc. */
let audioGeneration = 0;

/** Tears down any live playback — idempotent, safe to call whether or not
 * anything is playing. Called before a new entry replaces whatever the
 * audio panel was last showing, the same discipline freeContainer() applies
 * to a stale `Container`. */
function disposeAudio(): void {
  audioGeneration += 1;
  if (currentAudio) {
    currentAudio.dispose();
    currentAudio = undefined;
  }
  pendingAudioBytes = undefined;
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

/** Hide the song list and forget any choice made in it.
 *
 * Called for every file that is not a multi-song `.ay`, because the panel is
 * reused: a module dropped after a multi-song tune would otherwise inherit
 * both the list and the song index chosen from it. */
function resetSongSelector(els: ReturnType<typeof audioElements>): void {
  currentSong = 0;
  if (els.song) {
    els.song.replaceChildren();
  }
  if (els.songWrap) {
    els.songWrap.hidden = true;
  }
}

/** Fill the panel for a `.ay` tune, including its song list. */
function describeAyFile(els: ReturnType<typeof audioElements>, bytes: Uint8Array): void {
  resetSongSelector(els);

  let meta: ReturnType<typeof ayMeta> | undefined;
  try {
    meta = ayMeta(bytes);
  } catch {
    meta = undefined;
  }

  // A `.ay` carries no sample slots and no channel count of its own — the
  // chip has three and always does — so both rows go away rather than
  // showing a zero that reads as a measurement.
  if (els.samples) {
    els.samples.hidden = true;
  }
  if (els.voices) {
    els.voices.textContent = meta ? '3' : '';
  }

  const title = meta?.title.trim() ?? '';
  if (els.title && els.titleLabel) {
    els.title.textContent = title;
    els.title.hidden = title === '';
    els.titleLabel.hidden = title === '';
  }

  const count = meta?.songCount() ?? 0;
  if (els.length) {
    const ms = meta?.songLengthMs(0);
    // A `SongLength` of zero means the file does not say how long the song
    // runs, not that it is over instantly — Plotting.ay declares zero for all
    // four of its songs, and they play. Printing "0:00" for that would state
    // a duration the file never claimed, so it falls back to the file size
    // exactly as a module that will not decode does.
    //
    // `loops: false` because a `.ay` song does not come back on itself: it
    // declares a length and then a fade, which is an ending rather than a
    // loop point. Saying "then loops" would invent a property the format
    // does not have.
    els.length.textContent =
      ms === undefined || ms === null || ms === 0
        ? describeSize(bytes.byteLength)
        : describeDuration({ durationMs: ms, loops: false });
  }

  // Only when there is a choice to make. A single-song file with a song list
  // of one is a control that does nothing, which is worse than no control.
  if (count > 1 && els.song && els.songWrap && meta) {
    for (let index = 0; index < count; index += 1) {
      const option = document.createElement('option');
      option.value = `${index}`;
      const name = meta.songName(index)?.trim();
      // Numbered from 1 for a listener, who is not counting from zero.
      option.textContent = name ? `${index + 1}. ${name}` : `Song ${index + 1}`;
      els.song.append(option);
    }
    els.song.value = '0';
    els.songWrap.hidden = false;
  }
}

function audioElements() {
  const panel = document.getElementById('audio-player-panel');
  const playButton = document.getElementById('audio-play-button');
  return {
    panel: panel instanceof HTMLElement ? panel : undefined,
    name: document.getElementById('audio-name'),
    format: document.getElementById('audio-format'),
    length: document.getElementById('audio-length'),
    titleLabel: document.getElementById('audio-title-label'),
    title: document.getElementById('audio-title'),
    voices: document.getElementById('audio-voices'),
    samples: document.getElementById('audio-samples'),
    sampleList: document.getElementById('audio-sample-list'),
    playButton: playButton instanceof HTMLButtonElement ? playButton : undefined,
    songWrap: document.getElementById('audio-song-wrap'),
    song: (() => {
      const el = document.getElementById('audio-song');
      return el instanceof HTMLSelectElement ? el : undefined;
    })(),
    position: document.getElementById('audio-position'),
    status: document.getElementById('audio-status'),
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
 * failure, the canvas and metadata are left as they were and the failure is
 * reported through the same status line `onFile` uses.
 *
 * "Left as they were" means something different depending on who called
 * this. wireFormatOverride()'s manual-override path (`identification ===
 * 'manual'`) re-decodes bytes that already drew successfully once, with the
 * panel and its override control already visible — those stay visible and
 * showing the previous good picture, so the visitor can pick another format
 * without losing their place. openEntry()'s initial decode runs while the
 * panel is still hidden (hideAllPanels() already ran for this drop): if
 * *that* one fails, there is no override control on screen yet to correct
 * with, so the panel simply stays hidden rather than showing an empty
 * canvas with nothing to fix it.
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

function hideAudioPlayer(): void {
  disposeAudio();
  const { panel } = audioElements();
  if (panel) {
    panel.hidden = true;
  }
}

/** Hides both panels at once — used whenever what's coming next isn't known
 * to be a picture or a module yet (an unrecognised entry, an empty archive,
 * a file that failed to read at all). */
function hideAllPanels(): void {
  hidePlayer();
  hideAudioPlayer();
}

function setPlayButtonLabel(label: string): void {
  const { playButton } = audioElements();
  if (playButton) {
    playButton.textContent = label;
  }
}

/**
 * A module's length as a listener would say it, from the timing walk rather
 * than the file size.
 *
 * A looping song is marked instead of being given a bare time. `duration_ms`
 * is one pass — from the top of the order table to whichever comes first: the
 * end of the song, an `F00` that stops it, or a position already played — so
 * for a song that comes back on itself, printing it alone would state an
 * ending the song does not have.
 *
 * Rounded to the second, with `0:00` reserved for a song that genuinely has
 * nothing to play — a module whose order table is empty, which the walk
 * reports as a zero duration. Anything with orders in it rounds up to `0:01`
 * rather than down to zero: a song shorter than a second still played, and
 * printing it as `0:00` would say the same thing as a module that did not.
 */
export function describeDuration(meta: { durationMs: number; loops: boolean }): string {
  const seconds = meta.durationMs === 0 ? 0 : Math.max(1, Math.round(meta.durationMs / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return meta.loops ? `${clock}, then loops` : clock;
}

/**
 * Show a just-identified ProTracker entry: its name, format and size beside
 * a Play control — but hold its bytes rather than start anything. Starting
 * an `AudioContext` has to happen inside the Play button's own click
 * handler (see handleAudioPlayClick()), not here, or the browser refuses to
 * let it produce sound.
 *
 * Length is the song's real duration, from `moduleMeta()`. It used to be the
 * file size, because the binding carried no duration — the core has walked
 * the song for one all along, and `@play198x/web` 0.1.3 exposes the walk.
 * A module that comes back on itself is marked rather than given a bare
 * time: a looping song has no single length, and printing the point it
 * returns to as if it were an ending states something untrue.
 *
 * The metadata read is wrapped: `probe()` has already said these bytes are a
 * ProTracker module, but the two checks are not the same depth, and a file
 * that satisfies the first and fails the second must still reach the
 * transport. The panel then shows what it could read and omits what it
 * could not, rather than the whole panel failing over a title.
 */
function showAudioPlayer(bytes: Uint8Array, sourceLabel: string, format: string, certain: boolean): void {
  hidePlayer();
  disposeAudio();
  pendingAudioBytes = bytes;

  const els = audioElements();
  if (!els.panel) {
    return;
  }

  if (els.name) {
    els.name.textContent = sourceLabel;
  }
  if (els.format) {
    const qualifier = certain ? '' : 'probably ';
    els.format.textContent = `${qualifier}${AUDIO_FORMATS[format] ?? format}`;
  }

  // An `.ay` is a different kind of thing from a module: no sample slots, no
  // voice count from a magic, and a table of songs instead of one tune. It
  // takes this branch and leaves before any of the module fields below.
  // An `.ay` is a different kind of thing from a module: no sample slots,
  // no voice count from a magic, and a table of songs instead of one tune.
  // Both branches fall through to the reveal below — an early return here
  // filled the panel and left it hidden.
  if (format === 'ay') {
    describeAyFile(els, bytes);
  } else {
    resetSongSelector(els);

    // Everything below this line is what the module says about itself, and the
    // file size is the fallback for all of it: a module whose bytes probe as
    // ProTracker but will not decode still has a size, and a visitor still gets
    // a panel and a Play button.
    let meta: ReturnType<typeof moduleMeta> | undefined;
    try {
      meta = moduleMeta(bytes);
    } catch {
      meta = undefined;
    }

    if (els.length) {
      els.length.textContent = meta ? describeDuration(meta) : describeSize(bytes.byteLength);
    }
    if (els.voices) {
      els.voices.textContent = meta ? `${meta.channels}` : '';
    }
    const title = meta?.title.trim() ?? '';
    if (els.title && els.titleLabel) {
      els.title.textContent = title;
      els.title.hidden = title === '';
      els.titleLabel.hidden = title === '';
    }
    if (els.samples && els.sampleList) {
      const names = meta?.sampleNames ?? [];
      // Trailing empty slots carry nothing and are not where anyone wrote — a
      // message runs down from the first empty slot after the samples, not up
      // from slot 31 — so the list stops after the last slot with text in it.
      // Empty slots *before* that stay, because they are the blank lines in
      // whatever was written.
      let last = names.length - 1;
      while (last >= 0 && names[last].trim() === '') {
        last -= 1;
      }
      const shown = names.slice(0, last + 1);
      els.sampleList.replaceChildren(
        ...shown.map((name) => {
          const li = document.createElement('li');
          li.textContent = name.trimEnd();
          return li;
        }),
      );
      els.samples.hidden = shown.length === 0;
    }

    if (els.position) {
      els.position.textContent = '';
    }
    if (els.status) {
      els.status.textContent = '';
    }
    setPlayButtonLabel('Play');
    if (els.playButton) {
      els.playButton.disabled = false;
    }
  }

  els.panel.hidden = false;
}

/**
 * The Play button's click handler: starts playback on the first press
 * (inside this very call stack, satisfying the user-gesture requirement —
 * see audio.ts's playModule() doc), toggles play/pause on every press after
 * that. Errors from playModule() (a malformed module past what probe()
 * already checked, an AudioContext the browser refuses) are shown in the
 * panel's own status line rather than thrown, the same discipline
 * decodeAndShow() applies to a failed image decode.
 *
 * `currentAudio = handle` only happens after confirming `audioGeneration`
 * hasn't moved since this call started. playModule()'s only `await` is
 * exactly the window a slow wasm/glue fetch leaves open for a new file to be
 * dropped: onFile → hideAllPanels() → disposeAudio() can run inside it,
 * bumping `audioGeneration` and hiding the audio panel entirely. Without the
 * check, the handle that resolves afterwards would still get published as
 * `currentAudio` — a tune playing with no transport on screen and no way to
 * stop it. See audioGeneration's own doc.
 */
async function handleAudioPlayClick(): Promise<void> {
  const els = audioElements();
  if (!els.playButton) {
    return;
  }

  if (currentAudio) {
    if (currentAudio.playing) {
      currentAudio.pause();
      setPlayButtonLabel('Play');
    } else {
      currentAudio.play();
      setPlayButtonLabel('Pause');
    }
    return;
  }

  if (!pendingAudioBytes) {
    return;
  }

  els.playButton.disabled = true;
  try {
    const token = audioGeneration;
    const handle = await playModule(pendingAudioBytes, currentSong);
    if (token !== audioGeneration) {
      // Superseded while playModule() was still starting — see this
      // function's doc. Dispose immediately rather than publish it: this is
      // the only reference to this handle that will ever exist.
      handle.dispose();
      return;
    }
    currentAudio = handle;
    // audio.ts's worklet already rate-limits and dedupes what it posts (see
    // its own process() comment), but this listener still fires once per
    // post — this second check is what stops the DOM write itself, the
    // other half of the same live-region flood: a screen reader announces
    // every write to a `role="status"` region, not just ones that change
    // what's displayed, so a write with unchanged text is still a wasted
    // announcement.
    let lastPositionText: string | undefined;
    handle.onPosition((position: PlayerPosition) => {
      const { position: positionEl } = audioElements();
      if (!positionEl) {
        return;
      }
      // A tune driven by an interrupt has no order table and no rows. It
      // reports the song it is playing and how many frames in it is — the
      // file's own unit of time, which is what its declared length is in
      // too. Showing empty Order/pattern/row fields for one would be the
      // panel claiming a position it does not have.
      const text =
        position.kind === 'frame'
          ? `Song ${position.song + 1}, frame ${position.frame}`
          : `Order ${position.order}, pattern ${position.pattern}, row ${position.row}`;
      if (text === lastPositionText) {
        return;
      }
      lastPositionText = text;
      positionEl.textContent = text;
    });
    // A worklet that dies mid-tune (see audio.ts's post-ready
    // onprocessorerror handler) leaves nothing playing but would otherwise
    // leave the transport saying otherwise: the button still reading Pause,
    // the status line still empty, and silence the only clue. Put the
    // failure where every other audio failure goes — the panel's status
    // line — and hand the panel back in the state showAudioPlayer() left it,
    // so the visitor can press Play and start over. `pendingAudioBytes`
    // survives a start, so that second press has everything it needs.
    //
    // The generation check is the same guard the await above uses: a new
    // drop may have replaced this tune between the crash and this listener
    // running, and the panel on screen then belongs to something else.
    handle.onError((failure: Error) => {
      if (token !== audioGeneration) {
        return;
      }
      handle.dispose();
      currentAudio = undefined;
      setPlayButtonLabel('Play');
      const current = audioElements();
      if (current.status) {
        current.status.textContent = `Playback stopped: ${failure.message}`;
      }
      if (current.playButton) {
        current.playButton.disabled = false;
      }
    });
    setPlayButtonLabel('Pause');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (els.status) {
      els.status.textContent = `Couldn't start playback: ${detail}`;
    }
  } finally {
    els.playButton.disabled = false;
  }
}

/**
 * Wire Player.astro's Play button to handleAudioPlayClick(). Called once,
 * from Player.astro's own script, at page load — mirrors
 * wireFormatOverride() below.
 */
export function wireAudioPlayer(): void {
  const { playButton, song } = audioElements();
  if (!playButton) {
    return;
  }
  playButton.addEventListener('click', () => {
    void handleAudioPlayClick();
  });

  // Changing song is not a seek. Each song in a `.ay` is a separate entry
  // point with its own starting register state, so the only way to hear
  // another one is to build a player for it — which means tearing down
  // whatever is playing and starting again. Doing that here, rather than
  // waiting for the next Play press, is what makes the control behave the
  // way a listener expects a song list to: pick one and it plays.
  song?.addEventListener('change', () => {
    const chosen = Number.parseInt(song.value, 10);
    currentSong = Number.isNaN(chosen) ? 0 : chosen;

    if (!currentAudio) {
      return;
    }
    // Bump the generation first: an in-flight playModule() from the previous
    // selection must not publish itself over this one (see
    // handleAudioPlayClick's own token check).
    audioGeneration += 1;
    currentAudio.dispose();
    currentAudio = undefined;
    setPlayButtonLabel('Play');
    void handleAudioPlayClick();
  });
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
 * Read one entry's bytes, identify them, and open them: draw an image or
 * show an audio entry's Play control, reporting what an unrecognised entry
 * is without opening anything. Shared by the single-entry path in
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
    hideAllPanels();
    return;
  }

  const probed = probe(bytes);
  const result = classify(probed, bytes.byteLength);
  const format = probed?.format;
  const certain = probed?.confidence === 'certain';
  probed?.free();

  report(result.message);
  if (result.route === 'image' && format) {
    hideAudioPlayer();
    decodeAndShow(bytes, path, format, certain ? 'certain' : 'probable');
  } else if (result.route === 'audio' && format) {
    showAudioPlayer(bytes, path, format, certain);
  } else {
    hideAllPanels();
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

  // Always a <button> — never a styled <span> for the disabled case.
  // `aria-disabled` only changes what's announced on an element that
  // already carries a widget role; on a bare <span> it does nothing in
  // NVDA, JAWS or VoiceOver, so a visitor using one would hear the label
  // text but never learn the row is unopenable — it would only *look*
  // grey. A native `disabled` button gives that for free: announced as
  // disabled, dropped from the tab order, and inert without a click
  // handler to suppress or a role to fake.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'archive-entry-button';
  button.textContent = `${path} — ${description.label}`;

  if (description.openable) {
    button.addEventListener('click', () => {
      // Guards against a stale row from an archive that's since been
      // replaced by a new drop — freeContainer() clears currentContainer
      // before this one could ever be read from again.
      if (currentContainer === container) {
        openEntry(container, path, file);
      }
    });
  } else {
    button.disabled = true;
  }

  li.appendChild(button);
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

  // Both branches below own `container` outright and must free it before
  // returning — in `finally`, not after a plain call, so a throw from
  // report()/hideAllPanels()/openEntry() can't leak up to 64 MiB of wasm
  // memory. The single-entry branch is the common path (a plain dropped
  // file is always a one-entry container), not an edge case, so this
  // matters on every ordinary drop, not just archives.
  if (count === 0) {
    try {
      report(`${file.name} is an empty archive — there's nothing inside to open.`);
      hideAllPanels();
    } finally {
      container.free();
    }
    return;
  }

  if (count === 1) {
    try {
      const path = container.entry_path(0) ?? file.name;
      openEntry(container, path, file);
    } finally {
      container.free();
    }
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
 * MAX_CONTAINER_BYTES's comment for why that ordering matters. An oversized
 * file also hides whatever panel was already showing, the same as every
 * other refusal path here — otherwise a good file's picture or module stays
 * on screen under a message about a completely different, rejected file.
 *
 * `droppedCount` is how many files the visitor actually dropped or picked —
 * always 1 from the file picker (it has no `multiple` attribute), sometimes
 * more from a drag-and-drop with several files selected. Only `file` (the
 * first) is ever opened; when there were others, the status line says so
 * rather than silently acting on one of several files with no acknowledgment
 * the rest were ignored.
 */
export async function onFile(file: File, droppedCount = 1): Promise<void> {
  const sizeProblem = sizeError(file.size);
  if (sizeProblem) {
    report(sizeProblem);
    hideAllPanels();
    hideArchiveList();
    return;
  }

  // Reported before either await below: loadWasm() fetches this player's
  // ~224 KiB decoder lazily, on the FIRST file any visitor ever drops (see
  // loadWasm()'s own comment), and file.arrayBuffer() itself takes a moment
  // for a large file. Measured with a 4s wasm response: without this, the
  // status line stayed completely empty for the whole wait, reading as
  // though the page had ignored the drop.
  const multiNote = droppedCount > 1 ? ` (${droppedCount} files dropped — only ${file.name} opens)` : '';
  report(`Reading ${file.name}${multiNote}…`);

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Split deliberately into two try/catches with two different messages.
  // loadWasm() failing means OUR player asset (the .wasm this page ships)
  // didn't load — a network blip, not anything wrong with the visitor's
  // file — so it must not be blamed on "that file". Only a throw from the
  // second block (reading/opening what the visitor actually dropped) is a
  // problem with their file.
  try {
    await loadWasm();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't load the player: ${detail}. Drop the file again to retry.`);
    hideAllPanels();
    hideArchiveList();
    return;
  }

  try {
    freeContainer();
    hideAllPanels();
    const container = new Container(bytes, file.name);
    openContainer(container, file);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't read that file: ${detail}`);
    hideAllPanels();
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
