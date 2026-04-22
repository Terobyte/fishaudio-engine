import { describe, it, expect } from 'vitest';
import { encode, decodeEvent } from '../common/msgpack.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { FishAudioProtocolError } from '../common/types.js';

describe('msgpack', () => {
  it('Bug 44: encode() with a circular reference should throw FishAudioProtocolError', () => {
    const obj: Record<string, unknown> = {};
    obj['self'] = obj;

    expect(() => encode(obj)).toThrow(FishAudioProtocolError);
  });
});
