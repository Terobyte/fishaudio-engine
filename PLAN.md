# Fish Audio WebSocket TTS — Implementation Plan (v4, two Opus audits applied)

**Date:** 2026-04-21
**Reference:** sibling `tts/deepgram/` (TypeScript, zero-dep, AsyncGenerator-based)
**Goal:** fastest artifact-free streaming TTS pipeline, TypeScript reference that ports cleanly to Python / Swift / React Native.

**v2 changelog:** applied findings from 4 parallel Sonnet review agents covering protocol correctness, artifact root-cause, TS architecture, and cross-platform port fidelity.

**v3 changelog:** applied findings from a final exhaustive audit of Fish Audio's full docs index, Python SDK source, and GitHub issues (#47 keepalive, #54 voice-switch). Confirmed: **SDK does pure `b"".join()` byte passthrough with no audio post-processing, fade, smoothing, or buffering** — our raw-forward plan is the right approach.

**v4 changelog:** applied findings from two parallel Opus audits (protocol/docs verification + TS concurrency/port fidelity). Killed 7 blockers, cut YAGNI options roughly in half, and rewrote §2.5 `stream()` body to fix four real concurrency bugs (abort-before-connect race, user-iterator-blocks-finally, missing close() spec, undefined `asyncIter` helper). Full v4 diff table at §7.

---

## 0. Protocol recap (from Fish Audio docs + Python SDK source)

- **Endpoint:** `wss://api.fish.audio/v1/tts/live` (no query params)
- **Connection headers (both required):**
  - `Authorization: Bearer <api_key>`
  - `model: s1` (or `s2-pro`) — **not** a query param; it's a WebSocket upgrade header, same as Python SDK does it
- **Wire format:** MessagePack for **both** directions. Every WS binary frame is a msgpack-encoded object with an `event` discriminator field. No JSON, no raw binary.
- **Client → Server events (all msgpack):**
  | event     | payload                                                     | notes                                   |
  |-----------|-------------------------------------------------------------|-----------------------------------------|
  | `start`   | `{event, request: {text:"", format, sample_rate, reference_id, latency, chunk_length, temperature, top_p, prosody, normalize, condition_on_previous_chunks, ...}}` | must be first, `request.text` stays empty for streaming |
  | `text`    | `{event, text: "..."}`                                      | any number of times, concurrent with audio reception |
  | `flush`   | `{event}`                                                   | optional, forces generation of buffered text |
  | `stop`    | `{event}`                                                   | ends session; server sends remaining audio + finish, then closes socket |
- **Server → Client events (all msgpack):**
  | event     | payload                             | notes                                 |
  |-----------|-------------------------------------|---------------------------------------|
  | `audio`   | `{event, audio: <Uint8Array>}`      | audio bytes in configured format      |
  | `finish`  | `{event, reason: "stop" \| "error"}` | session done; server closes socket    |
  | *unknown* | any shape                           | **ignore silently** (spec says clients must ignore unknown events for forward compat). `log` is sometimes sent in debug mode but is not contractually documented; we treat it as unknown and log at debug. |

---

## 1. Chosen defaults (why each)

| Parameter | Value | Rationale |
|---|---|---|
| `model` header | `s1` | single-speaker case. Python SDK's `stream_websocket` default is `s2-pro` (multi-speaker); we diverge because multi-speaker adds latency and has no benefit for our use case |
| `format` | `pcm` | **artifact-free by construction** — no codec frames, no container. Chunks concatenate cleanly |
| `sample_rate` | `44100` | AsyncAPI spec: default is `null` → server infers 44100 for PCM. Explicitly sending 44100 is safe. Bandwidth (~1.4 Mbps if int16) is trivial |
| `latency` | `balanced` | faster TTFB than `normal`. The Python SDK defaults to `balanced` too. **Not including `'low'`:** docs page lists it but SDK `LatencyMode` Literal rejects it — unverified, skipped until empirically confirmed |
| `chunk_length` | `100` | minimum allowed (100–300). Smaller = faster first audio. SDK always sends `200` explicitly (from `TTSConfig`); wire default `300` only applies when field is omitted entirely, so we must send our chosen value |
| `condition_on_previous_chunks` | `true` | **explicitly set** rather than relying on server default. Ensures sample-level continuity across chunk boundaries (preventing audible seams even in PCM) |
| `temperature` | `0.7` | Fish default |
| `top_p` | `0.7` | Fish default |
| `normalize` | `true` | Fish default; cleans punctuation/abbrev before synthesis |
| `reference_id` | `92a2600282e547f098b4a8de1bc9a44a` | JLM4.7 voice from user's CLAUDE.md |

