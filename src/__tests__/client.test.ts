import { vi, describe, it, expect, beforeEach } from 'vitest';
import { FishAudioTTS } from '../tts/client.js';
import {
  FishAudioAbortError,
  FishAudioAuthError,
  FishAudioConnectionError,
  FishAudioProtocolError,
} from '../common/types.js';
import { FishAudioWebSocket } from '../common/websocket.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';

// ---------------------------------------------------------------------------
// Encoded frames helpers
// ---------------------------------------------------------------------------

function audioFrame(byteLength: number): ArrayBuffer {
  const audio = new Uint8Array(byteLength).fill(0x42);
  const enc = msgpackEncode({ event: 'audio', audio });
  return enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
}

function finishFrame(reason = 'stop'): ArrayBuffer {
  const enc = msgpackEncode({ event: 'finish', reason });
  return enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
}

// ---------------------------------------------------------------------------
// Mock FishAudioWebSocket
// ---------------------------------------------------------------------------

type OnBinary = (buf: ArrayBuffer) => void;
type OnClose = (code: number, reason: string) => void;
type OnError = (err: unknown) => void;
type SocketOpts = {
  onBinaryMessage?: OnBinary;
  onClose?: OnClose;
  onError?: OnError;
};

let mockSockets: MockSocket[] = [];

class MockSocket {
  isOpen = vi.fn(() => true);
  getState = vi.fn(() => 'connected' as const);
  connect = vi.fn(() => Promise.resolve());
  close = vi.fn();
  onceClosed = vi.fn(() => Promise.resolve());

  _onBinary?: OnBinary;
  _onClose?: OnClose;
  _onError?: OnError;

  // Default: do NOT auto-finish on stop. Tests that need server-side finish
  // must call `sock.serverFinish()` explicitly (mirrors real Fish server,
  // which may send finish before OR after client stop).
  sendMsgpack = vi.fn().mockImplementation((_msg: unknown) => {});

  simulateBinary(buf: ArrayBuffer): void { this._onBinary?.(buf); }
  simulateClose(code = 1000, reason = ''): void { this._onClose?.(code, reason); }
  simulateError(err: unknown = new Error('ws error')): void { this._onError?.(err); }

  serverFinish(reason: string = 'stop'): void {
    this.simulateBinary(finishFrame(reason));
  }
}

