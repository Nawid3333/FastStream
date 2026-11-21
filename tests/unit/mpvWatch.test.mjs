import {PassThrough} from 'node:stream';
import {describe, expect, it} from 'vitest';
import {MaxMessageBytes, readMessage, readMessages} from '../../native-host/faststream-mpv-host.mjs';

// The helper's reading of native-messaging frames on a port the extension keeps open (relay):
// several frames in one chunk, one frame over several, and a frame too big for any message.

describe('readMessages', () => {
  const frame = (object) => {
    const body = Buffer.from(JSON.stringify(object), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
  };

  it('reads frames split across chunks and several in one chunk, until the stream ends', () => {
    const input = new PassThrough();
    const messages = [];
    let ended = 0;
    readMessages(input, (message) => messages.push(message), () => ended++);
    const one = frame({type: 'notify', title: 'a'});
    input.write(one.subarray(0, 3));
    input.write(one.subarray(3));
    input.write(Buffer.concat([frame({type: 'notify', title: 'b'}), frame({type: 'notify', title: 'c'})]));
    input.end();
    return new Promise((resolve) => setImmediate(() => {
      expect(messages.map((m) => m.title)).toEqual(['a', 'b', 'c']);
      expect(ended).toBe(1);
      resolve();
    }));
  });

  it('takes the frames that came in the same chunk as the first message (glm\'s review)', async () => {
    // The extension posts 'relay' and may post a command at once: both in one chunk of stdin,
    // where readMessage read the first and dropped the rest.
    const input = new PassThrough();
    input.write(Buffer.concat([frame({type: 'relay'}), frame({type: 'state', autoplay: true}), frame({type: 'notify', title: 'x'}).subarray(0, 5)]));
    expect(await readMessage(input)).toEqual({type: 'relay'});
    const messages = [];
    readMessages(input, (message) => messages.push(message), () => {});
    expect(messages).toEqual([{type: 'state', autoplay: true}]);
    input.write(frame({type: 'notify', title: 'x'}).subarray(5));
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages).toEqual([{type: 'state', autoplay: true}, {type: 'notify', title: 'x'}]);
  });

  it('stops at a frame bigger than any message', () => {
    const input = new PassThrough();
    let ended = 0;
    readMessages(input, () => {}, () => ended++);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MaxMessageBytes + 1, 0);
    input.write(header);
    return new Promise((resolve) => setImmediate(() => {
      expect(ended).toBe(1);
      resolve();
    }));
  });
});
