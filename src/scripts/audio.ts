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
// codebase keeps calling the same public `Player` class the package
// README documents — just from inside the worklet instead of the main
// thread.

const PROCESSOR_NAME = 'play198x-module-player';

/** Where playback has got to, in whichever terms the format has.
 *
 * A discriminated union rather than one shape with optional fields: a `.ay`
 * has no order table and a module has no subtune, so a single shape would
 * mean four properties that are `undefined` half the time and a reader with
 * no way to know which half. `kind` is read once and settles it. Mirrors
 * `play198x_core::player::Position`, whose own doc says why it is one variant
 * per *shape* rather than per format. */
export type PlayerPosition =
  | { kind: 'module'; order: number; pattern: number; row: number; tick: number }
  | { kind: 'frame'; song: number; frame: number };

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
  onPosition(listener: (position: PlayerPosition) => void): () => void;
  /** Subscribe to a failure that ends playback *after* it started — in
   * practice a worklet processor that throws mid-render. Playback is over by
   * the time this fires: `playing` is already false, the node renders silence
   * for the rest of its life (a processor that throws is put in an error
   * state by the spec and never recovers), and the handle should be disposed.
   * Returns a function that unsubscribes. */
  onError(listener: (error: Error) => void): () => void;
  /** Frees the wasm-side `Player` and closes the `AudioContext`.
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
    // Mirrors the wasm side's own default (see the 'init' case below) and
    // the JS side's 'play'/'pause' messages, so process() below knows
    // whether to post a position at all — see this file's own comment
    // there on why the old unconditional post kept flooding the polite
    // live region after Pause.
    this.playing = false;
    // How many process() calls between position posts — computed once
    // 'init' knows the real quantum/sampleRate, so it lands close to but
    // never over ~4 posts/second regardless of what render quantum the
    // wasm build uses.
    this.positionIntervalCalls = 1;
    this.lastPosition = undefined;
    // Overwritten at 'init' from the player itself; 'module' until then so a
    // position posted before init cannot claim to be a subtune.
    this.positionKind = 'module';
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(data) {
    switch (data && data.type) {
      case 'init': {
        try {
          initSync({ module: new Uint8Array(data.wasmBytes) });
          this.player = new Player(new Uint8Array(data.moduleBytes), data.song || 0, sampleRate);
          this.quantum = Player.renderQuantum();
          // Read once: which of the two groups of position getters mean
          // anything for this file. Asking every post would be asking a
          // question whose answer cannot change.
          this.positionKind = this.player.positionKind();
          // Player's own constructor doc: it "start[s] it playing" —
          // this mirrors that default rather than guessing, since nothing
          // ever posts an explicit 'play' message for the very first start
          // (see playModule() below: it connects the node and flips its
          // own playing flag without ever sending 'play').
          this.playing = true;
          this.positionIntervalCalls = Math.max(1, Math.round(sampleRate / this.quantum / 4));
          this.refreshViews();
          this.port.postMessage({ type: 'ready' });
        } catch (error) {
          this.port.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
        }
        break;
      }
      case 'play':
        if (this.player) this.player.setPlaying(true);
        this.playing = true;
        break;
      case 'pause':
        if (this.player) this.player.setPlaying(false);
        this.playing = false;
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
      const playbackError = this.player.playbackError;
      if (playbackError) {
        throw new Error(playbackError);
      }
      output[0].set(this.left.subarray(0, rendered));
      if (output[1]) {
        output[1].set(this.right.subarray(0, rendered));
      }
      // Posted at most ~4×/s (positionIntervalCalls, fixed once at init from
      // the real quantum/sampleRate — this used to be a flat "every 12
      // calls", ~31×/s at 128 samples/48kHz, an order of magnitude past what
      // this file's own header comment always claimed) and never at all
      // while paused — a paused transport holds its row (see
      // Player.set_playing's doc), so there is nothing new to say, and
      // the old code posted unconditionally regardless of this.playing.
      // Also skipped when the position hasn't actually changed since the
      // last post, so a slow tune landing on the same row across several
      // checks doesn't repost it.
      if (this.playing && this.callCount % this.positionIntervalCalls === 0) {
        const position =
          this.positionKind === 'frame'
            ? { kind: 'frame', song: this.player.song, frame: this.player.frame }
            : {
                kind: 'module',
                order: this.player.order,
                pattern: this.player.pattern,
                row: this.player.row,
                tick: this.player.tick,
              };
        const last = this.lastPosition;
        if (
          !last ||
          last.kind !== position.kind ||
          last.order !== position.order ||
          last.pattern !== position.pattern ||
          last.row !== position.row ||
          last.tick !== position.tick ||
          last.song !== position.song ||
          last.frame !== position.frame
        ) {
          this.port.postMessage({ type: 'position', ...position });
          this.lastPosition = position;
        }
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
    // Cache the promise, not a settled success — see loadWasmBytes() below
    // and player.ts's loadWasm() for the same fix against the same failure:
    // caching a rejection here means one 503 on the glue bricks audio for
    // the rest of the session, because a rejected promise never re-settles
    // and every later play() would just replay this same dead promise. The
    // `p` indirection guards a race where a second, slower call already
    // replaced this one before it rejects.
    const p = (async () => {
      const glueResponse = await fetch(wasmGlueUrl());
      if (!glueResponse.ok) {
        throw new Error(`Couldn't fetch the audio engine (${glueResponse.status}).`);
      }
      const glueSource = await glueResponse.text();
      const combined = `${TEXT_CODEC_POLYFILL}\n${glueSource}\n${PROCESSOR_SOURCE}`;
      const blob = new Blob([combined], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    })();
    workletModuleUrlPromise = p;
    p.catch(() => {
      if (workletModuleUrlPromise === p) {
        workletModuleUrlPromise = undefined;
      }
    });
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
    // See buildWorkletModuleUrl() above for why the cache must clear itself
    // on rejection rather than pin a dead promise forever.
    const p = fetch(wasmBinaryUrl()).then((response) => {
      if (!response.ok) {
        throw new Error(`Couldn't fetch the audio engine's wasm (${response.status}).`);
      }
      return response.arrayBuffer();
    });
    wasmBytesPromise = p;
    p.catch(() => {
      if (wasmBytesPromise === p) {
        wasmBytesPromise = undefined;
      }
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
export async function playModule(bytes: Uint8Array, song = 0): Promise<ModulePlaybackHandle> {
  const audioContext = new AudioContext();

  // Everything from here to the `return` below runs inside this try: the
  // context is created (necessarily, to stay inside the click's call stack —
  // see this function's own doc), but nothing has taken ownership of closing
  // it yet. A throw anywhere in this block — buildWorkletModuleUrl()'s fetch,
  // addModule(), loadWasmBytes()'s fetch, `new AudioWorkletNode` — used to
  // escape with the context still open: it was only ever closed on a
  // rejected `ready`, further down, which is a small slice of everything
  // that can go wrong here. Measured: 8 failed Play presses left 8
  // `AudioContext`s in `state: "running"`, none closed, each holding a
  // render thread and an output stream open for the tab's whole life. The
  // outer catch below is the single place that closes it for every failure
  // in this block, so no future addition here can reopen the leak by
  // forgetting its own cleanup.
  try {
    const moduleUrl = await buildWorkletModuleUrl();
    await audioContext.audioWorklet.addModule(moduleUrl);

    const wasmBytes = await loadWasmBytes();
    const node = new AudioWorkletNode(audioContext, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const positionListeners = new Set<(position: PlayerPosition) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    let playing = false;
    let disposed = false;

    // Resolves once the worklet's own `Player` has actually been built;
    // rejects with the worklet's own message if it hasn't. Bytes that pass
    // probe()'s lighter magic-number check (see player.ts) can still fail the
    // real parse inside `new Player(...)` — an unsupported channel
    // count (`6CHN`/`8CHN`/`FLT8` pass the magic check but are rejected by
    // the decoder), for one concrete, reachable example. That failure
    // happens entirely inside the worklet. Without waiting for this,
    // playModule() resolved the instant it posted the init message: a failed
    // module still handed the caller a "working" handle, the Play button
    // still flipped to Pause, and the only sign anything was wrong was a
    // console.error nobody but a developer would see. Waiting for `ready`
    // turns a real failure into a rejected promise here, which
    // handleAudioPlayClick()'s existing catch already surfaces in the status
    // line — no second error channel needed.
    // Two guards below close a hang the message-based confirmation above
    // still leaves open. The two *known* failures are covered only by
    // accident of where they happen to occur: a worklet whose module fails
    // to evaluate makes `new AudioWorkletNode(...)` throw synchronously
    // (already surfaced, further up), and a `Player` constructor
    // failure is caught by the processor's own try/catch and turned into an
    // `error` message (handled below). Neither guard defends a processor
    // whose constructor throws *before* `this.port.onmessage` is assigned,
    // or a message that is otherwise dropped — then nothing ever arrives,
    // `ready` never settles, and the Play button would sit disabled forever
    // with no status line: the same silent failure this file exists to
    // replace, just relocated.
    //
    // `READY_TIMEOUT_MS` covers the gap: instantiating this wasm and
    // constructing a `Player` from it is single-digit-to-low-double-
    // digit milliseconds in practice (measured end-to-end, including
    // `AudioContext`/`addModule`/fetch on top of this step, at 16-44ms — see
    // task-8-report.md), so 3 seconds is generous headroom between "a slow
    // device doing honest work" and "nothing is ever coming."
    // `onprocessorerror` is the direct signal for the case the timeout would
    // otherwise catch only late and vaguely — it exists precisely for a
    // processor that throws during construction or processing — so it's
    // taken first when both could apply. Either guard rejects into the exact
    // same path `error` already uses, so a visitor sees identical behaviour
    // (the status line, the button staying "Play") whichever one fires.
    const READY_TIMEOUT_MS = 3000;
    let settled = false;
    const ready = new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `The audio worklet never confirmed it started (no 'ready' or 'error' message within ${READY_TIMEOUT_MS}ms).`,
          ),
        );
      }, READY_TIMEOUT_MS);

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      };

      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as
          | ({ type: 'position' } & PlayerPosition)
          | { type: 'heartbeat'; calls: number; glitches: number; maxGapMs: number }
          | { type: 'ready' }
          | { type: 'error'; message: string };
        if (data.type === 'position') {
          const { type: _type, ...position } = data;
          for (const listener of positionListeners) {
            listener(position);
          }
        } else if (data.type === 'ready') {
          // Marks the moment the worklet's own Player finished
          // construction — the next process() call renders real audio rather
          // than the pre-init silence. Logged for the same reason the
          // heartbeat is: whoever is verifying playback with devtools open.
          console.debug('[play198x audio] worklet ready');
          settleResolve();
        } else if (data.type === 'heartbeat') {
          // A cheap, permanent health signal — see this file's header comment
          // and AudioHeartbeat's doc. Nothing in the UI reads this; it's here
          // for whoever is verifying playback with devtools open.
          console.debug('[play198x audio] heartbeat', data satisfies AudioHeartbeat);
        } else if (data.type === 'error') {
          console.error('[play198x audio] worklet failed to start the module:', data.message);
          settleReject(new Error(data.message));
        }
      };

      // Fires for a processor that throws during construction or
      // processing — including, notably, before it ever assigns
      // `this.port.onmessage`, which is exactly the gap the timeout above
      // would otherwise have to catch blind. The event carries no reliable
      // detail across the worklet boundary in every engine, so the message
      // says what's known (a processor error occurred) rather than
      // fabricating specifics the event doesn't actually provide.
      node.onprocessorerror = (event) => {
        console.error('[play198x audio] worklet processor error', event);
        settleReject(new Error('The audio worklet processor failed unexpectedly.'));
      };
    });

    // Transfer *copies* of both buffers: the worklet takes ownership (a
    // transfer detaches what it's given), and this file's own cached
    // `wasmBytes` above needs to survive for the next play() call.
    const wasmBytesCopy = wasmBytes.slice(0);
    const moduleBytesCopy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    node.port.postMessage({ type: 'init', wasmBytes: wasmBytesCopy, moduleBytes: moduleBytesCopy, song }, [
      wasmBytesCopy,
      moduleBytesCopy,
    ]);

    try {
      await ready;
    } catch (error) {
      // The worklet never got a playable module — nothing to render, nothing
      // to tear down on its side. Detach from it (the outer catch below
      // closes the `AudioContext` itself, along with every other failure in
      // this block) rather than leave the node listening for messages that
      // will never help.
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.disconnect();
      throw error;
    }

    // `ready` has settled by now, so the handler installed inside the promise
    // above can only reach its `settled` check and no-op. That left the one
    // failure this file cannot see coming uncovered: a processor that throws
    // while *rendering* — a wasm trap in `process()`, a `render()` call on a
    // freed player — after playback is already under way. `playing` stayed
    // true, the transport went on reading as if a tune were running, and a
    // console.error was the only trace.
    //
    // There is nothing to retry. Once a processor throws, the spec puts the
    // node in an error state and it outputs silence for the rest of its life,
    // so this is a stop rather than a stumble: `playing` goes false and stays
    // false, and whoever holds the handle is told so it can say as much and
    // dispose it.
    node.onprocessorerror = (event) => {
      console.error('[play198x audio] worklet processor error during playback', event);
      playing = false;
      // Same reasoning as the startup path's message: the event carries no
      // detail that survives the worklet boundary in every engine, so this
      // says what is known rather than inventing specifics.
      const failure = new Error('The audio worklet stopped unexpectedly while playing.');
      for (const listener of errorListeners) {
        listener(failure);
      }
    };

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
      onPosition(listener: (position: PlayerPosition) => void) {
        positionListeners.add(listener);
        return () => positionListeners.delete(listener);
      },
      onError(listener: (error: Error) => void) {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        positionListeners.clear();
        errorListeners.clear();
        node.port.postMessage({ type: 'dispose' });
        node.port.onmessage = null;
        node.onprocessorerror = null;
        node.disconnect();
        void audioContext.close();
      },
    };
  } catch (error) {
    // Reached by any throw above — a fetch failure in
    // buildWorkletModuleUrl()/loadWasmBytes(), addModule() rejecting, `new
    // AudioWorkletNode` throwing, or the re-thrown `ready` rejection above —
    // and by nothing else, since a successful run returns from inside the
    // try. This is the one place that closes `audioContext` on failure, so
    // every failure path closes it exactly once instead of each new
    // failure mode needing to remember to add its own.
    void audioContext.close();
    throw error;
  }
}
