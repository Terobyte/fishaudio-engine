import { FishAudioTTS } from '../dist/tts/index.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const API_KEY = process.env.FISH_API_KEY;
if (!API_KEY) {
  console.error('Set FISH_API_KEY (or create .env with FISH_API_KEY=...)');
  process.exit(1);
}

const REFERENCE_ID = '92a2600282e547f098b4a8de1bc9a44a';
const SAMPLE_RATE = 44100;
const CHANNELS = 1;

const STATIC_TEXT = 'Привет, это тест Fish Audio стримингового синтеза.';
const STREAM_WORDS = [
  'Хорошо, ', 'давай ', 'проверим ', 'пословную ', 'подачу ', 'текста ',
  'с ', 'небольшими ', 'паузами, ', 'чтобы ', 'убедиться, ', 'что ',
  'стриминг ', 'работает ', 'плавно.',
];

const log = (...args) =>
  console.log(`[${(Date.now() % 100000).toString().padStart(5, '0')}]`, ...args);

// Canonical PCM16LE WAV writer.
// Fish's pcm format is empirically int16 LE mono at the requested sample_rate;
// docs imply 44100 Hz default, and a smoothness probe on neighboring samples
// confirms int16 (mean abs diff ~700 vs ~huge for float32 misinterpretation).
function writeWav(pcmBuffer, path, sampleRate, channels = 1) {
  const bitsPerSample = 16;
  const dataSize = pcmBuffer.byteLength;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
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

// Smoothness probe: sum of |s[i+1] - s[i]| over the whole stream, as int16
// interpretation. Random bytes give ~22k, speech gives ~hundreds. A very
// large number means the format assumption is wrong (e.g. float32 bits being
// read as int16).
function int16Smoothness(merged) {
  const dv = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
  const samples = Math.floor(merged.byteLength / 2);
  let sum = 0;
  for (let i = 0; i + 1 < samples; i++) {
    sum += Math.abs(dv.getInt16((i + 1) * 2, true) - dv.getInt16(i * 2, true));
  }
  return sum / Math.max(samples - 1, 1);
}

// Max cross-chunk sample discontinuity, in int16 LSB.
function maxDcJump(chunksArr) {
  let maxJump = 0;
  let atBoundary = 0;
  for (let i = 0; i + 1 < chunksArr.length; i++) {
    const a = chunksArr[i];
    const b = chunksArr[i + 1];
    if (a.byteLength < 2 || b.byteLength < 2) continue;
    if (a.byteLength % 2 !== 0) continue;
    const dvA = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const dvB = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const lastA = dvA.getInt16(a.byteLength - 2, true);
    const firstB = dvB.getInt16(0, true);
    const jump = Math.abs(lastA - firstB);
    if (jump > maxJump) {
      maxJump = jump;
      atBoundary = i;
    }
  }
  return { maxJump, atBoundary };
}

async function runStatic() {
  log('=== STATIC speak() ===');
  log('text:', STATIC_TEXT);

  const tts = new FishAudioTTS({
    apiKey: API_KEY,
    referenceId: REFERENCE_ID,
    logger: { debug: () => {}, info: log, warn: log, error: log },
  });

  const start = Date.now();
  const chunks = [];
  let firstChunkAt = 0;

  try {
    for await (const chunk of tts.speak(STATIC_TEXT)) {
      if (firstChunkAt === 0) firstChunkAt = Date.now() - start;
      if (chunk.sizeBytes % 2 !== 0) {
        log(`⚠ odd-byte chunk (${chunk.sizeBytes})`);
      }
      chunks.push(new Uint8Array(chunk.data));
    }

    const total = Date.now() - start;
    const pcmSize = chunks.reduce((n, c) => n + c.byteLength, 0);
    const audioDurationMs = (pcmSize / 2 / SAMPLE_RATE) * 1000;

    log(
      `done: ${chunks.length} chunks, ${pcmSize} bytes, audio duration ${audioDurationMs.toFixed(0)}ms @ ${SAMPLE_RATE}Hz int16 mono`,
    );
    log(`  time-to-first-chunk: ${firstChunkAt}ms, total: ${total}ms`);

    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const smooth = int16Smoothness(merged);
    log(`  int16 neighbor-smoothness: ${smooth.toFixed(0)} (speech ~hundreds, random ~22000)`);
    if (smooth > 5000) {
      log('  ⚠ smoothness too high — format may not be int16 after all');
    }

    const { maxJump, atBoundary } = maxDcJump(chunks);
    log(`  max DC jump at chunk boundary: ${maxJump} LSB (between chunk ${atBoundary} / ${atBoundary + 1})`);
    if (maxJump > 10000) {
      log('  ⚠ DC jump > 10000 — conditioning may be broken');
    }

    if (pcmSize === 0) {
      log('⚠ no audio data received — skipping WAV write');
    } else {
      const wavPath = '/tmp/fish-tts-static.wav';
      writeWav(
        merged.buffer.slice(0, merged.byteLength),
        wavPath,
        SAMPLE_RATE,
        CHANNELS,
      );
      log(`wav written: ${wavPath}`);
    }
  } finally {
    await tts.close();
  }
}

async function* wordByWord(words, delayMs) {
  for (const w of words) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield w;
  }
}

