// The only file in this repo that knows how audio actually plays. Every
// other file works with a ModulePlaybackHandle — start it, pause it, read
// its position, dispose it — and never touches an AudioContext, a wasm byte,
// or a worklet message directly. If the shape ever has to change (a new
// browser workaround, a different transport), this is the one file that
// changes.
//
// The shape here was fixed by a spike (Task 1 of this project's plan) before
// any of this was written, and its two findings are load-bearing:
//
// 1. There is no `SharedArrayBuffer` on this site — it's static GitHub
//    Pages, which cannot set the COOP/COEP headers cross-origin isolation
//    needs. So the wasm can't share linear memory between the main thread
//    and the audio thread. Instead, the wasm is instantiated *inside* the
//    `AudioWorkletProcessor`, with its own private memory, and every sample
//    is rendered on the audio thread with no bridge back to the main thread
//    except small position/heartbeat messages.
//
// 2. `postMessage`ing a *compiled* `WebAssembly.Module` into a worklet's
//    port fails silently in Chrome — no exception, no error event, the
//    message simply never arrives (isolated with a control: the identical
//    Module posts fine to a plain `Worker`). The fix is to transfer the raw
//    wasm *bytes* (an `ArrayBuffer`, moved not shared) and instantiate them
//    inside the worklet instead.
//
// One adjustment beyond what the spike measured: the spike's throwaway wasm
// module was hand-written `extern "C"` with no imports. The real
// `@play198x/web` package is wasm-bindgen-generated and its wasm binary
// imports host functions (`__wbindgen_throw`, `__wbindgen_memory`, and so
// on) from the glue file wasm-bindgen ships alongside it — so
// `WebAssembly.instantiate(bytes, {})` (empty imports) does not work against
// this real module the way it did against the spike's bespoke one; it needs
// the actual import object wasm-bindgen's own glue builds. Rather than
// reimplement that (unstable, private wasm-bindgen wiring that could change
// on any dependency bump with no semver signal), this file fetches
// `@play198x/web`'s own generated JS as text and runs it *inside* the
// worklet, then calls its exported `initSync(bytes)` — the synchronous,
// already-instantiated-bytes entry point wasm-bindgen ships for exactly
// this kind of host (a worker/worklet that already has the bytes and can't
// await a `fetch()` mid-render). That keeps every byte of wasm glue on this
// file's list of "things it knows are unstable", and everywhere else in the
// codebase keeps calling the same public `ModulePlayer` class the package
// README documents — just from inside the worklet instead of the main
// thread.

const PROCESSOR_NAME = 'play198x-module-player';

/** What one position update names — the same shape `Engine::position()`
 * exposes through `ModulePlayer`'s getters, read from inside the worklet
 * (the only place a `ModulePlayer` instance exists) and relayed here. */
export interface ModulePosition {
  order: number;
  pattern: number;
  row: number;
  tick: number;
}

/** A cheap, per-second self-report from the render callback itself — see
 * this file's header comment on why the worklet, not the main thread,
 * is what can tell whether a callback was ever late. Kept for whoever is
 * verifying playback (console.debug only; nothing in the UI reads this),
 * not part of the transport contract other files depend on. */
export interface AudioHeartbeat {
  calls: number;
  glitches: number;
  maxGapMs: number;
}

export interface ModulePlaybackHandle {
  /** Start or resume playback. Safe to call again after pause(). */
  play(): void;
  /** Pause playback. The worklet keeps rendering — silence, not a stopped
   * callback — because a callback starved of samples clicks; see
   * `set_playing`'s own doc in `@play198x/web`. */
  pause(): void;
  /** True once playback has started and hasn't since been paused. Mirrors
   * what was last asked for, not a round trip to the worklet. */
  readonly playing: boolean;
  /** Jump to the top of an order. */
  seekOrder(order: number): void;
  /** Subscribe to position updates, throttled to a few times a second —
   * plenty for a visible order/pattern/row readout, not per-callback.
   * Returns a function that unsubscribes. */
  onPosition(listener: (position: ModulePosition) => void): () => void;
  /** Frees the wasm-side `ModulePlayer` and closes the `AudioContext`.
   * Idempotent — safe to call more than once, e.g. once from a "drop a new
   * file" cleanup and again from a page-unload handler racing it. */
  dispose(): void;
}

