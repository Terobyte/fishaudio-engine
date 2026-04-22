import { FishAudioWebSocket } from '../common/websocket.js';
import { decodeEvent } from '../common/msgpack.js';
import {
  FishAudioAbortError,
  FishAudioAuthError,
  FishAudioConnectionError,
  FishAudioProtocolError,
  silentLogger,
  type ConnectionState,
  type Logger,
} from '../common/types.js';
import type {
  AudioChunk,
  FishAudioFormat,
  FishAudioLatency,
  FishAudioModel,
  StreamOptions,
  TTSClientOptions,
} from './types.js';

type QueueItem =
  | { kind: 'chunk'; chunk: AudioChunk }
  | { kind: 'finished' }
  | { kind: 'error'; error: unknown };

type PendingPull = {
  resolve: (item: QueueItem) => void;
};

interface StartEventRequest {
  text: string;
  format: FishAudioFormat;
  sample_rate: number;
  latency: FishAudioLatency;
  chunk_length: number;
  temperature: number;
  top_p: number;
  normalize: boolean;
  condition_on_previous_chunks: boolean;
  reference_id?: string;
}

interface StartEvent {
  event: 'start';
  request: StartEventRequest;
}

const DEFAULT_BASE_URL = 'wss://api.fish.audio/v1/tts/live';
const DEFAULT_MODEL: FishAudioModel = 's1';
const DEFAULT_FORMAT: FishAudioFormat = 'pcm';
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_LATENCY: FishAudioLatency = 'balanced';
const DEFAULT_CHUNK_LENGTH = 100;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.7;
const DEFAULT_NORMALIZE = true;
const DEFAULT_CONDITION_PREV = true;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFERED_CHUNKS = 512;
const CLOSE_FINISH_GRACE_MS = 2_000;

async function* singleton<T>(x: T): AsyncGenerator<T> {
  yield x;
}

export class FishAudioTTS {
  private readonly options: Required<
    Omit<TTSClientOptions, 'logger' | 'referenceId' | 'baseUrl'>
  > & {
    logger: Logger;
    referenceId: string | undefined;
    baseUrl: string;
  };

  private readonly maxBufferedChunks: number;

  private socket: FishAudioWebSocket | null = null;
  private currentReferenceId: string | undefined = undefined;

  private queue: QueueItem[] = [];
  private pendingPull: PendingPull | null = null;
  private chunkSequence = 0;
  private finishSeen = false;

  private activeStream: Promise<void> | null = null;

  private textPumpAbort: AbortController | null = null;
  private textPumpPromise: Promise<void> | null = null;
  private textIterInUse: AsyncIterator<string> | null = null;

  private connectingPromise: Promise<void> | null = null;
  private closingPromise: Promise<void> | null = null;

  constructor(options: TTSClientOptions) {
    if (!options.apiKey) {
      throw new FishAudioAuthError('apiKey is required');
    }
    this.options = {
      apiKey: options.apiKey,
      referenceId: options.referenceId,
      model: options.model ?? DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      format: options.format ?? DEFAULT_FORMAT,
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      latency: options.latency ?? DEFAULT_LATENCY,
      chunkLength: options.chunkLength ?? DEFAULT_CHUNK_LENGTH,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      topP: options.topP ?? DEFAULT_TOP_P,
      normalize: options.normalize ?? DEFAULT_NORMALIZE,
      conditionOnPreviousChunks:
        options.conditionOnPreviousChunks ?? DEFAULT_CONDITION_PREV,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      logger: options.logger ?? silentLogger,
    };

    this.maxBufferedChunks =
      (options as { maxBufferedChunks?: number }).maxBufferedChunks ??
      DEFAULT_MAX_BUFFERED_CHUNKS;

    if (this.options.chunkLength < 100 || this.options.chunkLength > 300) {
      throw new FishAudioProtocolError(
        `chunkLength must be 100-300, got ${this.options.chunkLength}`,
      );
    }
    if (this.options.temperature < 0 || this.options.temperature > 1) {
      throw new FishAudioProtocolError(
        `temperature must be 0-1, got ${this.options.temperature}`,
      );
    }
    if (this.options.topP < 0 || this.options.topP > 1) {
      throw new FishAudioProtocolError(
        `topP must be 0-1, got ${this.options.topP}`,
      );
    }
  }

