import {describe, expect, it} from 'vitest';
import {LargeBuffer} from '../../chrome/player/modules/LargeBuffer.mjs';

// LargeBuffer streams a multi-gigabyte download as a sequence of smaller
// chunks, hiding the boundaries from callers. Off-by-one errors here corrupt
// playback in ways that look like network failures, so the reads that
// straddle a chunk boundary matter most.

const CHUNK = 4;

/** Builds a LargeBuffer over `count` chunks of CHUNK ascending bytes. */
async function makeBuffer(count, {onGet} = {}) {
  const chunks = [];
  for (let i = 0; i < count; i++) {
    chunks.push(new Uint8Array(
        Array.from({length: CHUNK}, (_, j) => i * CHUNK + j),
    ));
  }
  const buf = new LargeBuffer(count * CHUNK, count);
  await buf.initialize(async (i) => {
    onGet?.(i);
    return chunks[i];
  });
  return buf;
}

describe('read', () => {
  it('reads within a single chunk', async () => {
    const buf = await makeBuffer(3);
    expect([...await buf.read(3)]).toEqual([0, 1, 2]);
  });

  it('reads exactly one whole chunk', async () => {
    const buf = await makeBuffer(3);
    expect([...await buf.read(4)]).toEqual([0, 1, 2, 3]);
  });

  it('stitches a read that straddles a chunk boundary', async () => {
    const buf = await makeBuffer(3);
    expect([...await buf.read(6)]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('spans three chunks in one read', async () => {
    const buf = await makeBuffer(3);
    expect([...await buf.read(12)]).toEqual(
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
  });

  it('keeps sequential reads contiguous across boundaries', async () => {
    const buf = await makeBuffer(3);
    expect([...await buf.read(3)]).toEqual([0, 1, 2]);
    expect([...await buf.read(3)]).toEqual([3, 4, 5]);
    expect([...await buf.read(3)]).toEqual([6, 7, 8]);
    expect([...await buf.read(3)]).toEqual([9, 10, 11]);
  });

  it('throws rather than reading past the declared byte length', async () => {
    const buf = await makeBuffer(2);
    await expect(buf.read(9)).rejects.toThrow(/out of range/);
  });
});

describe('integer readers', () => {
  it('reads a byte', async () => {
    const buf = await makeBuffer(3);
    expect(await buf.uint8()).toBe(0);
    expect(await buf.uint8()).toBe(1);
  });

  it('reads uint16 big-endian', async () => {
    const buf = await makeBuffer(3);
    // bytes 0x00,0x01
    expect(await buf.uint16()).toBe(1);
    // bytes 0x02,0x03
    expect(await buf.uint16()).toBe(0x0203);
  });

  it('reads uint32 big-endian across a chunk boundary', async () => {
    const buf = await makeBuffer(3);
    expect(await buf.uint32()).toBe(0x00010203);
    // 0x04..0x07 begins in chunk 1 - proves the stitch feeds the shift math
    expect(await buf.uint32()).toBe(0x04050607);
  });
});

describe('prefetching', () => {
  it('requests the next chunk before it is needed', async () => {
    const requested = [];
    const buf = await makeBuffer(3, {onGet: (i) => requested.push(i)});
    // initialize() pulls chunk 0 and eagerly queues chunk 1.
    expect(requested).toEqual([0, 1]);
    await buf.read(CHUNK + 1); // crosses into chunk 1, queues chunk 2
    expect(requested).toEqual([0, 1, 2]);
  });

  it('does not request past the final chunk', async () => {
    const requested = [];
    const buf = await makeBuffer(2, {onGet: (i) => requested.push(i)});
    await buf.read(2 * CHUNK);
    expect(requested).toEqual([0, 1]);
  });
});