**Deliberately NOT exposed in v1 (YAGNI, per v4 audit):** `min_chunk_length`, `max_new_tokens`, `repetition_penalty`, `early_stop_threshold`, `mp3_bitrate`, `opus_bitrate`, `prosody.*`, `references[]`, `pingTimeoutMs`, `maxMessageSizeBytes`. Rationale per option:
- Non-PCM bitrate knobs (`mp3_bitrate`, `opus_bitrate`) only matter if we add codec output — v1 is PCM-only per §5
- Tuning knobs (`max_new_tokens`, `repetition_penalty`, `early_stop_threshold`, `min_chunk_length`) have sensible server defaults; add when a user actually needs them
- `prosody.*`: v1 uses reference voice as-is; speed/volume/normalizeLoudness tuning is future work (note: `normalizeLoudness` is S2-Pro-only per docs and rejected by SDK's `Prosody` type)
- `pingTimeoutMs`: Python SDK issue #47 is a **Python-only** bug (httpx_ws sends client pings every 20s). undici's client does not send periodic pings at all — the bug cannot manifest here. We add one e2e test with a 25-sec idle gap to verify, not a user-facing knob
- `maxMessageSizeBytes`: undici's WebSocket receiver has **no default payload cap** (unlike httpx_ws's 64 KiB). No defensive knob needed

---

## 2. File-by-file plan

```
fishaudio/
├── package.json               @fishaudio-engine/core, deps: @msgpack/msgpack; transitively uses undici (Node 22+ builtin)
├── tsconfig.json              NodeNext module + NodeNext resolution; .js extensions required in imports
├── .env                       FISH_API_KEY=<key>
├── .gitignore
├── DESIGN.md                  high-level design
├── PLAN.md                    this file (v2, post-review)
├── README.md                  user-facing
├── src/
│   ├── index.ts
│   ├── common/
│   │   ├── index.ts
│   │   ├── types.ts           errors (with `kind` discriminator tag), Logger, ConnectionState
│   │   ├── msgpack.ts         encode/decode helpers, with runtime type-guard for incoming frames
│   │   └── websocket.ts       WebSocket wrapper using `undici`'s WebSocket explicitly (for headers support)
│   └── tts/
│       ├── index.ts
│       ├── types.ts           TTSClientOptions, AudioChunk, StreamOptions, event unions
│       └── client.ts          FishAudioTTS class
└── scripts/
    └── e2e-test.mjs           stream text → save .wav (44100 Hz header) → verify bit depth → measure TTFB
```

### 2.1 `src/common/types.ts`

```ts
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'closing' | 'error';

// Each method typed individually — the comma-list form typed only the last field
export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
export const silentLogger: Logger = { debug:()=>{}, info:()=>{}, warn:()=>{}, error:()=>{} };

// Error hierarchy with `kind` discriminator — tags map 1:1 to Swift enum cases
export type FishAudioErrorKind = 'auth' | 'connection' | 'protocol' | 'abort';

// Use native ES2022 Error.cause (second constructor arg) — no custom field
export class FishAudioEngineError extends Error {
  override name = 'FishAudioEngineError';
  readonly kind: FishAudioErrorKind = 'protocol'; // overridden by subclasses
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export class FishAudioAuthError extends FishAudioEngineError {
  override name = 'FishAudioAuthError';
  override readonly kind = 'auth' as const;
}
export class FishAudioConnectionError extends FishAudioEngineError {
  override name = 'FishAudioConnectionError';
  override readonly kind = 'connection' as const;
}
export class FishAudioProtocolError extends FishAudioEngineError {
  override name = 'FishAudioProtocolError';
  override readonly kind = 'protocol' as const;
}
export class FishAudioAbortError extends FishAudioEngineError {
  override name = 'FishAudioAbortError';
  override readonly kind = 'abort' as const;
}
```

### 2.2 `src/common/msgpack.ts`

```ts
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

export const encode = (obj: unknown): Uint8Array => msgpackEncode(obj);

// Decode with runtime sanity check: must be a plain object with a string `event` field
export const decodeEvent = (buf: ArrayBuffer | Uint8Array): { event: string; [k: string]: unknown } | null => {
  let parsed: unknown;
  try { parsed = msgpackDecode(buf); }
  catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.event !== 'string') return null;
  return obj as { event: string; [k: string]: unknown };
};
```

Why: the cast `as FishAudioServerEvent` is a lie without a runtime guard. This helper centralizes the check once.

**Cross-platform note (for future Python port):** Python `msgpack` requires `use_bin_type=True` on the packer and `raw=False` on the unpacker, otherwise the `audio` bytes field goes over the wire as msgpack `raw` and gets decoded as string by `@msgpack/msgpack` on the receiving side — corrupting audio silently. JS port doesn't need flags (`@msgpack/msgpack` does the right thing by default).

### 2.3 `src/common/websocket.ts`

```ts
import { WebSocket } from 'undici';
import { FishAudioConnectionError, type ConnectionState, type Logger } from './types.js';
import { encode } from './msgpack.js';

export interface WebSocketWrapperOptions {
  url: string;
  headers: Record<string, string>;      // full set — Authorization + model + anything else
  connectTimeoutMs?: number;
  logger?: Logger;
  onBinaryMessage?: (data: ArrayBuffer) => void;
  onStringMessage?: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: unknown) => void;
}

export class FishAudioWebSocket {
  // …state…
  constructor(options: WebSocketWrapperOptions) {...}
  connect(): Promise<void> {
    // new WebSocket(url, { headers: options.headers })
    // undici's WebSocket accepts { headers } per undici 6+ docs
    // MUST set ws.binaryType = 'arraybuffer' immediately after construction — some
    // undici versions default to 'blob'; binary msgpack frames would arrive as Blob
    // and our handler's ArrayBuffer path would break silently
  }
  sendMsgpack(obj: unknown): void { this.sendBinary(encode(obj)); }
  sendBinary(data: ArrayBuffer | ArrayBufferView | Uint8Array): void {...}
  close(code?: number, reason?: string): void {...}
  isOpen(): boolean {...}
  getState(): ConnectionState {...}
}
```

