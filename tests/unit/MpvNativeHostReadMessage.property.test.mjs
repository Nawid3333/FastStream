import {PassThrough} from 'node:stream';

import {describe, expect, it} from 'vitest';
import fc from 'fast-check';

import {MaxMessageBytes, readMessage} from '../../native-host/faststream-mpv-host.mjs';

// readMessage is the native host's front door: every byte the extension sends
// goes through this framing, so a regression here silently loses or corrupts
// whole messages. These property tests drive it through a PassThrough stream.
// The host module is imported statically in exactly the way the existing
// MpvNativeHost.test.mjs imports it -- that is the established safe pattern
// for loading this module in vitest, and no host is ever started here: only
// readMessage runs, against local streams. Runs are kept at 100 where each run
// opens a stream (and can allocate a message-sized body buffer).

// Frames a payload the way the extension does: 4-byte little-endian length,
// then the bytes (host lines 177-184, mirrored).
function frameFor(payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function jsonFrame(value) {
  return frameFor(Buffer.from(JSON.stringify(value), 'utf8'));
}

// Cut a buffer into chunks at the generated points; a point outside the
// buffer is ignored, duplicates collapse, and the pieces always cover it all.
function splitIntoChunks(buffer, splitPoints) {
  const points = [...new Set(splitPoints.filter((p) => p > 0 && p < buffer.length))]
      .sort((a, b) => a - b);
  const chunks = [];
  let from = 0;
  for (const point of points) {
    chunks.push(buffer.subarray(from, point));
    from = point;
  }
  chunks.push(buffer.subarray(from));
  return chunks;
}

// readMessage is documented to resolve, never reject (host lines 197-257);
// this records both outcomes so the never-reject claim is checkable.
async function outcomeOf(reading) {
  try {
    return {resolved: await reading};
  } catch (error) {
    return {rejected: error};
  }
}

const invalidJson = fc.string({minLength: 1, maxLength: 32}).filter((body) => {
  try {
    JSON.parse(body);
    return false;
  } catch (error) {
    return true;
  }
});

describe('readMessage', () => {
  it('reads back exactly the JSON value framed with a 4-byte little-endian length prefix, whatever the chunk borders', async () => {
    // The payload the extension would parse is JSON.parse of the body bytes
    // (host line 240), so that is the value expected back.
    await fc.assert(fc.asyncProperty(
        fc.jsonValue(),
        fc.array(fc.nat({max: 4096}), {maxLength: 16}),
        async (value, splitPoints) => {
          const buffer = jsonFrame(value);
          const stream = new PassThrough();
          const pending = readMessage(stream);
          for (const chunk of splitIntoChunks(buffer, splitPoints)) {
            stream.write(chunk);
          }
          stream.end();
          const {resolved, rejected} = await outcomeOf(pending);
          expect(rejected).toBeUndefined();
          expect(resolved).toEqual(JSON.parse(buffer.subarray(4).toString('utf8')));
        },
    ), {numRuns: 100});
  });

  it('resolves null instead of rejecting when the length prefix is 0 or past MaxMessageBytes', () => {
    // Host lines 225-230: the length is checked as soon as the 4 header bytes
    // are in; the body is never even awaited.
    fc.assert(fc.asyncProperty(
        fc.constantFrom(0, MaxMessageBytes + 1, MaxMessageBytes * 2, 0xFFFFFFFF),
        async (length) => {
          const stream = new PassThrough();
          const pending = readMessage(stream);
          stream.write(frameFor(Buffer.alloc(0)).subarray(0, 4));
          // The length written above is `length`; rewrite it directly in case
          // frameFor was given a zero-payload frame.
          const header = Buffer.alloc(4);
          header.writeUInt32LE(length, 0);
          stream.write(header);
          stream.end();
          const {resolved, rejected} = await outcomeOf(pending);
          expect(rejected).toBeUndefined();
          expect(resolved).toBeNull();
        },
    ), {numRuns: 200});
  });

  it('resolves null when the body is cut short and the input then ends', async () => {
    // Host lines 250-252: an 'end' before the body completes resolves null.
    await fc.assert(fc.asyncProperty(
        fc.integer({min: 1, max: MaxMessageBytes}),
        fc.array(fc.nat({max: 255}), {maxLength: 63}),
        async (length, bytes) => {
          const prefix = Buffer.from(bytes.slice(0, length - 1)); // never completes the body
          const stream = new PassThrough();
          const pending = readMessage(stream);
          const header = Buffer.alloc(4);
          header.writeUInt32LE(length, 0);
          stream.write(header);
          if (prefix.length > 0) {
            stream.write(prefix);
          }
          stream.end();
          const {resolved, rejected} = await outcomeOf(pending);
          expect(rejected).toBeUndefined();
          expect(resolved).toBeNull();
        },
    ), {numRuns: 100});
  });

  it('resolves null when the body is not valid JSON', async () => {
    // Host lines 238-245: JSON.parse inside try/catch, null on failure.
    await fc.assert(fc.asyncProperty(invalidJson, async (body) => {
      const stream = new PassThrough();
      const pending = readMessage(stream);
      stream.write(frameFor(Buffer.from(body, 'utf8')));
      stream.end();
      const {resolved, rejected} = await outcomeOf(pending);
      expect(rejected).toBeUndefined();
      expect(resolved).toBeNull();
    }), {numRuns: 100});
  });

  it('resolves null instead of rejecting when the input stream errors, whatever partial bytes came first', async () => {
    // The host wires 'error' to the same null finish. At most 3 bytes are written,
    // less than the 4-byte header, so only the error can settle it. (A whole header
    // that announces 0 bytes or too many settles it with null at once.)
    await fc.assert(fc.asyncProperty(
        fc.array(fc.nat({max: 255}), {maxLength: 3}),
        async (prefixBytes) => {
          const stream = new PassThrough();
          const pending = readMessage(stream);
          const prefix = Buffer.from(prefixBytes);
          if (prefix.length > 0) {
            stream.write(prefix);
          }
          stream.destroy(new Error('input gone'));
          const {resolved, rejected} = await outcomeOf(pending);
          expect(rejected).toBeUndefined();
          expect(resolved).toBeNull();
        },
    ), {numRuns: 100});
  });
});
