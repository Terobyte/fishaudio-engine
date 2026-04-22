export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'error';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export type FishAudioErrorKind = 'auth' | 'connection' | 'protocol' | 'abort';

export class FishAudioEngineError extends Error {
  override name = 'FishAudioEngineError';
  readonly kind: FishAudioErrorKind = 'protocol';
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    Object.setPrototypeOf(this, new.target.prototype);
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