**Why undici explicitly:** Node 22's global `WebSocket` is from undici, but passing `{ headers }` as 2nd arg is non-spec-compliant and may or may not work depending on Node/undici version. Importing directly from `undici` gives stable behavior. undici is already bundled with Node 22+ — no `npm install` needed (but we list it as a peer-ish dep to be explicit).

### 2.4 `src/tts/types.ts`

```ts
import type { Logger } from '../common/types.js';

export type FishAudioFormat = 'pcm' | 'mp3' | 'wav' | 'opus';
export type FishAudioModel = 's1' | 's2-pro';
export type FishAudioLatency = 'balanced' | 'normal';  // 'low' removed — SDK Literal rejects it, unverified by AsyncAPI

export interface TTSClientOptions {
  apiKey: string;
  referenceId?: string;
  model?: FishAudioModel;               // default 's1'
  baseUrl?: string;                     // default 'wss://api.fish.audio/v1/tts/live' (no query string)
  format?: FishAudioFormat;             // default 'pcm'
  sampleRate?: number;                  // default 44100
  latency?: FishAudioLatency;           // default 'balanced'
  chunkLength?: number;                 // default 100 (SDK sends 200; smaller = faster TTFB)
  temperature?: number;                 // default 0.7
  topP?: number;                        // default 0.7
  normalize?: boolean;                  // default true
  conditionOnPreviousChunks?: boolean;  // default true — prevents chunk-boundary seams
  connectTimeoutMs?: number;            // default 10000
  logger?: Logger;
}

export interface StreamOptions {
  signal?: AbortSignal;
  referenceId?: string;                 // per-request override (reconnects if differs)
}

export interface AudioChunk {
  data: ArrayBuffer;
  sequence: number;       // derived; kept for parity with sibling deepgram AudioChunk shape
  sizeBytes: number;      // derived (= data.byteLength); kept for test-script ergonomics
  timestamp: number;      // Date.now() when received
}
```

**Removed from v3 (YAGNI):** `minChunkLength`, `maxNewTokens`, `repetitionPenalty`, `earlyStopThreshold`, `mp3Bitrate`, `opusBitrate`, `prosody`, `pingTimeoutMs`, `maxMessageSizeBytes`, `StreamOptions.flushBetweenChunks`. See §1 for per-option rationale.

### 2.5 `src/tts/client.ts` — the interesting one

**Class:** `FishAudioTTS`

**Public API:**
- `constructor(options)` — validate apiKey, snapshot defaults
- `connect(): Promise<void>` — open socket + send StartEvent. Idempotent if already open with same referenceId (other options are snapshotted from constructor and cannot change per-request in v1)
- `stream(textIter: AsyncIterable<string>, opts?: StreamOptions): AsyncGenerator<AudioChunk>` — main API
- `speak(text: string, opts?: StreamOptions): AsyncGenerator<AudioChunk>` — wraps `stream` with a single-item async iterator (see helper below)
- `close(): Promise<void>` — graceful teardown; see §close()
- `getState(): ConnectionState`
- `isOpen(): boolean`

**Small helper (defined in `src/tts/client.ts`, not exported):**
```ts
async function* singleton<T>(x: T): AsyncGenerator<T> { yield x; }
// speak(text, opts) => this.stream(singleton(text), opts)
```

**Internal state:**
```ts
type QueueItem =
  | { kind: 'chunk'; chunk: AudioChunk }
  | { kind: 'finished' }
  | { kind: 'error'; error: unknown };

type PendingPull = { resolve: (item: QueueItem) => void };

private socket: FishAudioWebSocket | null = null;
private queue: QueueItem[] = [];
private pendingPull: PendingPull | null = null;
private chunkSequence = 0;

// Serialization lock — replaces the `streamActive` boolean. Holds the in-flight
// stream's completion promise; concurrent stream() calls reject immediately.
private activeStream: Promise<void> | null = null;

private textPumpAbort: AbortController | null = null;
private textPumpPromise: Promise<void> | null = null;
private textIterInUse: AsyncIterator<string> | null = null;  // kept so abort can call .return()
```

