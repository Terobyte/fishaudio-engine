import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import { FishAudioProtocolError } from './types.js';

export const encode = (obj: unknown): Uint8Array => {
  try {
    return msgpackEncode(obj);
  } catch (err) {
    throw new FishAudioProtocolError('Failed to encode msgpack payload', err);
  }
};

export interface DecodedEvent {
  event: string;
  [k: string]: unknown;
}

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const hasForbiddenKey = (obj: object): boolean => {
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  }
  return false;
};

export const decodeEvent = (
  buf: ArrayBuffer | Uint8Array,
): DecodedEvent | null => {
  let parsed: unknown;
  try {
    parsed = msgpackDecode(buf);
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  if (hasForbiddenKey(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['event'] !== 'string') return null;
  return obj as DecodedEvent;
};
