import {describe, expect, it} from 'vitest';
import {Utils} from '../../chrome/player/utils/Utils.mjs';

// An archive's raw entries are Uint8Array views (LargeBuffer.read): their size counts.
describe('Utils.getDataByteSize', () => {
  it('measures a string, an ArrayBuffer, a view of one and a Blob', () => {
    expect(Utils.getDataByteSize('abc')).toBe(6);
    expect(Utils.getDataByteSize(new ArrayBuffer(16))).toBe(16);
    expect(Utils.getDataByteSize(new Uint8Array(16))).toBe(16);
    expect(Utils.getDataByteSize(new Uint8Array(new ArrayBuffer(32), 8, 16))).toBe(16);
    expect(Utils.getDataByteSize(new Blob(['abcd']))).toBe(4);
  });
});
