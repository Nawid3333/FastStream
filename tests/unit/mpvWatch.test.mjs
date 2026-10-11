import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {MaxMessageBytes, readMessages, watchMpv} from '../../native-host/faststream-mpv-host.mjs';

// MPV autoplay (host 7, 2026-10-11): the host follows the mpv it started, over a port the
// extension keeps open, and tells it when a file ended or a key asked for the next or the
// previous episode. mpv's JSON IPC as measured with the pinned mpv (headless, keep-open):
// observe_property sends the current value at once; at a file's end eof-reached goes false
// -> true; a loadfile replace sends end-file "stop", eof-reached and path unavailable, the new
// path, then eof-reached false; "script-message faststream-next" arrives as client-message.

const servers = [];
const dirs = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

const pipeName = (tag) => {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\fs-watch-${tag}-${process.pid}-${Date.now()}`;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-watch-'));
  dirs.push(dir);
  return path.join(dir, 'sock');
};

/**
 * A fake mpv on a pipe: what the watcher asks for, and a way to send it mpv's events.
 * @param {string} pipe
 * @return {Promise<{commands: Array<Object>, event: function(Object): void, close: function(): void,
 *   connected: Promise<void>}>}
 */
async function fakeMpv(pipe) {
  const commands = [];
  let socket;
  let connectedResolve;
  const connected = new Promise((resolve) => {
    connectedResolve = resolve;
  });
  const server = net.createServer((s) => {
    socket = s;
    let buffer = '';
    s.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        commands.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    connectedResolve();
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(pipe, resolve));
  return {
    commands,
    connected,
    event: (object) => socket.write(JSON.stringify(object) + '\n'),
    raw: (bytes) => socket.write(bytes),
    close: () => socket.destroy(),
  };
}

/** Starts a watch and collects what it sends; settle() waits for the events to arrive. */
async function watching(tag) {
  const pipe = pipeName(tag);
  const mpv = await fakeMpv(pipe);
  const sent = [];
  const watch = watchMpv((message) => sent.push(message), {pipe});
  await mpv.connected;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  return {mpv, sent, watch, settle};
}

const pathEvent = (data) => ({event: 'property-change', id: 1, name: 'path', ...(data === undefined ? {} : {data})});
const eofEvent = (data) => ({event: 'property-change', id: 2, name: 'eof-reached', ...(data === undefined ? {} : {data})});

describe('watchMpv', () => {
  it('asks mpv for its file and its end, and says it watches', async () => {
    const {mpv, sent, watch} = await watching('start');
    expect(mpv.commands).toEqual([
      {command: ['observe_property', 1, 'path']},
      {command: ['observe_property', 2, 'eof-reached']},
    ]);
    expect(sent).toEqual([{type: 'watching'}]);
    watch.stop();
  });

  it('tells a file\'s end once, and not one that had ended before the watch began', async () => {
    const {mpv, sent, watch, settle} = await watching('end');
    // The watch began on a file that had ended already: its eof-reached is true at once.
    mpv.event(pathEvent('https://cdn.test/ep1.m3u8#fs-id=1'));
    mpv.event(eofEvent(true));
    await settle();
    expect(sent.filter((m) => m.type === 'ended')).toEqual([]);

    // The next episode loaded into the window (loadfile replace), played to its end.
    mpv.event({event: 'end-file', reason: 'stop'});
    mpv.event(eofEvent());
    mpv.event(pathEvent());
    mpv.event(pathEvent('https://cdn.test/ep2.m3u8#fs-id=2'));
    mpv.event(eofEvent(false));
    mpv.event(eofEvent(true));
    // Paused at the end and played again from there: the same file ends once.
    mpv.event(eofEvent(false));
    mpv.event(eofEvent(true));
    await settle();
    expect(sent.filter((m) => m.type === 'ended')).toEqual([{type: 'ended', path: 'https://cdn.test/ep2.m3u8#fs-id=2'}]);
    // The same file loaded again (the episode played anew) ends again.
    mpv.event(eofEvent());
    mpv.event(pathEvent());
    mpv.event(pathEvent('https://cdn.test/ep2.m3u8#fs-id=2'));
    mpv.event(eofEvent(false));
    mpv.event(eofEvent(true));
    await settle();
    expect(sent.filter((m) => m.type === 'ended')).toHaveLength(2);
    expect(sent.filter((m) => m.type === 'path').map((m) => m.path))
        .toEqual(['https://cdn.test/ep1.m3u8#fs-id=1', 'https://cdn.test/ep2.m3u8#fs-id=2', 'https://cdn.test/ep2.m3u8#fs-id=2']);
    watch.stop();
  });

  it('keeps a character mpv sends in two chunks whole', async () => {
    const {mpv, sent, watch, settle} = await watching('utf8');
    const path = 'https://cdn.test/' + String.fromCharCode(0xe9) + 'pisode-2.m3u8';
    const line = Buffer.from(JSON.stringify(pathEvent(path)) + '\n', 'utf8');
    // Cut inside the two bytes of the e with its accent.
    const cut = line.indexOf(0xc3) + 1;
    mpv.raw(line.subarray(0, cut));
    await settle();
    mpv.raw(line.subarray(cut));
    await settle();
    expect(sent.filter((m) => m.type === 'path').map((m) => m.path)).toEqual([path]);
    watch.stop();
  });

  it('tells the end of an mpv without keep-open (end-file eof)', async () => {
    const {mpv, sent, watch, settle} = await watching('eof');
    mpv.event(pathEvent('https://cdn.test/ep3.mp4'));
    mpv.event(eofEvent(false));
    mpv.event({event: 'end-file', reason: 'eof'});
    await settle();
    expect(sent.filter((m) => m.type === 'ended')).toEqual([{type: 'ended', path: 'https://cdn.test/ep3.mp4'}]);
    watch.stop();
  });

  it('passes on the keys for the next and the previous episode, and nothing else', async () => {
    const {mpv, sent, watch, settle} = await watching('keys');
    mpv.event({event: 'client-message', args: ['faststream-next']});
    mpv.event({event: 'client-message', args: ['faststream-previous']});
    mpv.event({event: 'client-message', args: ['something-else']});
    mpv.event({event: 'client-message'});
    await settle();
    expect(sent.filter((m) => m.type === 'request')).toEqual([
      {type: 'request', action: 'next'}, {type: 'request', action: 'previous'},
    ]);
    watch.stop();
  });

  it('shows a notice through notify.lua, or mpv\'s own text when this mpv has none', async () => {
    const {mpv, watch, settle} = await watching('notify');
    watch.notify('Next episode', 'loading');
    await settle();
    const notice = mpv.commands.find((c) => c.command[0] === 'script-message-to');
    expect(notice.command).toEqual(['script-message-to', 'notify', 'show', 'faststream', 'Next episode', 'loading']);
    mpv.event({request_id: notice.request_id, error: 'error running command'});
    await settle();
    expect(mpv.commands.at(-1)).toEqual({command: ['show-text', 'Next episode: loading', 4000]});
    watch.stop();
  });

  it('ends, saying why, when mpv quits', async () => {
    const {mpv, sent, watch, settle} = await watching('quit');
    mpv.close();
    expect(await watch.done).toBe('mpv closed');
    await settle();
    expect(sent.at(-1)).toEqual({type: 'closed', reason: 'mpv closed'});
  });

  it('ends at once without an mpv of ours', async () => {
    const sent = [];
    const watch = watchMpv((message) => sent.push(message), {pipe: pipeName('none')});
    expect(await watch.done).toBe('no mpv');
    expect(sent).toEqual([{type: 'closed', reason: 'no mpv'}]);
  });
});

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
