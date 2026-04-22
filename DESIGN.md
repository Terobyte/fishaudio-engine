# Fish Audio WebSocket TTS Engine — Design

**Date:** 2026-04-21
**Status:** approved (auto-mode brainstorming)
**Reference:** sibling `tts/deepgram/` package

## Goal

Build the fastest artifact-free WebSocket streaming TTS engine for Fish Audio, usable from Node 22+ / Bun / Deno as a TypeScript reference that can be ported 1:1 to Python, Swift, and React Native.

## Non-goals

- Browser support in first cut (browser `WebSocket` cannot set `Authorization` header; would need proxy — future work)
- MP3/Opus output in first cut (codec-framed formats are the historical source of artifacts; we start with PCM and only add them if needed)
- Deepgram API parity — we use whatever shape fits Fish best

## Protocol (from docs)

- **Endpoint:** `wss://api.fish.audio/v1/tts/live?model=s1`
- **Headers:** `Authorization: Bearer <key>`
- **Wire format:** MessagePack for **both** directions (not JSON!)
- **Client → Server events:**
  - `{event: "start", request: {format, sample_rate, reference_id, latency, chunk_length, temperature, top_p, ...}}` — once, first
  - `{event: "text", text: "..."}` — N times
  - `{event: "flush"}` — optional, forces generation of buffered text
  - `{event: "stop"}` — ends session (server sends remaining audio + finish)
- **Server → Client events:**
  - `{event: "audio", audio: <bytes>}` — audio chunks in chosen format
  - `{event: "finish", reason: "stop" | "error"}` — session complete, socket will close
  - `{event: "log", ...}` — informational

## Critical design decision: PCM format

The previous attempts produced artifacts (clicks, noise) because of **codec-frame boundaries**:
- MP3/Opus: each chunk is a partial codec frame; naive concat + decode = clicks
- WAV: RIFF header only in first chunk; per-chunk decode = noise

**PCM16LE at 44.1kHz** has no framing — every 2 bytes is a valid sample. Chunks concatenate cleanly. ~1.4 Mbps is trivial on modern networks.

Fish Audio config:
- `format: "pcm"`
- `sample_rate: 44100`
- `latency: "balanced"` (faster TTFB than `normal`)
- `chunk_length: 100` (minimum = fastest first chunk)

## Architecture

```
fishaudio/
  package.json                 @fishaudio-engine/core
  tsconfig.json
  .env                         FISH_API_KEY=…
  src/
    index.ts                   re-exports
    common/
      types.ts                 errors, Logger, ConnectionState
      websocket.ts             WebSocket wrapper with msgpack send/recv
      msgpack.ts               thin wrapper over @msgpack/msgpack
      index.ts
    tts/
      types.ts                 options, events, AudioChunk
      client.ts                FishAudioTTS main class
      index.ts
  scripts/
    e2e-test.mjs               sanity: stream text → PCM → write .wav → report TTFB
```

## API

```ts
import { FishAudioTTS } from '@fishaudio-engine/core/tts';

const tts = new FishAudioTTS({
  apiKey: process.env.FISH_API_KEY!,
  referenceId: '92a2600282e547f098b4a8de1bc9a44a',  // JLM4.7
  model: 's1',
  format: 'pcm',
  sampleRate: 44100,
  latency: 'balanced',
});

// Static text
for await (const chunk of tts.speak('Hello, world!')) {
  // chunk.data: ArrayBuffer of PCM16LE samples
}

// Streaming text from LLM
async function* llmTokens() { /* yield tokens */ }
for await (const chunk of tts.stream(llmTokens())) {
  // audio arrives in parallel with LLM generation
}

await tts.close();
```

### Types

