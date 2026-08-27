// Takes a file — dropped or picked, it makes no difference — and says what
// it is. Both DropTarget.astro's drag-and-drop zone and its file picker call
// onFile() with the same File object; the picker is the accessible path
// (keyboard, touch, screen reader), not a fallback bolted on afterwards.
//
// This is as far as this task goes: it identifies the file and names where
// it will go next. Drawing the picture is Task 5; playing a module is
// Task 8. Nothing here decodes anything.

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

type Play198xWeb = typeof import('@play198x/web');

// A plain `import('/wasm/play198x_web.js')` — even with `/* @vite-ignore */`
// — still gets rewritten by Vite's modulepreload helper, which leaves an
// unresolved `__VITE_PRELOAD__` in the output here because this script is
// inlined into the page rather than emitted as its own chunk (the pass that
// normally fills that placeholder in never runs). Building the import
// through `Function` keeps the specifier out of Vite's static analysis
// entirely, so nothing rewrites it: the browser resolves it exactly as it
// resolves the equivalent import in index.astro's own inline probe script.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Play198xWeb>;

let wasmReady: Promise<Play198xWeb> | undefined;

// The published package is copied to public/wasm/ by scripts/build-wasm.mjs
// (see the prebuild hook) and loaded from there, exactly as the probe-of-life
// check in src/pages/index.astro already does.
function loadWasm(): Promise<Play198xWeb> {
  if (!wasmReady) {
    wasmReady = dynamicImport('/wasm/play198x_web.js').then(async (mod) => {
      await mod.default();
      return mod;
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

/**
 * Read a dropped or picked file, identify it, and report where it will go.
 * Called identically from both input paths in DropTarget.astro.
 */
export async function onFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  try {
    const { probe } = await loadWasm();
    const probed = probe(bytes);
    report(classify(probed, bytes.byteLength).message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report(`Couldn't read that file: ${detail}`);
  }
}
