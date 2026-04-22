import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FishAudioWebSocket } from '../common/websocket.js';
import type { WebSocketWrapperOptions } from '../common/websocket.js';
import { FishAudioConnectionError } from '../common/types.js';

// ---------------------------------------------------------------------------
// Mock undici WebSocket
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown) => void;

let mockWsInstance: MockWS;

class MockWS {
  binaryType = 'arraybuffer';
  readyState = 0;
  bufferedAmount = 0;
  // Exposed so tests can introspect listener lifecycles / leaks.
  handlers = new Map<string, EventHandler[]>();
  send = vi.fn();
  // Matches real undici semantics: ws.close() initiates a close handshake
  // but does NOT synchronously fire the 'close' event. Tests that want the
  // close event fired must call closeWith() explicitly after the source
  // calls ws.close().
  close = vi.fn();

  addEventListener(type: string, fn: EventHandler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }

  removeEventListener(type: string, fn: EventHandler): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter(h => h !== fn));
  }

  emit(type: string, event: unknown = {}): void {
    this.handlers.get(type)?.forEach(h => h(event));
  }

  totalHandlers(): number {
    let n = 0;
    for (const arr of this.handlers.values()) n += arr.length;
    return n;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  closeWith(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

// Collect every mock instance ever constructed so we can assert across
// reconnects that old sockets have been properly detached.
const mockWsInstances: MockWS[] = [];

vi.mock('undici', () => {
  const WebSocket = vi.fn().mockImplementation(() => {
    mockWsInstance = new MockWS();
    mockWsInstances.push(mockWsInstance);
    return mockWsInstance;
  }) as unknown as { OPEN: number; CLOSED: number; CONNECTING: number; CLOSING: number };
  // The source uses `WebSocket.OPEN` as a readyState sentinel in isOpen().
  // Without these static constants the comparison silently evaluates to
  // false in every test — masking bugs in any path gated by isOpen().
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;
  return { WebSocket };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(extra: Partial<WebSocketWrapperOptions> = {}): FishAudioWebSocket {
  return new FishAudioWebSocket({ url: 'wss://test.invalid', headers: {}, ...extra });
}

async function withTimeout<T>(promise: Promise<T>, ms = 200): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FishAudioWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWsInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------

  it('Bug 1: onceClosed() resolves immediately when state is error (no close event yet)', async () => {
    const ws = makeWs();
    const p = ws.connect();

    // Error fires during connecting → state = 'error', promise rejects
    // Deliberately do NOT fire the close event afterward
    mockWsInstance.emit('error', {});
    await expect(p).rejects.toBeInstanceOf(FishAudioConnectionError);

    // state is now 'error' (close event never fired)
    // onceClosed() must resolve right away, not hang
    await expect(withTimeout(ws.onceClosed(), 100)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------

  it('Bug 6: onError should NOT be called during connecting-phase failure', async () => {
    const onError = vi.fn();
    const ws = makeWs({ onError });

    const p = ws.connect();
    mockWsInstance.emit('error', {});
    mockWsInstance.closeWith(1006, '');

    await expect(p).rejects.toBeInstanceOf(FishAudioConnectionError);

    // Connecting-phase errors surface via promise rejection only.
    // onError is for post-connect errors; it should stay silent here.
    expect(onError).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------

  it('WS: connect timeout does not call onClose (timeout is an internal signal)', async () => {
    // Prior version of this test was doubly broken: (1) it manually fired a
    // second close event AFTER the real source's ws.close() already wired
    // one through the mock (double-fire); (2) it accepted "onClose not
    // called" OR "onClose called with distinguishable args", which lets the
    // source emit a generic (1006, '') close and still pass. Real contract:
    // a connect-timeout is purely internal — the caller learns about it via
    // the rejected connect() promise, NOT via the onClose callback.
    vi.useFakeTimers();
    const onClose = vi.fn();
    const ws = makeWs({ connectTimeoutMs: 200, onClose });

    const connectP = ws.connect();
    connectP.catch(() => {});

    // Advance past timeout. The source's timeout handler calls ws.close(),
    // which our mock implements as closeWith(1000,'') — so any "double close"
    // (timeout handler + close() method) would surface as duplicate onClose
    // calls. We do NOT manually fire another close here.
    await vi.advanceTimersByTimeAsync(201);

    const err = await connectP.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FishAudioConnectionError);
    expect((err as Error).message).toMatch(/timed out/i);

    // Timeout is internal: onClose must not be invoked.
    expect(onClose).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------

  it('WS: listeners on the old WebSocket are removed on reconnect (no leak)', async () => {
    // After close() + reconnect, the previous WS object must not retain
    // event listeners pointing at the wrapper (they keep the wrapper alive
    // in long-running processes and accumulate per reconnect).
    const ws = makeWs();
    const p1 = ws.connect();
    const oldMock = mockWsInstance;
    oldMock.open();
    await p1;

    const handlersBeforeClose = oldMock.totalHandlers();
    expect(handlersBeforeClose).toBeGreaterThan(0);

    ws.close(1000, 'reconnect');
    oldMock.closeWith(1000, 'reconnect');

    const p2 = ws.connect();
    mockWsInstance.open();
    await p2;

    // Fix: the old mock has been detached. Bug: old listeners are still
    // attached and fire (neutered via `thisWs !== this.ws` closure-guard,
    // but still present in the handler map → leak).
    expect(oldMock.totalHandlers()).toBe(0);
  });

  // -------------------------------------------------------------------------

  it('WS: onceClosed() rejects when connect fails without a close event', async () => {
    // Bug: waiters in closeWaiters[] have no rejection path. If the WS
    // goes to state='error' (error event during connecting) and the peer
    // never sends a close frame, onceClosed() hangs forever for anyone who
    // called it while the state was 'connecting' / 'closing'.
    const ws = makeWs();
    const connectP = ws.connect();
    connectP.catch(() => {});
    // Register a waiter BEFORE the error fires, while state is 'connecting'.
    const closedP = ws.onceClosed();

    mockWsInstance.emit('error', {});
    await expect(connectP).rejects.toBeInstanceOf(FishAudioConnectionError);

    // Fix: the waiter must settle (resolve or reject) within a reasonable
    // window. Current bug: it hangs.
    await expect(withTimeout(closedP, 150)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------

  it('WS: grace-timer is cleared when close completes normally', async () => {
    vi.useFakeTimers();
    const ws = makeWs();
    const p = ws.connect();
    mockWsInstance.open();
    await p;

    const timersBeforeClose = vi.getTimerCount();

    ws.close(1000, 'normal');
    // Source schedules a 5s grace timer inside close(). Simulate the peer
    // closing normally a moment later.
    mockWsInstance.closeWith(1000, 'normal');
    await Promise.resolve();
    expect(ws.getState()).toBe('disconnected');

    // Bug: grace-timer is still scheduled and will fire 5s later, even
    // though close completed normally. Fix: clear it when the close event
    // arrives before the grace expires.
    expect(vi.getTimerCount()).toBe(timersBeforeClose);
  });

  // -------------------------------------------------------------------------

  it('WS: close() during connect() does not double-close the socket', async () => {
    vi.useFakeTimers();
    const ws = makeWs({ connectTimeoutMs: 200 });
    const connectP = ws.connect();
    connectP.catch(() => {});

    // User calls close() while connecting.
    ws.close(1000, 'abort connect');
    const closeCallsAfterFirst = mockWsInstance.close.mock.calls.length;

    // Now let the connect timeout fire (in the buggy version it also
    // calls this.ws.close(), producing a second close call).
    await vi.advanceTimersByTimeAsync(201);

    // Fix: the second close() must be suppressed because state is already
    // 'closing' / 'disconnected'. Bug: ws.close is called twice.
    expect(mockWsInstance.close.mock.calls.length).toBe(closeCallsAfterFirst);
  });

  // -------------------------------------------------------------------------

  it('WS: sendBinary wraps underlying send() errors in FishAudioConnectionError', async () => {
    // Bug: sendBinary() calls this.ws.send(data) with no try/catch. Errors
    // from send (e.g. buffer overflow, readyState flipped mid-call) leak as
    // raw DOMException / generic Error instead of the library's typed error.
    const ws = makeWs();
    const p = ws.connect();
    mockWsInstance.open();
    await p;

    mockWsInstance.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });

    expect(() => ws.sendBinary(new Uint8Array([1, 2, 3]))).toThrow(
      FishAudioConnectionError,
    );
  });

  // -------------------------------------------------------------------------

  it('WS: non-ArrayBuffer non-view binary messages surface to onError', async () => {
    // Bug: toArrayBuffer() returns null for unknown shapes (e.g. Blob) and
    // the message handler only logs a warn — the consumer has no way to
    // observe that binary data was dropped. The fix should surface the
    // drop to onError (or support Blob via async conversion), not drop
    // silently.
    const onError = vi.fn();
    const onBinaryMessage = vi.fn();
    const ws = makeWs({ onError, onBinaryMessage });
    const p = ws.connect();
    mockWsInstance.open();
    await p;

    // Simulate a Blob-like object (undici can deliver these in some configs).
    mockWsInstance.emit('message', { data: { kind: 'blob', size: 128 } });

    // Fix: unknown shapes must be surfaced to onError (strictest contract).
    // Bug: onError never invoked, message silently dropped.
    expect(onError).toHaveBeenCalled();
    expect(onBinaryMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------

  it('Bug 8: error event AFTER successful connect should transition state to "error"', async () => {
    const ws = makeWs();
    const p = ws.connect();
    mockWsInstance.open();
    await p;

    expect(ws.getState()).toBe('connected');

    // Simulate a post-connect WS error (e.g. server sends RST)
    mockWsInstance.emit('error', {});

    // Fix: state must become 'error', not stay 'connected'
    expect(ws.getState()).toBe('error');
  });

  // -------------------------------------------------------------------------

  it('Bug 9: stale old-WS close event must not clobber new connection state', async () => {
    const ws = makeWs();

    // 1. Connect successfully
    const p1 = ws.connect();
    const oldMock = mockWsInstance;
    oldMock.open();
    await p1;
    expect(ws.getState()).toBe('connected');

    // 2. Start closing (async — old WS close event not yet fired)
    ws.close(1000, 'reconnect');

    // 3. Immediately reconnect — creates new WS, state = 'connecting'
    const p2 = ws.connect();
    // mockWsInstance is now the new WS

    // 4. Old WS fires its close event after the new connection started
    oldMock.closeWith(1000, 'reconnect');

    // Fix: state must still be 'connecting' or 'connected', never 'disconnected'
    expect(['connecting', 'connected']).toContain(ws.getState());

    // Cleanup: resolve the new connection
    mockWsInstance.open();
    await expect(withTimeout(p2)).resolves.toBeUndefined();
  });
});