**`stream()` body (v4 — four concurrency fixes applied):**
```ts
async *stream(textIter, opts = {}) {
  if (this.activeStream) {
    throw new FishAudioProtocolError('stream() is already active');
  }
  const userSignal = opts.signal;
  if (userSignal?.aborted) throw new FishAudioAbortError('signal aborted before stream()');

  // Publish our in-flight promise synchronously so concurrent callers see the lock.
  let streamDone!: () => void;
  this.activeStream = new Promise<void>(res => { streamDone = res; });

  this.queue = [];
  this.chunkSequence = 0;
  this.textPumpAbort = new AbortController();
  this.textIterInUse = null;

  // Race the user's abort against connect() so an abort-during-connect
  // does not get orphaned in the queue (Blocker B4).
  const connectAbort = new AbortController();
  const onAbortDuringConnect = () => connectAbort.abort(
    new FishAudioAbortError('stream aborted before start'),
  );
  userSignal?.addEventListener('abort', onAbortDuringConnect, { once: true });

  // Post-connect abort handler — pushes into queue (consumer is pulling by now)
  // and force-closes the user's text iterator so the pump can exit (Blocker B5).
  const onUserAbort = () => {
    this.textPumpAbort?.abort();
    // Force the for-await in the pump to terminate, even if the user's iterator
    // doesn't honor AbortSignal — AsyncIterator.return() is the documented escape.
    this.textIterInUse?.return?.(undefined).catch(() => {});
    try {
      if (this.socket?.isOpen()) this.socket.sendMsgpack({ event: 'stop' });
    } catch (e) {
      this.logger.debug('[fish] stop send on abort failed (socket may already be closed)', e);
    }
    this.push({ kind: 'error', error: new FishAudioAbortError('stream aborted') });
  };

  try {
    try {
      await Promise.race([
        this.connect(opts.referenceId),
        new Promise<never>((_, reject) => {
          connectAbort.signal.addEventListener(
            'abort',
            () => reject(connectAbort.signal.reason),
            { once: true },
          );
        }),
      ]);
    } finally {
      userSignal?.removeEventListener('abort', onAbortDuringConnect);
    }

    if (!this.socket?.isOpen()) throw new FishAudioConnectionError('socket not open after connect');

    // Swap in the drain-loop abort handler now that a consumer will actually pull.
    userSignal?.addEventListener('abort', onUserAbort, { once: true });

    // Spawn text pump — capture iterator explicitly so abort can .return() it.
    const pumpSignal = this.textPumpAbort.signal;
    const iter = textIter[Symbol.asyncIterator]();
    this.textIterInUse = iter;

    this.textPumpPromise = (async () => {
      try {
        while (true) {
          if (pumpSignal.aborted) return;
          const { value, done } = await iter.next();
          if (done) break;
          if (pumpSignal.aborted) return;  // re-check after await
          if (!this.socket?.isOpen()) return;
          this.socket.sendMsgpack({ event: 'text', text: value });
        }
        // Text exhausted normally — tell server we're done.
        if (!pumpSignal.aborted && this.socket?.isOpen()) {
          this.socket.sendMsgpack({ event: 'stop' });
        }
      } catch (err) {
        // Only surface if stream is still live; abort path handles its own error.
        if (!pumpSignal.aborted) {
          this.push({
            kind: 'error',
            error: new FishAudioProtocolError('text iterator error', err),
          });
        }
      }
    })();

    // Drain audio queue until finished or errored.
    while (true) {
      const item = await this.pull();
      if (item.kind === 'error') throw item.error;
      if (item.kind === 'finished') return;
      yield item.chunk;
    }
  } finally {
    // Always: cancel pump, force-close user iterator, await pump, drain state.
    this.textPumpAbort?.abort();
    this.textIterInUse?.return?.(undefined).catch(() => {});
    if (this.textPumpPromise) {
      try { await this.textPumpPromise; } catch {}
    }
    userSignal?.removeEventListener('abort', onUserAbort);
    this.queue = [];
    this.pendingPull = null;
    this.textPumpAbort = null;
    this.textPumpPromise = null;
    this.textIterInUse = null;
    streamDone();
    this.activeStream = null;
  }
}
```

**Why these specific changes vs v3:**
- **B4 (abort-before-connect):** `connectAbort` races the user's signal against `connect()`. The abort listener during connect is distinct from the drain-loop listener, so pushing into an empty queue is impossible.
- **B5 (pump stuck on user iterator):** We manually drive the iterator with `iter.next()` and call `iter.return()` on abort. `for await...of` alone cannot be cancelled if the source ignores signals.
- **Race #1 (consumer break):** `finally` runs on `.return()`; force-closing `textIterInUse` unblocks the pump even if the caller broke out mid-stream.
- **Race #4 (back-to-back streams):** `activeStream` is a promise, not a boolean. The next `stream()` waits/fails against the settled promise — no race window.

