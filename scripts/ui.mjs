import { FishAudioTTS } from '../dist/tts/index.js';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const API_KEY = process.env.FISH_API_KEY;
if (!API_KEY) {
  console.error('Set FISH_API_KEY (or create .env with FISH_API_KEY=...)');
  process.exit(1);
}

const REFERENCE_ID = '92a2600282e547f098b4a8de1bc9a44a';
const SAMPLE_RATE = 44100;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 5173);
const MAX_TEXT_BYTES = 64_000;

const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Fish TTS</title>
<style>
  :root {
    --bg: #0b0d10;
    --panel: #14181d;
    --border: #242a31;
    --fg: #e6e8eb;
    --muted: #8a929c;
    --accent: #4f8cff;
    --green: #2ecc71;
    --yellow: #f1c40f;
    --red: #e74c3c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif; }
  .wrap { max-width: 720px; margin: 48px auto; padding: 0 24px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 20px; letter-spacing: -0.01em; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  textarea { width: 100%; min-height: 200px; background: #0f1317; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; font-size: 15px; line-height: 1.5; font-family: inherit; resize: vertical; outline: none; }
  textarea:focus { border-color: var(--accent); }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
  button { background: var(--accent); color: white; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 15px; font-weight: 500; cursor: pointer; transition: opacity 0.15s; }
  button.stop { background: #2a2f36; }
  button:hover:not(:disabled) { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 500; background: #1a1f26; border: 1px solid var(--border); color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .badge.green { color: var(--green); border-color: #1e4028; background: #0f1f15; }
  .badge.green .dot { background: var(--green); }
  .badge.yellow { color: var(--yellow); border-color: #4a3c10; background: #1f1b0c; }
  .badge.yellow .dot { background: var(--yellow); }
  .badge.red { color: var(--red); border-color: #4a1e1a; background: #1f100e; }
  .badge.red .dot { background: var(--red); }
  .stats { color: var(--muted); font-size: 12px; }
  .err { margin-top: 12px; color: var(--red); font-size: 13px; white-space: pre-wrap; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Fish Audio — стриминг в уши</h1>
  <div class="panel">
    <textarea id="text" placeholder="Вставь текст..."></textarea>
    <div class="row">
      <button id="go">Озвучить</button>
      <button id="stop" class="stop" disabled>Стоп</button>
      <span id="badge" class="badge"><span class="dot"></span><span id="badge-text">ожидание</span></span>
      <span id="stats" class="stats"></span>
    </div>
    <div class="hint">Индикатор = время от клика до первого звука. Зелёный &lt; 800 мс · жёлтый 800–1500 мс · красный &gt; 1500 мс. ⌘+Enter — запуск.</div>
    <div id="err" class="err"></div>
  </div>
</div>
<script>
  const textEl = document.getElementById('text');
  const goBtn = document.getElementById('go');
  const stopBtn = document.getElementById('stop');
  const badge = document.getElementById('badge');
  const badgeText = document.getElementById('badge-text');
  const statsEl = document.getElementById('stats');
  const errEl = document.getElementById('err');

  let audioCtx = null;
  let scheduledSources = [];
  let abortCtl = null;

  function setBadge(cls, label) {
    badge.className = 'badge' + (cls ? ' ' + cls : '');
    badgeText.textContent = label;
  }

  function classifyTTFB(ms) {
    if (ms < 800) return { cls: 'green', label: ms + ' мс · крутая' };
    if (ms < 1500) return { cls: 'yellow', label: ms + ' мс · норм' };
    return { cls: 'red', label: ms + ' мс · пиздец' };
  }

  function teardown() {
    for (const s of scheduledSources) {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    scheduledSources = [];
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
  }

  async function play() {
    const text = textEl.value.trim();
    errEl.textContent = '';
    statsEl.textContent = '';
    if (!text) { errEl.textContent = 'Пусто.'; return; }

    abortCtl = new AbortController();
    goBtn.disabled = true;
    stopBtn.disabled = false;
    setBadge('', 'подключение...');

    // Bug 43: stash old context/sources, create the new context BEFORE
    // tearing down the old one so old sources aren't cut abruptly.
    const oldCtx = audioCtx;
    const oldSources = scheduledSources;
    scheduledSources = [];
    audioCtx = null;

    let CtxClass;
    try {
      CtxClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new CtxClass({ sampleRate: ${SAMPLE_RATE} });
    } catch {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    await audioCtx.resume().catch(() => {});

    for (const s of oldSources) {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    if (oldCtx) {
      try { oldCtx.close(); } catch {}
    }

    const sampleRate = ${SAMPLE_RATE};
    const prerollSec = 0.08;
    let nextStartTime = 0;
    let totalSamples = 0;

    const t0 = performance.now();
    let firstByteAt = 0;
    let firstAudioAt = 0;
    let leftover = new Uint8Array(0);

    try {
      const res = await fetch('/tts', {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
        signal: abortCtl.signal,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(res.status + ': ' + msg);
      }

      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        if (firstByteAt === 0) {
          firstByteAt = Math.round(performance.now() - t0);
          const { cls, label } = classifyTTFB(firstByteAt);
          setBadge(cls, label);
        }

        const combined = new Uint8Array(leftover.byteLength + value.byteLength);
        combined.set(leftover, 0);
        combined.set(value, leftover.byteLength);
        const evenLen = combined.byteLength - (combined.byteLength % 2);
        const usable = combined.subarray(0, evenLen);
        leftover = combined.subarray(evenLen);
        if (usable.byteLength === 0) continue;

        const samples = usable.byteLength / 2;
        const dv = new DataView(usable.buffer, usable.byteOffset, usable.byteLength);
        const float = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
          float[i] = dv.getInt16(i * 2, true) / 32768;
        }

        const ab = audioCtx.createBuffer(1, samples, sampleRate);
        ab.getChannelData(0).set(float);
        const src = audioCtx.createBufferSource();
        src.buffer = ab;
        src.connect(audioCtx.destination);

        const startAt = Math.max(audioCtx.currentTime + prerollSec, nextStartTime);
        src.start(startAt);
        if (firstAudioAt === 0) {
          const clickToPlay = Math.round((startAt - audioCtx.currentTime) * 1000 + (performance.now() - t0));
          firstAudioAt = clickToPlay;
        }
        nextStartTime = startAt + samples / sampleRate;
        totalSamples += samples;
        scheduledSources.push(src);
      }

      // Bug 23: don't drop trailing odd byte — pad with zero and play.
      if (leftover.byteLength > 0) {
        const padded = new Uint8Array(leftover.byteLength + 1);
        padded.set(leftover);
        const samples = padded.byteLength / 2;
        const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
        const float = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
          float[i] = dv.getInt16(i * 2, true) / 32768;
        }
        const ab = audioCtx.createBuffer(1, samples, sampleRate);
        ab.getChannelData(0).set(float);
        const src = audioCtx.createBufferSource();
        src.buffer = ab;
        src.connect(audioCtx.destination);
        const startAt = Math.max(audioCtx.currentTime + prerollSec, nextStartTime);
        src.start(startAt);
        nextStartTime = startAt + samples / sampleRate;
        totalSamples += samples;
        scheduledSources.push(src);
        leftover = new Uint8Array(0);
      }

      const durationMs = Math.round((totalSamples / sampleRate) * 1000);
      statsEl.textContent = 'первый байт ' + firstByteAt + ' мс · в ухе ' + firstAudioAt + ' мс · длительность ' + durationMs + ' мс';

      // Bug 24: schedule teardown after all queued audio finishes.
      const remainMs = Math.max(0, Math.ceil((nextStartTime - audioCtx.currentTime) * 1000));
      const ctxAtSchedule = audioCtx;
      setTimeout(() => {
        if (audioCtx === ctxAtSchedule && !abortCtl) teardown();
      }, remainMs + 200);
    } catch (e) {
      if (e.name === 'AbortError') {
        setBadge('', 'остановлено');
      } else {
        setBadge('red', 'ошибка');
        errEl.textContent = String(e && e.message || e);
      }
    } finally {
      goBtn.disabled = false;
      stopBtn.disabled = true;
      abortCtl = null;
    }
  }

  function stop() {
    if (abortCtl) abortCtl.abort();
    teardown();
    setBadge('', 'остановлено');
    goBtn.disabled = false;
    stopBtn.disabled = true;
  }

  goBtn.addEventListener('click', play);
  stopBtn.addEventListener('click', stop);
  textEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') goBtn.click();
  });
</script>
</body>
</html>
`;

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'POST' && req.url === '/tts') {
    let size = 0;
    const bufs = [];
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_TEXT_BYTES) {
        aborted = true;
        req.destroy();
      } else {
        bufs.push(c);
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      const text = Buffer.concat(bufs).toString('utf8').trim();
      if (!text) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('empty text');
        return;
      }

      res.socket?.setNoDelay(true);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-sample-rate': String(SAMPLE_RATE),
        'x-pcm-format': 'int16le-mono',
        'cache-control': 'no-store',
      });

      const tts = new FishAudioTTS({ apiKey: API_KEY, referenceId: REFERENCE_ID });
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });

      const t0 = Date.now();
      let firstChunkAt = 0;
      let totalBytes = 0;
      let clientGone = false;

      try {
        for await (const chunk of tts.speak(text, { signal: abort.signal })) {
          if (firstChunkAt === 0) firstChunkAt = Date.now() - t0;
          totalBytes += chunk.sizeBytes;
          const ok = res.write(Buffer.from(chunk.data));
          if (!ok) {
            await new Promise((resolve) => {
              const onDrain = () => {
                abort.signal.removeEventListener('abort', onAbort);
                resolve();
              };
              const onAbort = () => {
                res.off('drain', onDrain);
                resolve();
              };
              res.once('drain', onDrain);
              abort.signal.addEventListener('abort', onAbort, { once: true });
            });
          }
          if (res.writableEnded || res.destroyed) { clientGone = true; break; }
        }
        res.end();
        console.log(
          `[${new Date().toISOString()}] tts ok — chars=${text.length} ttfb=${firstChunkAt}ms total=${Date.now() - t0}ms bytes=${totalBytes}${clientGone ? ' (client aborted)' : ''}`,
        );
      } catch (e) {
        console.error('tts error:', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end();
      } finally {
        await tts.close().catch(() => {});
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Fish TTS UI → http://${HOST}:${PORT}`);
});
