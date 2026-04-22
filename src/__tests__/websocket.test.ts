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
  private handlers = new Map<string, EventHandler[]>();
  send = vi.fn();
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

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  closeWith(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

vi.mock('undici', () => ({
  WebSocket: vi.fn().mockImplementation(() => {
    mockWsInstance = new MockWS();
    return mockWsInstance;
  }),
}));

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

  it('Bug 7: timeout delivers a distinguishable close — not generic onClose(1006, "")', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const ws = makeWs({ connectTimeoutMs: 200, onClose });

    const connectP = ws.connect();
    // Suppress unhandled-rejection warning — we catch it below
    connectP.catch(() => {});

    await vi.advanceTimersByTimeAsync(201);

    // In real WS, ws.close() inside the timeout handler triggers the close event.
    // Simulate that:
    mockWsInstance.closeWith(1006, '');

    const err = await connectP.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FishAudioConnectionError);
    expect((err as Error).message).toMatch(/timed out/i);

    // After fix: close triggered by timeout must be distinguishable.
    // Either: onClose not called, OR called with a non-1006 code, OR reason contains 'timeout'.
    if (onClose.mock.calls.length > 0) {
      const [code, reason] = onClose.mock.calls[0] as [number, string];
      const distinguishable = code !== 1006 || (reason as string).toLowerCase().includes('timeout');
      expect(distinguishable).toBe(true);
    }
    // If onClose is not called at all for a timeout, that is also acceptable.
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