// `AudioWorkletGlobalScope` in Chrome (confirmed live, not from
// documentation — MDN and the spec both list these as available to every
// worker-like global) has no `TextDecoder`/`TextEncoder`: constructing
// either throws `ReferenceError: TextDecoder is not defined`. The
// wasm-bindgen glue this file splices into the worklet (see
// buildWorkletModuleUrl()) constructs both unconditionally at module top
// level, so without this polyfill the whole combined module throws during
// evaluation — and Chrome does not surface that as a rejected
// `addModule()` promise or any other visible error; `registerProcessor`
// simply never runs, and every later `new AudioWorkletNode(...)` fails with
// an unrelated-looking "not defined in AudioWorkletGlobalScope" message.
// Isolated by bisection: the identical combined source runs to completion
// (reaching the final `registerProcessor` call) once this is prepended,
// and fails at the exact same line without it, confirmed by having the
// processor `postMessage` its own caught exception back to the main
// thread. Only enough of each class is implemented to satisfy what the
// glue actually calls: `TextDecoder` with `fatal`/no-arg `decode()`, and a
// plain `TextEncoder.encode()` — the glue already carries its own fallback
// for a missing `encodeInto` (see its `if (!('encodeInto' in
// cachedTextEncoder))` branch), so this doesn't need to provide one.
const TEXT_CODEC_POLYFILL = `
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    constructor(label, options) { this.fatal = !!(options && options.fatal); }
    decode(input) {
      if (input === undefined) return '';
      const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength ?? input.length);
      let result = '', i = 0;
      while (i < bytes.length) {
        const b1 = bytes[i];
        let cp, size;
        if (b1 < 0x80) { cp = b1; size = 1; }
        else if ((b1 & 0xe0) === 0xc0) { cp = b1 & 0x1f; size = 2; }
        else if ((b1 & 0xf0) === 0xe0) { cp = b1 & 0x0f; size = 3; }
        else if ((b1 & 0xf8) === 0xf0) { cp = b1 & 0x07; size = 4; }
        else { if (this.fatal) throw new TypeError('Invalid UTF-8'); result += '\\ufffd'; i += 1; continue; }
        if (i + size > bytes.length) { if (this.fatal) throw new TypeError('Invalid UTF-8'); result += '\\ufffd'; break; }
        let valid = true;
        for (let j = 1; j < size; j++) {
          const b = bytes[i + j];
          if ((b & 0xc0) !== 0x80) { valid = false; break; }
          cp = (cp << 6) | (b & 0x3f);
        }
        if (!valid) { if (this.fatal) throw new TypeError('Invalid UTF-8'); result += '\\ufffd'; i += 1; continue; }
        if (cp > 0xffff) {
          cp -= 0x10000;
          result += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          result += String.fromCharCode(cp);
        }
        i += size;
      }
      return result;
    }
  };
}
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    encode(input) {
      const str = String(input === undefined ? '' : input);
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        let cp = str.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
          const low = str.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
            i += 1;
          }
        }
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
      return new Uint8Array(bytes);
    }
  };
}
`;