async function runStream() {
  log('');
  log('=== STREAM stream() word-by-word ===');
  log('words:', STREAM_WORDS.length);

  const tts = new FishAudioTTS({
    apiKey: API_KEY,
    referenceId: REFERENCE_ID,
    logger: { debug: () => {}, info: log, warn: log, error: log },
  });

  await Promise.race([
    tts.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('connect timeout')), 15000),
    ),
  ]);
  log('connected');

  let firstTextSentAt = 0;
  const words = STREAM_WORDS;

  async function* instrumentedIter() {
    let i = 0;
    for (const w of words) {
      if (i === 0) {
        firstTextSentAt = Date.now();
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
      i++;
      yield w;
    }
  }

  const start = Date.now();
  const chunks = [];
  let firstChunkAt = 0;
  let lastSeq = -1;

  try {
    for await (const chunk of tts.stream(instrumentedIter())) {
      if (firstChunkAt === 0) firstChunkAt = Date.now() - firstTextSentAt;
      if (chunk.sequence !== lastSeq + 1) {
        log(`⚠ non-monotonic sequence: got ${chunk.sequence}, expected ${lastSeq + 1}`);
      }
      lastSeq = chunk.sequence;
      chunks.push(new Uint8Array(chunk.data));
    }

    const total = Date.now() - start;
    const pcmSize = chunks.reduce((n, c) => n + c.byteLength, 0);
    const audioDurationMs = (pcmSize / 2 / SAMPLE_RATE) * 1000;

    log(
      `done: ${chunks.length} chunks, ${pcmSize} bytes, audio duration ${audioDurationMs.toFixed(0)}ms @ ${SAMPLE_RATE}Hz int16 mono`,
    );
    log(`  time-to-first-chunk (from first text send): ${firstChunkAt}ms, total: ${total}ms`);

    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const smooth = int16Smoothness(merged);
    log(`  int16 neighbor-smoothness: ${smooth.toFixed(0)}`);

    const { maxJump, atBoundary } = maxDcJump(chunks);
    log(`  max DC jump at chunk boundary: ${maxJump} LSB (between chunk ${atBoundary} / ${atBoundary + 1})`);

    if (pcmSize === 0) {
      log('⚠ no audio data received — skipping WAV write');
    } else {
      const wavPath = '/tmp/fish-tts-stream.wav';
      writeWav(
        merged.buffer.slice(0, merged.byteLength),
        wavPath,
        SAMPLE_RATE,
        CHANNELS,
      );
      log(`wav written: ${wavPath}`);
    }
  } finally {
    await tts.close();
  }
}

try {
  await runStatic();
  await runStream();
  log('');
  log('e2e ok — listen with: afplay /tmp/fish-tts-static.wav && afplay /tmp/fish-tts-stream.wav');
} catch (err) {
  console.error('e2e failed:', err);
  process.exit(1);
}
