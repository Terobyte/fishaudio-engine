export {
  FishAudioEngineError,
  FishAudioAuthError,
  FishAudioConnectionError,
  FishAudioProtocolError,
  FishAudioAbortError,
  silentLogger,
  type ConnectionState,
  type FishAudioErrorKind,
  type Logger,
} from './types.js';
export { FishAudioWebSocket } from './websocket.js';
export type { WebSocketWrapperOptions } from './websocket.js';
export { encode, decodeEvent } from './msgpack.js';
export type { DecodedEvent } from './msgpack.js';