// The worklet's own source, as a string this file assembles once and hands
// to `Blob`/`addModule`. `registerProcessor` names it PROCESSOR_NAME so
// `AudioWorkletNode`'s constructor below can find it. This runs entirely
// inside `AudioWorkletGlobalScope`: no DOM, no import of this file or
// anything else in this repo, only the two things it's given at
// construction time — its own copy of the wasm-bindgen glue (spliced in
// ahead of this string, see buildWorkletModuleUrl()) and, over the port, the
// raw wasm bytes and the module bytes to play.
const PROCESSOR_SOURCE = `
class Play198xModuleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player = undefined;
    this.quantum = 128;
    this.left = new Float32Array(0);
    this.right = new Float32Array(0);
    this.callCount = 0;
    this.glitchCount = 0;
    this.maxGapMs = 0;
    this.lastCallbackTime = undefined;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(data) {
    switch (data && data.type) {
      case 'init': {
        try {
          initSync(new Uint8Array(data.wasmBytes));
          this.player = new ModulePlayer(new Uint8Array(data.moduleBytes), sampleRate);
          this.quantum = ModulePlayer.renderQuantum();
          this.refreshViews();
          this.port.postMessage({ type: 'ready' });
        } catch (error) {
          this.port.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
        }
        break;
      }
      case 'play':
        if (this.player) this.player.set_playing(true);
        break;
      case 'pause':
        if (this.player) this.player.set_playing(false);
        break;
      case 'seek':
        if (this.player) this.player.seek_order(data.order);
        break;
      case 'dispose':
        if (this.player) {
          this.player.free();
          this.player = undefined;
        }
        break;
      default:
        break;
    }
  }

  // A view over wasm memory detaches the moment this wasm instance's memory
  // grows — see the @play198x/web README's "Views detach when memory grows"
  // section. This player's own buffers never cause that (render() never
  // reallocates them), but nothing stops it happening from elsewhere in the
  // same instance, so every render checks the buffer reference first.
  refreshViews() {
    const memory = wasmMemory();
    this.left = new Float32Array(memory.buffer, this.player.leftPtr, this.quantum);
    this.right = new Float32Array(memory.buffer, this.player.rightPtr, this.quantum);
  }

  process(_inputs, outputs) {
    const now = currentTime;
    if (this.lastCallbackTime !== undefined) {
      const gapMs = (now - this.lastCallbackTime) * 1000;
      const expectedMs = (this.quantum / sampleRate) * 1000;
      if (gapMs > expectedMs * 1.5) this.glitchCount += 1;
      if (gapMs > this.maxGapMs) this.maxGapMs = gapMs;
    }
    this.lastCallbackTime = now;
    this.callCount += 1;
    if (this.callCount % Math.round(sampleRate / this.quantum) === 0) {
      this.port.postMessage({ type: 'heartbeat', calls: this.callCount, glitches: this.glitchCount, maxGapMs: this.maxGapMs });
    }

    const output = outputs[0];
    if (this.player && output && output[0]) {
      if (this.left.buffer !== wasmMemory().buffer) {
        this.refreshViews();
      }
      const rendered = this.player.render(this.quantum);
      output[0].set(this.left.subarray(0, rendered));
      if (output[1]) {
        output[1].set(this.right.subarray(0, rendered));
      }
      if (this.callCount % 12 === 0) {
        this.port.postMessage({
          type: 'position',
          order: this.player.order,
          pattern: this.player.pattern,
          row: this.player.row,
          tick: this.player.tick,
        });
      }
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, Play198xModuleProcessor);
`;

let workletModuleUrlPromise: Promise<string> | undefined;

// The wasm-bindgen glue and the wasm binary both need to reach the worklet
// as raw bytes/text this file fetches itself — `@play198x/web`'s own
// `init()` (a plain static import already used elsewhere in this repo for
// image decoding) only ever runs on the main thread and only ever
// instantiates one wasm instance for its own lifetime. `new URL(specifier,
// import.meta.url)` on a bare package specifier is the same pattern
// player.ts documents for the wasm binary already (see its loadWasm()
// comment) — Vite resolves it to a hashed, bundled asset URL at build time,
// no copy step, no dynamic import().
function wasmBinaryUrl(): URL {
  return new URL('@play198x/web/play198x_web_bg.wasm', import.meta.url);
}

function wasmGlueUrl(): URL {
  return new URL('@play198x/web/play198x_web.js', import.meta.url);
}