  getState(): ConnectionState {
    return this.socket?.getState() ?? 'disconnected';
  }

  isOpen(): boolean {
    return this.socket?.isOpen() ?? false;
  }

  private buildStartEvent(referenceId: string | undefined): StartEvent {
    const request: StartEventRequest = {
      text: '',
      format: this.options.format,
      sample_rate: this.options.sampleRate,
      latency: this.options.latency,
      chunk_length: this.options.chunkLength,
      temperature: this.options.temperature,
      top_p: this.options.topP,
      normalize: this.options.normalize,
      condition_on_previous_chunks: this.options.conditionOnPreviousChunks,
    };
    if (referenceId) request.reference_id = referenceId;
    return { event: 'start', request };
  }

  async connect(referenceIdOverride?: string): Promise<void> {
    if (this.connectingPromise) return this.connectingPromise;

    const desired = referenceIdOverride ?? this.options.referenceId;

    if (this.socket?.isOpen() && this.currentReferenceId === desired) {
      return;
    }

    this.connectingPromise = this.doConnect(desired);
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async doConnect(desired: string | undefined): Promise<void> {
    if (this.socket?.isOpen() && this.currentReferenceId !== desired) {
      this.options.logger.debug(
        '[fish] reconnect due to referenceId change',
      );
      const oldSocket = this.socket;
      oldSocket.close(1000, 'reference_id change');
      try {
        await oldSocket.onceClosed();
      } catch (err) {
        this.options.logger.debug(
          '[fish] cleanup error',
          err,
        );
      }
      this.socket = null;
    }

    const ws = new FishAudioWebSocket({
      url: this.options.baseUrl,
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        model: this.options.model,
      },
      connectTimeoutMs: this.options.connectTimeoutMs,
      logger: this.options.logger,
      onBinaryMessage: (buf) => this.handleBinaryMessage(buf),
      onStringMessage: (msg) =>
        this.options.logger.debug('[fish] unexpected string message', msg),
      onClose: (code, reason) => this.handleClose(code, reason),
      onError: (err) => this.options.logger.warn('[fish] ws error', err),
    });

    await ws.connect();
    this.socket = ws;
    this.currentReferenceId = desired;

    try {
      ws.sendMsgpack(this.buildStartEvent(desired));
    } catch (err) {
      ws.close(1011, 'start event send failed');
      this.socket = null;
      throw new FishAudioConnectionError('Failed to send start event', err);
    }
  }

