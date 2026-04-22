import { vi, describe, it, expect, beforeEach } from 'vitest';
import { FishAudioTTS } from '../tts/client.js';
import {
  FishAudioConnectionError,
  FishAudioProtocolError,
} from '../common/types.js';
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

  // Auto-sends finish when pump sends 'stop' — prevents stream() from hanging.
  sendMsgpack = vi.fn().mockImplementation((msg: unknown) => {
    if ((msg as { event?: string })?.event === 'stop') {
      Promise.resolve().then(() => this.simulateBinary(finishFrame()));
    }
  });

  simulateBinary(buf: ArrayBuffer): void { this._onBinary?.(buf); }
  simulateClose(code = 1000, reason = ''): void { this._onClose?.(code, reason); }
  simulateError(err: unknown = new Error('ws error')): void { this._onError?.(err); }
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

    const stopCalls = mockSockets[0]!.sendMsgpack.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'stop',
    );
    expect(stopCalls.length).toBe(0);
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
});