// Builds the worklet's module source (the published glue plus this file's
// own processor, see PROCESSOR_SOURCE above) and turns it into a Blob URL,
// once, cached for the lifetime of the page — the source never changes
// between plays, only the module bytes handed to it per play do.
async function buildWorkletModuleUrl(): Promise<string> {
  if (!workletModuleUrlPromise) {
    workletModuleUrlPromise = (async () => {
      const glueResponse = await fetch(wasmGlueUrl());
      if (!glueResponse.ok) {
        throw new Error(`Couldn't fetch the audio engine (${glueResponse.status}).`);
      }
      const glueSource = await glueResponse.text();
      const combined = `${TEXT_CODEC_POLYFILL}\n${glueSource}\n${PROCESSOR_SOURCE}`;
      const blob = new Blob([combined], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    })();
  }
  return workletModuleUrlPromise;
}

let wasmBytesPromise: Promise<ArrayBuffer> | undefined;

// Fetched once and kept as the pristine original. Every play() transfers a
// *copy* (`.slice(0)`) into the worklet — a transfer detaches the buffer it
// moves, and re-fetching a several-hundred-KB wasm binary on every second
// module a visitor drops would be wasteful when a slice is nearly free.
async function loadWasmBytes(): Promise<ArrayBuffer> {
  if (!wasmBytesPromise) {
    wasmBytesPromise = fetch(wasmBinaryUrl()).then((response) => {
      if (!response.ok) {
        throw new Error(`Couldn't fetch the audio engine's wasm (${response.status}).`);
      }
      return response.arrayBuffer();
    });
  }
  return wasmBytesPromise;
}

/**
 * Start playing a ProTracker module's raw bytes.
 *
 * MUST be called from inside a user gesture's own call stack (a click
 * handler, synchronously, before any `await`) — this is what constructs the
 * `AudioContext`, and browsers refuse to let one produce sound otherwise.
 * Callers show the module's name and a play control first, and call this
 * only once that control is pressed; see src/scripts/player.ts.
 */
export async function playModule(bytes: Uint8Array): Promise<ModulePlaybackHandle> {
  const audioContext = new AudioContext();

  const moduleUrl = await buildWorkletModuleUrl();
  await audioContext.audioWorklet.addModule(moduleUrl);

  const wasmBytes = await loadWasmBytes();
  const node = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const positionListeners = new Set<(position: ModulePosition) => void>();
  let playing = false;
  let disposed = false;

  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as
      | { type: 'position'; order: number; pattern: number; row: number; tick: number }
      | { type: 'heartbeat'; calls: number; glitches: number; maxGapMs: number }
      | { type: 'ready' }
      | { type: 'error'; message: string };
    if (data.type === 'position') {
      const position: ModulePosition = { order: data.order, pattern: data.pattern, row: data.row, tick: data.tick };
      for (const listener of positionListeners) {
        listener(position);
      }
    } else if (data.type === 'ready') {
      // Marks the moment the worklet's own ModulePlayer finished
      // construction — the next process() call renders real audio rather
      // than the pre-init silence. Logged for the same reason the
      // heartbeat is: whoever is verifying playback with devtools open.
      console.debug('[play198x audio] worklet ready');
    } else if (data.type === 'heartbeat') {
      // A cheap, permanent health signal — see this file's header comment
      // and AudioHeartbeat's doc. Nothing in the UI reads this; it's here
      // for whoever is verifying playback with devtools open.
      console.debug('[play198x audio] heartbeat', data satisfies AudioHeartbeat);
    } else if (data.type === 'error') {
      console.error('[play198x audio] worklet failed to start the module:', data.message);
    }
  };

  // Transfer *copies* of both buffers: the worklet takes ownership (a
  // transfer detaches what it's given), and this file's own cached
  // `wasmBytes` above needs to survive for the next play() call.
  const wasmBytesCopy = wasmBytes.slice(0);
  const moduleBytesCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  node.port.postMessage({ type: 'init', wasmBytes: wasmBytesCopy, moduleBytes: moduleBytesCopy }, [
    wasmBytesCopy,
    moduleBytesCopy,
  ]);

  node.connect(audioContext.destination);
  playing = true;

  return {
    play() {
      if (disposed) return;
      playing = true;
      node.port.postMessage({ type: 'play' });
    },
    pause() {
      if (disposed) return;
      playing = false;
      node.port.postMessage({ type: 'pause' });
    },
    get playing() {
      return playing;
    },
    seekOrder(order: number) {
      if (disposed) return;
      node.port.postMessage({ type: 'seek', order });
    },
    onPosition(listener: (position: ModulePosition) => void) {
      positionListeners.add(listener);
      return () => positionListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      positionListeners.clear();
      node.port.postMessage({ type: 'dispose' });
      node.port.onmessage = null;
      node.disconnect();
      void audioContext.close();
    },
  };
}