**Binary message handler (with runtime guard + default case):**
```ts
private handleBinaryMessage(buf: ArrayBuffer) {
  if (!this.activeStream) {
    this.logger.debug(`[fish] ${buf.byteLength} bytes with no active stream — ignoring`);
    return;
  }
  const parsed = decodeEvent(buf);  // returns null if not a valid event object
  if (!parsed) {
    this.logger.warn('[fish] non-msgpack or malformed binary frame');
    return;
  }

  switch (parsed.event) {
    case 'audio': {
      const audioField = parsed.audio;
      if (!(audioField instanceof Uint8Array)) {
        this.logger.warn('[fish] audio field is not Uint8Array', typeof audioField);
        return;
      }
      // Copy into an owned ArrayBuffer — msgpack may reuse its backing buffer on next frame
      const ab = audioField.buffer.slice(
        audioField.byteOffset,
        audioField.byteOffset + audioField.byteLength,
      );
      this.push({
        kind: 'chunk',
        chunk: { data: ab, sequence: this.chunkSequence++, sizeBytes: ab.byteLength, timestamp: Date.now() },
      });
      return;
    }
    case 'finish': {
      this.finishSeen = true;  // sentinel for handleClose
      if (parsed.reason === 'error') {
        this.push({ kind: 'error', error: new FishAudioProtocolError('server finish reason=error') });
      } else {
        this.push({ kind: 'finished' });
      }
      return;
    }
    default:
      // Includes 'log' and any future server events — forward-compat per spec
      this.logger.debug('[fish] ignoring unknown event', parsed.event);
      return;
  }
}
```