  async *stream(
    textIter: AsyncIterable<string>,
    opts: StreamOptions = {},
  ): AsyncGenerator<AudioChunk> {
    if (this.activeStream) {
      throw new FishAudioProtocolError('stream() is already active');
    }
    const userSignal = opts.signal;
    if (userSignal?.aborted) {
      throw new FishAudioAbortError('signal aborted before stream()');
    }

    let streamDone!: () => void;
    this.activeStream = new Promise<void>((res) => {
      streamDone = res;
    });

    // Bug 16: warn if previous queue had unconsumed errors before clearing
    const unconsumedErrors = this.queue.filter((i) => i.kind === 'error');
    if (unconsumedErrors.length > 0) {
      this.options.logger.warn(
        `[fish] discarding ${unconsumedErrors.length} unconsumed error(s) from previous stream`,
      );
    }

    this.queue = [];
    this.pendingPull = null;
    this.chunkSequence = 0;
    this.finishSeen = false;
    this.textPumpAbort = new AbortController();
    this.textIterInUse = null;

    const connectAbort = new AbortController();
    const onAbortDuringConnect = () => {
      connectAbort.abort(
        new FishAudioAbortError('stream aborted before start'),
      );
    };
    userSignal?.addEventListener('abort', onAbortDuringConnect, {
      once: true,
    });

    const onUserAbort = () => {
      this.textPumpAbort?.abort();
      this.textIterInUse?.return?.(undefined).catch((err) => {
        this.options.logger.debug('[fish] cleanup error', err);
      });
      try {
        if (this.socket?.isOpen()) {
          this.socket.sendMsgpack({ event: 'stop' });
        }
      } catch (e) {
        this.options.logger.debug(
          '[fish] stop send on abort failed (socket may already be closed)',
          e,
        );
      }
      this.push({
        kind: 'error',
        error: new FishAudioAbortError('stream aborted'),
      });
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

      if (!this.socket?.isOpen()) {
        throw new FishAudioConnectionError('socket not open after connect');
      }

      userSignal?.addEventListener('abort', onUserAbort, { once: true });

      const pumpSignal = this.textPumpAbort.signal;
      const iter = textIter[Symbol.asyncIterator]();
      this.textIterInUse = iter;

      this.textPumpPromise = (async () => {
        try {
          while (true) {
            if (pumpSignal.aborted) return;
            const { value, done } = await iter.next();
            if (done) break;
            if (pumpSignal.aborted) return;
            if (!this.socket?.isOpen()) return;
            if (typeof value !== 'string') {
              this.options.logger.warn(
                '[fish] text iterator yielded non-string value; skipping',
              );
              continue;
            }
            if (value.length === 0) continue;
            try {
              this.socket.sendMsgpack({ event: 'text', text: value });
            } catch (sendErr) {
              if (!pumpSignal.aborted) {
                this.push({
                  kind: 'error',
                  error: new FishAudioConnectionError(
                    'text send failed',
                    sendErr,
                  ),
                });
              }
              return;
            }
          }
          // Bug 22: skip stop when finishSeen is already true
          if (
            !pumpSignal.aborted &&
            this.socket?.isOpen() &&
            !this.finishSeen
          ) {
            try {
              this.socket.sendMsgpack({ event: 'stop' });
            } catch (sendErr) {
              if (!pumpSignal.aborted) {
                this.push({
                  kind: 'error',
                  error: new FishAudioConnectionError(
                    'stop send failed',
                    sendErr,
                  ),
                });
              }
            }
          }
        } catch (err) {
          // Bug 4: always surface non-abort errors. If the underlying error
          // is itself an abort error, we suppress; otherwise surface it.
          const isAbortError = err instanceof FishAudioAbortError;
          if (!isAbortError) {
            this.push({
              kind: 'error',
              error: new FishAudioProtocolError(
                'text iterator error',
                err,
              ),
            });
          }
        }
      })();

      while (true) {
        const item = await this.pull();
        if (item.kind === 'error') throw item.error;
        if (item.kind === 'finished') return;
        yield item.chunk;
      }
    } finally {
      this.textPumpAbort?.abort();
      this.textIterInUse?.return?.(undefined).catch((err) => {
        this.options.logger.debug('[fish] cleanup error', err);
      });
      if (this.textPumpPromise) {
        try {
          await this.textPumpPromise;
        } catch (err) {
          this.options.logger.debug('[fish] cleanup error', err);
        }
      }
      // Bug 33: always remove BOTH abort listeners
      userSignal?.removeEventListener('abort', onAbortDuringConnect);
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

  speak(text: string, opts?: StreamOptions): AsyncGenerator<AudioChunk> {
    // Bug 36: empty text must not open a socket at all
    if (!text) return this.emptyStream();
    return this.stream(singleton(text), opts);
  }

  private async *emptyStream(): AsyncGenerator<AudioChunk> {
    // empty generator: yields nothing, returns immediately
  }

  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = this.doClose();
    try {
      await this.closingPromise;
    } finally {
      this.closingPromise = null;
    }
  }

  private async doClose(): Promise<void> {
    if (this.activeStream) {
      this.push({
        kind: 'error',
        error: new FishAudioAbortError('client closed during stream'),
      });
      try {
        await this.activeStream;
      } catch (err) {
        this.options.logger.debug('[fish] cleanup error', err);
      }
    }

    const sock = this.socket;
    if (!sock) return;
    this.socket = null;

    if (sock.isOpen()) {
      try {
        sock.sendMsgpack({ event: 'stop' });
      } catch (err) {
        this.options.logger.debug('[fish] cleanup error', err);
      }
      await Promise.race([
        sock.onceClosed(),
        new Promise<void>((resolve) =>
          setTimeout(resolve, CLOSE_FINISH_GRACE_MS),
        ),
      ]);
    }
    try {
      sock.close(1000, 'client close');
    } catch (err) {
      this.options.logger.debug('[fish] cleanup error', err);
    }
  }

  private push(item: QueueItem): void {
    if (this.pendingPull) {
      const { resolve } = this.pendingPull;
      this.pendingPull = null;
      resolve(item);
      return;
    }
    // Bug 3: enforce maxBufferedChunks backpressure
    if (
      item.kind === 'chunk' &&
      this.queue.length >= this.maxBufferedChunks
    ) {
      this.textPumpAbort?.abort();
      this.queue.push({
        kind: 'error',
        error: new FishAudioProtocolError(
          `audio buffer overflow: maxBufferedChunks (${this.maxBufferedChunks}) exceeded`,
        ),
      });
      return;
    }
    this.queue.push(item);
  }

  private pull(): Promise<QueueItem> {
    const first = this.queue.shift();
    if (first) return Promise.resolve(first);
    return new Promise<QueueItem>((resolve) => {
      this.pendingPull = { resolve };
    });
  }

  private handleBinaryMessage(buf: ArrayBuffer): void {
    if (!this.activeStream) {
      this.options.logger.debug(
        `[fish] ${buf.byteLength} bytes with no active stream — ignoring`,
      );
      return;
    }
    const parsed = decodeEvent(buf);
    if (!parsed) {
      this.options.logger.warn('[fish] non-msgpack or malformed binary frame');
      return;
    }

    switch (parsed['event']) {
      case 'audio': {
        const audioField = parsed['audio'];
        if (!(audioField instanceof Uint8Array)) {
          this.options.logger.warn(
            '[fish] audio field is not Uint8Array',
            typeof audioField,
          );
          return;
        }
        // Copy into an owned ArrayBuffer. Using `new ArrayBuffer + set` avoids
        // the SharedArrayBuffer union that `Uint8Array.buffer.slice()` returns.
        const ab = new ArrayBuffer(audioField.byteLength);
        new Uint8Array(ab).set(audioField);
        // Bug 19: warn on odd-byte PCM chunks
        if (this.options.format === 'pcm' && ab.byteLength % 2 !== 0) {
          this.options.logger.warn(
            `[fish] odd-byte PCM chunk (${ab.byteLength} bytes)`,
          );
        }
        this.push({
          kind: 'chunk',
          chunk: {
            data: ab,
            sequence: this.chunkSequence++,
            sizeBytes: ab.byteLength,
            timestamp: Date.now(),
          },
        });
        return;
      }
      case 'finish': {
        this.finishSeen = true;
        const reason = parsed['reason'];
        if (reason === 'error') {
          this.push({
            kind: 'error',
            error: new FishAudioProtocolError(
              'server finish reason=error',
            ),
          });
        } else {
          this.push({ kind: 'finished' });
        }
        return;
      }
      default:
        this.options.logger.debug(
          '[fish] ignoring unknown event',
          parsed['event'],
        );
        return;
    }
  }

  private handleClose(code: number, reason: string): void {
    // Bug 34: drop dead socket reference
    this.socket = null;
    if (!this.activeStream) return;
    if (this.finishSeen) return;
    this.push({
      kind: 'error',
      error: new FishAudioConnectionError(
        `socket closed before finish: ${code} ${reason}`,
      ),
    });
  }
}
