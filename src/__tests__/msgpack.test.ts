import { describe, it, expect } from 'vitest';
import { encode, decodeEvent } from '../common/msgpack.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { FishAudioProtocolError } from '../common/types.js';

describe('msgpack', () => {
  it('encode() wraps circular-reference errors as FishAudioProtocolError preserving cause', () => {
    // Previous version of this test only checked that SOMETHING of type
    // FishAudioProtocolError was thrown. That passes even if the source
    // swallows the underlying @msgpack/msgpack error, which loses debug
    // context. Verify both the type AND that `cause` carries the original
    // error through.
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;

    let caught: unknown;
    try {
      encode(obj);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FishAudioProtocolError);
    expect((caught as Error).message).toMatch(/encode|msgpack/i);
    // The wrapper must preserve the underlying error as `cause`.
    expect((caught as Error).cause).toBeDefined();
    expect((caught as Error).cause).not.toBeInstanceOf(FishAudioProtocolError);
  });

  it('decodeEvent returns null for malformed binary (does not throw)', () => {
    // Sanity companion: decodeEvent's contract is null-on-failure; a test
    // with raw garbage ensures the null path works end-to-end.
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(decodeEvent(garbage)).toBeNull();
  });

  it('decodeEvent rejects objects with forbidden prototype-pollution keys', () => {
    // __proto__ inside an object literal sets the prototype, not an own
    // property, so msgpack would never see it as a key. We have to craft
    // the property explicitly so it serializes as a real map key that the
    // source's hasForbiddenKey() guard must reject.
    const obj: Record<string, unknown> = { event: 'audio' };
    Object.defineProperty(obj, '__proto__', {
      value: { evil: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const payload = msgpackEncode(obj);
    expect(decodeEvent(payload)).toBeNull();
  });
});
