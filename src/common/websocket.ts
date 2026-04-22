import { WebSocket } from 'undici';
import {
  FishAudioConnectionError,
  type ConnectionState,
  type Logger,
} from './types.js';
import { encode } from './msgpack.js';

export interface WebSocketWrapperOptions {
  url: string;
  headers: Record<string, string>;
  connectTimeoutMs?: number;
  logger?: Logger;
  onBinaryMessage?: (data: ArrayBuffer) => void;
  onStringMessage?: (data: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: unknown) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 5_000;
const SEND_BUFFER_WARN_BYTES = 1_000_000;

const toArrayBuffer = (data: unknown): ArrayBuffer | null => {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    const copy = new ArrayBuffer(view.byteLength);
    new Uint8Array(copy).set(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    );
    return copy;
  }
  return null;
};

export class FishAudioWebSocket {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private readonly options: WebSocketWrapperOptions;
  private closeWaiters: Array<() => void> = [];

  constructor(options: WebSocketWrapperOptions) {
    this.options = options;
  }

  getState(): ConnectionState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  onceClosed(): Promise<void> {
    if (this.state === 'disconnected' || this.state === 'error') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.closeWaiters.push(resolve);
    });
  }

  private resolveCloseWaiters(): void {
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of waiters) w();
  }

  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.state === 'connecting') {
      return Promise.reject(
        new FishAudioConnectionError('Connection already in progress'),
      );
    }

    this.state = 'connecting';
    const timeoutMs =
      this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        fn();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.state = 'error';
        try {
          this.ws?.close();
        } catch (err) {
          this.options.logger?.debug(
            '[fish-ws] close error during timeout',
            err,
          );
        }
        settle(() =>
          reject(
            new FishAudioConnectionError(
              `Connection timed out after ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);

      let thisWs: WebSocket;
      try {
        thisWs = new WebSocket(this.options.url, {
          headers: this.options.headers,
        });
        this.ws = thisWs;
      } catch (err) {
        this.state = 'error';
        settle(() =>
          reject(
            new FishAudioConnectionError(
              'Failed to construct WebSocket',
              err,
            ),
          ),
        );
        return;
      }

      // Must set synchronously: some undici versions default to 'blob'.
      thisWs.binaryType = 'arraybuffer';

      thisWs.addEventListener('open', () => {
        if (thisWs !== this.ws) return;
        this.state = 'connected';
        this.options.logger?.debug('[fish-ws] connected');
        settle(resolve);
      });

      thisWs.addEventListener('message', (event) => {
        if (thisWs !== this.ws) return;
        const { data } = event;
        if (typeof data === 'string') {
          this.options.onStringMessage?.(data);
          return;
        }
        const buffer = toArrayBuffer(data);
        if (buffer) {
          this.options.onBinaryMessage?.(buffer);
        } else {
          this.options.logger?.warn('[fish-ws] unknown message data type');
        }
      });

      thisWs.addEventListener('error', (event) => {
        if (thisWs !== this.ws) return;
        const errEvent = event as { message?: string; type?: string };
        this.options.logger?.error(
          '[fish-ws] error',
          errEvent.message ?? errEvent.type ?? 'unknown',
        );
        if (this.state === 'connecting') {
          this.state = 'error';
          settle(() =>
            reject(
              new FishAudioConnectionError('WebSocket connection failed'),
            ),
          );
        } else {
          this.state = 'error';
          this.options.onError?.(event);
        }
      });

      thisWs.addEventListener('close', (event) => {
        if (thisWs !== this.ws) return;
        const previousState = this.state;
        if (this.state !== 'error') {
          this.state = 'disconnected';
        }
        this.options.logger?.debug(
          `[fish-ws] closed: ${event.code} ${event.reason}`,
        );
        if (!timedOut) {
          this.options.onClose?.(event.code, event.reason);
        }
        this.resolveCloseWaiters();
        if (!settled) {
          settle(() =>
            reject(
              new FishAudioConnectionError(
                `WebSocket closed during connect: ${event.code} (was ${previousState})`,
              ),
            ),
          );
        }
      });
    });
  }

  sendMsgpack(obj: unknown): void {
    this.sendBinary(encode(obj));
  }

  sendBinary(data: ArrayBuffer | ArrayBufferView | Uint8Array): void {
    if (!this.isOpen() || !this.ws) {
      throw new FishAudioConnectionError(
        `Cannot send binary: socket is ${this.state}`,
      );
    }
    this.ws.send(data);
    if (this.ws.bufferedAmount > SEND_BUFFER_WARN_BYTES) {
      this.options.logger?.warn(
        `[fish-ws] send buffer high: ${this.ws.bufferedAmount} bytes`,
      );
    }
  }

  close(code = 1000, reason = 'Normal closure'): void {
    if (!this.ws) return;
    if (this.state === 'closing' || this.state === 'disconnected') return;
    this.state = 'closing';
    try {
      this.ws.close(code, reason);
    } catch (err) {
      this.options.logger?.warn('[fish-ws] close threw', err);
    }
    setTimeout(() => {
      if (this.state === 'closing') {
        this.options.logger?.warn(
          `[fish-ws] close did not complete within ${CLOSE_GRACE_MS}ms`,
        );
        this.state = 'disconnected';
        this.resolveCloseWaiters();
      }
    }, CLOSE_GRACE_MS);
  }
}