```ts
interface AudioChunk {
  data: ArrayBuffer;   // raw bytes in the configured format
  sequence: number;    // 0, 1, 2, …
  sizeBytes: number;
  timestamp: number;   // Date.now() when received
}

interface TTSClientOptions {
  apiKey: string;
  referenceId?: string;
  model?: 's1' | 's2-pro';
  format?: 'pcm' | 'mp3' | 'wav' | 'opus';
  sampleRate?: number;
  latency?: 'balanced' | 'normal';
  chunkLength?: number;   // 100-300
  temperature?: number;
  topP?: number;
  speed?: number;
  connectTimeoutMs?: number;
  logger?: Logger;
}

interface StreamOptions {
  signal?: AbortSignal;
}
```

## Data flow (streaming case)

```
caller                     FishAudioTTS                  WebSocket              Fish Audio
  │                             │                            │                       │
  │  tts.stream(textIter)       │                            │                       │
  ├────────────────────────────▶│ connect() if needed        │                       │
  │                             ├───────────────────────────▶│ HTTP upgrade          │
  │                             │                            ├──────────────────────▶│
  │                             │                            │◀─────────────────────┤ open
  │                             │◀───────────────────────────┤                       │
  │                             │ send msgpack(StartEvent)   │                       │
  │                             ├───────────────────────────▶│ binary frame ─────────▶│
  │                             │                            │                       │
  │                             │ spawn bg task:             │                       │
  │                             │   for-await textIter       │                       │
  │                             │   send TextEvent(each)     │                       │
  │                             │                            │                       │
  │                             │                            │◀──── msgpack(audio) ──┤
  │                             │ decode, push AudioChunk    │                       │
  │◀────────────────────────────┤ yield chunk                │                       │
  │                             │                            │                       │
  │  (iteration continues;      │                            │                       │
  │   textIter exhausts         │                            │                       │
  │   → send StopEvent)         │                            │                       │
  │                             ├───────────────────────────▶│ msgpack(stop) ────────▶│
  │                             │                            │                       │
  │                             │                            │◀── msgpack(audio) ×N ─┤
  │◀────────────────────────────┤ yield remaining chunks     │                       │
  │                             │                            │◀── msgpack(finish) ───┤
  │                             │ return from generator      │                       │
  │◀────────────────────────────┤                            │                       │
```

## Error handling

| Condition                             | Thrown error                  |
|---------------------------------------|-------------------------------|
| missing apiKey                        | `FishAudioAuthError`          |
| connect timeout / failure             | `FishAudioConnectionError`    |
| socket close during active stream     | `FishAudioConnectionError`    |
| `finish` with `reason: "error"`       | `FishAudioProtocolError`      |
| `AbortSignal.abort()` during stream   | `FishAudioAbortError` (+ send `stop`) |
| concurrent `stream()` / `speak()`     | `FishAudioProtocolError`      |
| non-msgpack binary / unknown event    | warn log, ignore              |

## Artifact prevention checklist

1. ✅ Format = PCM (no codec frames)
2. ✅ Forward raw `ArrayBuffer` received from server; never mutate, slice, or re-buffer
3. ✅ Consumer owns playback buffering — engine is a dumb pipe
4. ✅ Single ordered audio queue (never parallel consumers on same stream)
5. ✅ Defensive: if `chunk.byteLength % 2 !== 0` when `format === 'pcm'`, log warning (shouldn't happen; indicates server bug)
6. ✅ Test script saves full PCM to WAV with **one** 44-byte RIFF header on the concatenated buffer (not per-chunk)

## Testing

`scripts/e2e-test.mjs`:
- Use JLM4.7 voice + Russian sentence
- Measure: time-to-first-chunk, total time, audio duration
- Save as `/tmp/fish-tts-test.wav` for manual listening check
- Also test the `stream(asyncIterable)` path with a simulated LLM token generator (yields word-by-word with 50ms delays)
- Verify: no clicks at chunk boundaries (ear test), PCM byte count divisible by 2, every AudioChunk has sequence > predecessor

## Dependencies

Runtime: `@msgpack/msgpack` (only)
Dev: `typescript`, `@types/node`