**Close handler (fixes v3's broken FIFO assumption):**
```ts
private finishSeen = false;  // set when a 'finish' event was dispatched

private handleClose(code: number, reason: string) {
  if (!this.activeStream) return;
  // undici does NOT guarantee that the last 'message' event is delivered before
  // 'close' when the server flushes a msgpack 'finish' immediately before TCP FIN.
  // If finish has been seen, the stream ended gracefully. If not, it's an error.
  if (this.finishSeen) {
    // Already pushed 'finished' / protocol error; consumer will drain.
    return;
  }
  this.push({
    kind: 'error',
    error: new FishAudioConnectionError(`socket closed before finish: ${code} ${reason}`),
  });
}
```

Reset `finishSeen = false` at the top of `stream()` alongside the other per-stream state.

**`connect()` with config-change reconnect:**
- If socket is open and `referenceId` matches current → no-op
- If open but different → `close()` then reconnect
- On new connect: build URL (no query), headers `{Authorization, model}`, construct `FishAudioWebSocket`, call `.connect()`, then `sendMsgpack(buildStartEvent())`

**`close()` spec (v4 — was one line in v3):**
```ts
async close(): Promise<void> {
  // Called during an active stream: unblock the pull loop so the generator can
  // settle before we tear down the socket. Without this, pull() hangs forever.
  if (this.activeStream) {
    this.push({ kind: 'error', error: new FishAudioAbortError('client closed during stream') });
    try { await this.activeStream; } catch {}
  }

  const sock = this.socket;
  if (!sock) return;
  this.socket = null;

  if (sock.isOpen()) {
    try { sock.sendMsgpack({ event: 'stop' }); } catch { /* already dead */ }
    // Best-effort: wait up to 2s for the server's finish + close; don't block longer.
    await Promise.race([
      new Promise<void>(res => sock.onClose = () => res()),
      new Promise<void>(res => setTimeout(res, 2000)),
    ]);
  }
  try { sock.close(1000, 'client close'); } catch { /* idempotent */ }
}
```

**Guarantees:**
- Safe to call on a dead socket (no throw)
- Safe to call during an active stream (unblocks pull loop via queue push, then awaits generator settle)
- Bounded — never blocks more than ~2s waiting on the server

### 2.6 `scripts/e2e-test.mjs`

Fresh WAV helper for 44100 Hz (do **not** reuse deepgram's — it hardcodes 16000):

```js
// Writes a canonical PCM16LE WAV with given sample rate and channel count.
// 44-byte RIFF header + raw data.
function writeWav(pcmBuffer, path, sampleRate, bitsPerSample = 16, channels = 1) {
  const dataSize = pcmBuffer.byteLength;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);              // PCM integer
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmBuffer).copy(buf, 44);
  writeFileSync(path, buf);
}
```

**Bit-depth verification (catches Agent 2's root-cause concern):**

After receiving all chunks, before writing the WAV, compute `actualBytesPerSec = totalBytes / measuredDurationSec` and compare to `expectedBytesPerSec = sampleRate * channels * bitsPerSample / 8`. For 44100 Hz mono:
- int16 (16-bit): 88200 bytes/sec
- float32 (32-bit): 176400 bytes/sec

If ratio is ~2× expected, server is sending float32 — **the script should fail loudly** with instructions to either request a different format or update the WAV header.

We know the expected duration approximately from the text length (human speech ~ 3 words/sec; script uses a ~15-word phrase → ~5 sec → expected ~441000 bytes for int16). Sanity-check: `actualBytes` should be within ±30% of expected for int16.

**Tests:**
1. `speak("Привет, это тест Fish Audio стримингового синтеза.")` → `/tmp/fish-tts-static.wav` + TTFB + total-duration report + bit-depth verification
2. `stream(wordByWordGenerator())` with 50ms delays between words → `/tmp/fish-tts-stream.wav` + TTFB measured from *first text send* not from connect
3. Sanity asserts: every chunk.sizeBytes even, sequence monotonic, total buffer > 0

**Optional (Agent 2's regression test):** compute DC jump at each chunk boundary (last sample of chunk[i] vs first sample of chunk[i+1]) — log max jump; should be well under 5000 LSB for contiguous speech. Flag if > 10000 (indicates conditioning broken or chunks non-contiguous).

---

## 3. Build & run sequence

```bash
cd /Users/terobyte/Desktop/Projects/Active/tts/fishaudio
npm install
npm run typecheck
npm run build
node scripts/e2e-test.mjs
afplay /tmp/fish-tts-static.wav
afplay /tmp/fish-tts-stream.wav
```

**Success criteria:**
1. Both WAVs are audible, correct speech, zero clicks/pops at chunk boundaries (ear test)
2. Background noise absent (not a distorted-bit-depth artifact)
3. TTFB < 500 ms on typical connection
4. `typecheck` passes with `strict: true` + `noUncheckedIndexedAccess`
5. Bit-depth verification confirms int16 assumption
6. Max DC jump at chunk boundaries < 10000 LSB

---

## 4. Risks & open questions (updated)

### 4.1 ~~Undici `WebSocket` with `headers` option~~ resolved
Use `import { WebSocket } from 'undici'`. Undici 6+ supports `new WebSocket(url, { headers })`. Documented in undici README.

### 4.2 Msgpack `audio` field type
Docs and Python SDK confirm it's a `Uint8Array` (msgpack bin type). Handler has an `instanceof Uint8Array` guard as defense.

### 4.3 PCM bit depth
Fish docs don't explicitly say int16. E2E test verifies empirically via bytes/sec ratio. If we discover it's float32, add `float32` support to the WAV writer (audioFormat=3, bitsPerSample=32).

### 4.4 Lifetime: 1 socket = 1 stream
First stream opens + sends StartEvent; close on teardown or before different `referenceId`.

### 4.5 Slow text iterator
Fish will wait for text with `latency: balanced`. Consumer abandoning the generator early, or the text iterator ignoring abort, is handled by the `finally` block force-closing the iterator via `.return()` and then awaiting the pump.

### 4.6 Keepalive / ping frames — NOT a blocker for undici clients
The Python SDK uses `httpx_ws`, which sends **client-initiated** pings every 20 sec and disconnects when the pong doesn't arrive in time (SDK issue #47). Undici's `WebSocket` client does **not** send periodic pings at all — it only responds to server pings. Conclusion: we do not need a `pingTimeoutMs` option or an application-level 15-sec-flush keepalive. Both were speculative mitigations for a Python-specific symptom.
- **Still unverified:** whether the Fish *server* itself idle-disconnects. E2E test adds one case with a 25+ sec pause between text chunks to catch this empirically.
- **If a real disconnect occurs:** revisit by adding `setInterval`-based flush or a no-op text event at ~15s cadence. Do not add the knob speculatively.

### 4.7 Invalid StartEvent config — server-close ordering
Fish responds with `{event: 'finish', reason: 'error'}` and closes. Undici does **not** guarantee that the trailing `message` event is delivered before `close` when the server flushes a frame immediately before FIN. v4 `handleClose` inspects a `finishSeen` flag and only pushes `FishAudioConnectionError` when no finish was observed, so the consumer always sees the precise error.

### 4.8 Concurrent audio arrival after abort
If user aborts, we send `stop` but Fish may still have in-flight audio bytes. Those arrive, handler sees `activeStream === null` (post-`finally`) or `finishSeen` was set, and ignores them. Harmless.

### 4.9 Server-side voice-switch bug (Fish SDK issue #54)
With certain `reference_id` values, Fish server randomly switches to default voice mid-stream. This is a Fish infrastructure bug, not ours. Symptom is a sudden tonal shift (NOT a click) — different failure mode than artifacts we're targeting. If observed with JLM4.7, file a Fish support ticket; our code can't fix it.

---

## 5. What we're deliberately NOT doing (YAGNI)

- Browser support (needs proxy for Bearer header)
- mp3/opus/wav output (PCM eliminates artifact class; add later only if needed)
- Multi-stream-per-socket pooling
- Auto-reconnect on transient failures
- Voice discovery API
- `s2-pro` multi-speaker support

---

## 6. Port-forward notes (expanded)

### Python
- Use `websockets.connect(uri, extra_headers={"Authorization": ..., "model": ...})`
- msgpack: `ormsgpack` (Python SDK uses this) or `msgpack` with `use_bin_type=True` on packer, `raw=False` on unpacker. **Without these flags the audio bytes corrupt silently.**
- `AbortSignal` → `asyncio.Event`-based `CancelToken` or raw `asyncio.CancelledError`
- `AsyncGenerator` → `async def` + `yield`. `finally` cleanup works identically
- Error `kind` tag ports as attribute on each exception class

### Swift
- `URLSessionWebSocketTask` with `URLRequest.setValue("Bearer …", forHTTPHeaderField: "Authorization")` and `setValue("s1", forHTTPHeaderField: "model")`
- `MessagePack.swift` handles `Data` natively, no flag gymnastics
- Use `AsyncThrowingStream<AudioChunk, Error>` with its `.continuation` — maps 1:1 onto the queue-backed model in §2.5. `defer` is structurally equivalent to `finally` for the stream-teardown block; no hand-rolled state machine needed
- Cancellation via `Task.checkCancellation()` at the pull boundary + a continuation termination callback for abort
- The `kind` discriminator maps naturally to a `FishAudioError` enum with associated values

### React Native
- Use RN global `WebSocket` with the RN-specific 3rd-arg headers extension: `new WebSocket(url, null, { headers: {...} })` (works on iOS, usually on Android)
- `@msgpack/msgpack` works in RN unchanged
- `AbortSignal` is a JS API, works in RN
- Only `src/common/websocket.ts` needs replacing (swap undici import for global WebSocket); everything else in `src/tts/client.ts` reused verbatim

### Port-fidelity discipline

- **`src/common/websocket.ts` is the only file with Node/undici-specific imports.** But `src/tts/client.ts` still uses platform-provided primitives that each port must map: `AbortController`/`AbortSignal` (Python → `asyncio.Event` + task-cancel; Swift → `Task` cancellation), `Date.now()` (Python → `time.time() * 1000`; Swift → `Date().timeIntervalSince1970 * 1000`), `ArrayBuffer.slice()` (Python → `bytes[s:e]`, already a copy; Swift → `Data(...)`), and `AsyncGenerator` (Python → `async def`+`yield`; Swift → `AsyncThrowingStream`). The TS source reads identically across platforms; the mappings live in a one-page port glossary, not in ifdef-style branching.
- **Error classes are parallel structures across ports.** Add a `kind: FishAudioErrorKind` field on every error (TS has it; Python port adds it; Swift port encodes it as the enum case).
- **The `CancelToken` abstraction is deferred** (not in v1 TS) — currently we use `AbortSignal` directly. Introduce it during the Python port if and when needed.
- **Python port: listener cleanup.** The TS code calls `removeEventListener('abort', ...)` in `finally`; the Python port must either `cancel()` its wait-for-abort task or discard the `asyncio.Event` — otherwise per-stream tasks leak.

---

## 7. Review-findings diff (v1 → v2)

| # | Finding (source agent) | Applied fix |
|---|---|---|
| 1 | `model` must be header, not query (Agent 1) | §0 endpoint URL drops query; §2.3 wrapper takes `headers` map with both `Authorization` + `model` |
| 2 | Bit depth unverified, could be float32 (Agent 2) | §2.6 e2e test adds empirical bit-depth check; §4.3 flags risk |
| 3 | `moduleResolution: "Bundler"` breaks node .mjs imports (Agent 3) | `tsconfig.json` changed to `NodeNext`/`NodeNext`; source imports use `.js` extensions |
| 4 | Text-pump leaks on early break (Agent 3) | §2.5 stream() body: `textPumpAbort` actually wired; pump promise awaited in `finally`; pump checks signal before each send |
| 5 | `condition_on_previous_chunks` implicit (Agent 2) | §1 defaults: explicitly `true`; §2.4 exposes as option |
| 6 | Top-level `speed` doesn't exist in Fish schema (Agent 1) | §2.4 removes top-level `speed`, keeps only `prosody.speed` |
| 7 | Missing optional tuning params (Agent 1) | §2.4 adds `minChunkLength`, `conditionOnPreviousChunks`, `maxNewTokens`, `repetitionPenalty`, `earlyStopThreshold` |
| 8 | Deepgram WAV helper has wrong sample rate (Agent 2) | §2.6 writes fresh `writeWav(buf, path, sampleRate, bitsPerSample, channels)` |
| 9 | Unsafe `as` cast on msgpack decode (Agent 3) | §2.2 `decodeEvent` helper does runtime guard; §2.5 handler calls it |
| 10 | Missing `default` in switch (Agent 3) | §2.5 adds `default: logger.debug('unknown', event)` |
| 11 | Abort's `sendMsgpack` can throw on closed socket (Agent 3) | §2.5 wraps in try/catch + `isOpen()` check |
| 12 | QueueItem `'finished'` type not defined (Agent 3) | §2.5 internal state shows full `QueueItem` union |
| 13 | Error `kind` discriminator for Swift port (Agent 4) | §2.1 adds `kind: FishAudioErrorKind` on every error class |
| 14 | Python msgpack flags footgun (Agent 4) | §2.2 documents `use_bin_type=True` / `raw=False` for port; §6 re-emphasizes |
| 15 | RN WebSocket headers syntax is different (Agent 4) | §6 documents `new WebSocket(url, null, {headers})` for RN port |
| 16 | Optional regression test for DC jump (Agent 2) | §2.6 includes chunk-boundary DC jump logging |

### v3 diff (deep-audit pass)

| # | Finding (exhaustive audit) | Applied fix |
|---|---|---|
| 17 | `latency` spec has undocumented `'low'` value (deep-audit) | §2.4 FishAudioLatency union extended to include `'low'` |
| 18 | `keepalive_ping_timeout_seconds` default 20s kills long streams (SDK issue #47) | §2.4 adds `pingTimeoutMs` option (default 60000); §4.6 upgrades to ACTION REQUIRED; e2e test adds 25+ sec idle gap case |
| 19 | Python SDK caps WS messages at 65536 — undici behavior needs verification | §2.4 adds `maxMessageSizeBytes` option; §4.9 new risk item; e2e test logs chunk sizes |
| 20 | AsyncAPI says `sample_rate: null` → server infers 44100 (32000 claim unverified) | §1 defaults table corrected — removed `32000 or` |
| 21 | `prosody.normalize_loudness` exists in AsyncAPI but SDK type omits it | §2.4 `prosody` shape adds `normalizeLoudness?: boolean` |
| 22 | `reference_id` voice-switch mid-stream (SDK issue #54) | §4.10 new risk item — server-side, different failure mode from artifacts |
| 23 | SDK default chunk_length = 200, wire default = 300, our choice = 100 | §2.4 comment clarifies all three values |
| 24 | CONFIRMED: SDK does pure `b"".join()` passthrough of audio bytes (iterators.py) — NO post-processing | changelog note: validates our raw-forward design |
| 25 | CONFIRMED: no prewarming / init handshake needed before first TextEvent | no change; validates §2.5 sequence |

### v4 diff (two Opus audits — protocol/docs + TS concurrency/port)

| # | Finding (source) | Applied fix |
|---|---|---|
| 26 | Issue #47 is a Python-only httpx_ws client-ping bug; undici does not send periodic client pings (protocol audit) | §1, §2.4, §4.6 — dropped `pingTimeoutMs` option and the 15-sec-flush mitigation; kept only a 25-sec idle e2e test |
| 27 | undici `WebSocket` has no default max payload cap (not 1 MiB+ as plan claimed); Python SDK's 64 KiB cap is httpx_ws-specific (protocol audit) | §1, §2.4, §4.9 — removed `maxMessageSizeBytes` option entirely |
| 28 | `latency: 'low'` unverified — SDK Literal rejects it; no AsyncAPI cite (protocol audit) | §1, §2.4 — removed from `FishAudioLatency`; revisit only if empirically confirmed |
| 29 | `chunk_length` v3 comment wrong: SDK always sends explicit 200, wire default 300 only applies when field is omitted (protocol audit) | §1 defaults table comment corrected |
| 30 | `prosody.normalizeLoudness` is S2-Pro only and rejected by SDK `Prosody` type (protocol audit) | §2.4 — dropped entire `prosody` option for v1 (YAGNI) |
| 31 | `log` event unverified — no SDK handler, not in docs; "folklore" (protocol audit) | §0 — removed from server-event table; §2.5 — removed `case 'log'`, falls into forward-compat default |
| 32 | Abort-before-connect race: `onUserAbort` pushed error into queue before any consumer was pulling (concurrency audit) | §2.5 — split into two handlers; connect phase races via separate `connectAbort` + `Promise.race` |
| 33 | Pump blocked on user text iterator that ignores abort → `finally` hangs forever (concurrency audit) | §2.5 — manual `iter.next()` loop + `iter.return()` on abort, both in the abort handler and the `finally` block |
| 34 | `close()` was one line of spec, hangs if called during dead-socket active stream (concurrency audit) | §2.5 — full `close()` spec with synthetic queue-push, bounded 2-sec finish wait, idempotent |
| 35 | `speak()` referenced undefined `asyncIter([text])` helper (concurrency audit) | §2.5 — defined `singleton<T>()` helper inline |
| 36 | §4.7 FIFO claim false: undici does not guarantee `message` before `close` when server flushes finish+FIN back-to-back (concurrency audit) | §2.5 `handleClose` now checks `finishSeen` sentinel; §4.7 rewritten |
| 37 | `streamActive` boolean had a race window across back-to-back `stream()` calls (concurrency audit) | §2.5 — replaced with `activeStream: Promise<void>` lock that publishes synchronously and settles in `finally` |
| 38 | `Logger` interface: `debug, info, warn, error: (...) => void` only typed `error` (concurrency audit) | §2.1 — each method typed individually |
| 39 | `FishAudioEngineError` shadowed native ES2022 `Error.cause` with a custom field (concurrency audit) | §2.1 — pass cause via `super(msg, { cause })` |
| 40 | `binaryType = 'arraybuffer'` was a comment, not a spec requirement; some undici versions default to `'blob'` (concurrency audit) | §2.3 — elevated to MUST-set with reason |
| 41 | §4 numbering out of order (`4.1..4.6, 4.9, 4.10, 4.7, 4.8`) (concurrency audit) | §4 — renumbered 4.1..4.9 in reading order |
| 42 | Swift port claim "state-machine iterator (no finally)" misleading — `AsyncThrowingStream` + `defer` maps cleanly (concurrency audit) | §6 Swift bullet rewritten below |
| 43 | "Only `src/common/websocket.ts` is platform-specific" overstated — `AbortSignal`, `Date.now`, `ArrayBuffer.slice` all need mapping (concurrency audit) | §6 port-fidelity bullet clarified |
| 44 | YAGNI bloat in `TTSClientOptions`: `minChunkLength`, `maxNewTokens`, `repetitionPenalty`, `earlyStopThreshold`, `mp3Bitrate`, `opusBitrate`, `prosody`, `flushBetweenChunks` — none used by v1 PCM path (both audits) | §2.4 — options shape cut roughly in half; §1 lists each removed option with rationale |