vi.mock('../common/websocket.js', () => ({
  FishAudioWebSocket: vi.fn().mockImplementation((opts: SocketOpts) => {
    const sock = new MockSocket();
    sock._onBinary = opts.onBinaryMessage;
    sock._onClose = opts.onClose;
    sock._onError = opts.onError;
    mockSockets.push(sock);
    return sock;
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* singleWord(text: string): AsyncGenerator<string> {
  yield text;
}

async function collectChunks(gen: AsyncGenerator<{ data: ArrayBuffer; sequence: number; sizeBytes: number; timestamp: number }>): Promise<number> {
  let n = 0;
  for await (const _ of gen) n++;
  return n;
}

async function withTimeout<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

beforeEach(() => {
  mockSockets = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FishAudioTTS', () => {

  // Bug 11: concurrent connect() calls create only one socket
  it('Bug 11: concurrent connect() creates only one socket', async () => {
    const tts = new FishAudioTTS({ apiKey: 'key', referenceId: 'ref' });
    const [p1, p2] = [tts.connect(), tts.connect()];
    await Promise.allSettled([p1, p2]);
    expect(mockSockets.length).toBe(1);
  });

  // -------------------------------------------------------------------------

  // Bug 13: reconnect must not create new socket before old one closes
  it('Bug 13: reconnect must not create new socket before old one closes', async () => {
    const tts = new FishAudioTTS({ apiKey: 'key', referenceId: 'ref' });
    await tts.connect('ref-a');

    const firstSock = mockSockets[0]!;

    // Make onceClosed hang until explicitly released
    let releaseClose!: () => void;
    firstSock.onceClosed.mockReturnValueOnce(
      new Promise<void>((res) => { releaseClose = res; }),
    );

    const reconnectP = tts.connect('ref-b');

    // New socket must NOT exist yet
    expect(mockSockets.length).toBe(1);

    releaseClose();
    await withTimeout(reconnectP);

    expect(mockSockets.length).toBe(2);
  });

  // -------------------------------------------------------------------------

  // Bug 19: odd-byte PCM audio chunk must trigger a logger warning
  it('Bug 19: odd-byte PCM chunk triggers logger warning', async () => {
    const warnFn = vi.fn();
    const tts = new FishAudioTTS({
      apiKey: 'key',
      referenceId: 'ref',
      format: 'pcm',
      logger: { debug: vi.fn(), info: vi.fn(), warn: warnFn, error: vi.fn() },
    });

    const { FishAudioWebSocket } = await import('../common/websocket.js');
    vi.mocked(FishAudioWebSocket).mockImplementationOnce((opts: SocketOpts) => {
      const sock = new MockSocket();
      sock._onBinary = opts.onBinaryMessage;
      sock._onClose = opts.onClose;
      sock.sendMsgpack = vi.fn().mockImplementation((msg: unknown) => {
        if ((msg as { event?: string })?.event === 'stop') {
          Promise.resolve()
            .then(() => sock.simulateBinary(audioFrame(3))) // 3 bytes = odd
            .then(() => sock.simulateBinary(finishFrame()));
        }
      });
      mockSockets.push(sock);
      return sock;
    });

    await withTimeout(collectChunks(tts.stream(singleWord('hello'))));

    expect(warnFn).toHaveBeenCalled();
    const warnedAboutOdd = warnFn.mock.calls.some((args) =>
      args.some((a) => /odd|pcm|byte/i.test(String(a))),
    );
    expect(warnedAboutOdd).toBe(true);
  });

  // -------------------------------------------------------------------------

  // Bug 22: pump must not send stop after server already sent finish
  it('Bug 22: pump skips stop when finishSeen is true', async () => {
    const tts = new FishAudioTTS({ apiKey: 'key', referenceId: 'ref' });

    const { FishAudioWebSocket } = await import('../common/websocket.js');
    vi.mocked(FishAudioWebSocket).mockImplementationOnce((opts: SocketOpts) => {
      const sock = new MockSocket();
      sock._onBinary = opts.onBinaryMessage;
      sock._onClose = opts.onClose;
      sock.sendMsgpack = vi.fn().mockImplementation((msg: unknown) => {
        if ((msg as { event?: string })?.event === 'text') {
          // Server sends finish immediately on receiving text, before stop
          Promise.resolve().then(() => sock.simulateBinary(finishFrame()));
        }
      });
      mockSockets.push(sock);
      return sock;
    });

    await withTimeout(collectChunks(tts.stream(singleWord('hello'))));

    const calls = mockSockets[0]!.sendMsgpack.mock.calls;
    const stopCalls = calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'stop',
    );
    const textCalls = calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'text',
    );
    // Strengthened: prove the pump actually ran (a text was sent) AND stop was skipped.
    expect(textCalls.length).toBeGreaterThan(0);
    expect(stopCalls.length).toBe(0);

    // And a subsequent stream() should proceed cleanly (no leftover error),
    // proving finishSeen did its job and didn't poison the next run.
    const sock = mockSockets[0]!;
    sock.sendMsgpack = vi.fn().mockImplementation((msg: unknown) => {
      if ((msg as { event?: string })?.event === 'text') {
        Promise.resolve().then(() => sock.simulateBinary(finishFrame()));
      }
    });
    await withTimeout(collectChunks(tts.stream(singleWord('again'))));
  });

  // -------------------------------------------------------------------------

  // Bug 36: speak('') must not open a WebSocket connection
  it('Bug 36: speak("") does not open a socket', async () => {
    const tts = new FishAudioTTS({ apiKey: 'key', referenceId: 'ref' });

    try {
      await withTimeout(collectChunks(tts.speak('')), 200);
    } catch {
      // throw or return 0 chunks — both acceptable
    }

    expect(mockSockets.length).toBe(0);
  });

  // -------------------------------------------------------------------------

  // TTS: model sent as URL query param, not header (client.ts:200)
  it('TTS: model sent as URL query param, not header', async () => {
    const tts = new FishAudioTTS({
      apiKey: 'key',
      referenceId: 'ref',
      model: 's1',
    });
    await tts.connect();

    const mockedCtor = vi.mocked(FishAudioWebSocket);
    expect(mockedCtor.mock.calls.length).toBeGreaterThan(0);
    const opts = mockedCtor.mock.calls[0]![0] as {
      url: string;
      headers: Record<string, string>;
    };

    // url must carry the model as query param
    expect(opts.url).toMatch(/[?&]model=s1(\b|&|$)/);

    // headers must NOT contain any "model"-like key
    const headerKeys = Object.keys(opts.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('model');
  });

  // -------------------------------------------------------------------------

  // TTS: orphan socket after connect is aborted (client.ts:288-301)
  // If the user aborts while stream() is awaiting connect(), the underlying
  // FishAudioWebSocket must not be left open as an orphan.
  it('TTS: aborting during connect does not leave an orphan socket', async () => {
    const tts = new FishAudioTTS({ apiKey: 'key', referenceId: 'ref' });

    // Make connect() hang forever so the abort-race resolves the rejection first.
    vi.mocked(FishAudioWebSocket).mockImplementationOnce((opts: SocketOpts) => {
      const sock = new MockSocket();
      sock._onBinary = opts.onBinaryMessage;
      sock._onClose = opts.onClose;
      sock._onError = opts.onError;
      // never resolves
      sock.connect = vi.fn(() => new Promise<void>(() => {}));
      mockSockets.push(sock);
      return sock;
    });

    const ac = new AbortController();
    const iter = (async function* () { yield 'hello'; })();
    const streamP = collectChunks(tts.stream(iter, { signal: ac.signal }));

    // Give connect() a microtask to kick off.
    await Promise.resolve();
    await Promise.resolve();

    ac.abort();

    await expect(withTimeout(streamP, 300)).rejects.toBeInstanceOf(
      FishAudioAbortError,
    );

    // There must be no orphan: the socket that was being opened must have
    // been closed (or reported as not-open) after the abort.
    expect(mockSockets.length).toBe(1);
    const sock = mockSockets[0]!;
    const closed = sock.close.mock.calls.length > 0 || !sock.isOpen();
    expect(closed).toBe(true);
  });

  // -------------------------------------------------------------------------

  // Test-infra regression: server-initiated finish before client stop.
  // The mock no longer auto-finishes on stop, so this test simulates the
  // real server sending `finish` as soon as it sees `text`, and verifies
  // the client suppresses the subsequent `stop`.
  it('TTS: server-initiated finish suppresses client stop', async () => {
    const tts = new FishAudioTTS({ apiKey: 'key', referenceId: 'ref' });

    const sock = new MockSocket();
    sock.sendMsgpack = vi.fn().mockImplementation((msg: unknown) => {
      if ((msg as { event?: string })?.event === 'text') {
        // Emit finish in the SAME microtask batch so the pump sees finishSeen
        // before it tries to send stop. (Mirrors the Bug 22 override style.)
        Promise.resolve().then(() => {
          sock.simulateBinary(audioFrame(4));
          sock.simulateBinary(finishFrame());
        });
      }
    });

    vi.mocked(FishAudioWebSocket).mockImplementationOnce((opts: SocketOpts) => {
      sock._onBinary = opts.onBinaryMessage;
      sock._onClose = opts.onClose;
      sock._onError = opts.onError;
      mockSockets.push(sock);
      return sock;
    });

    const chunks = await withTimeout(
      collectChunks(tts.stream(singleWord('hello'))),
    );
    expect(chunks).toBeGreaterThan(0);

    const calls = sock.sendMsgpack.mock.calls.map(
      (c) => (c[0] as { event?: string })?.event,
    );
    expect(calls).toContain('text');
    expect(calls).not.toContain('stop');
  });
});
