import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {MaxMessageBytes, readMessage, readMessages, watchMpv} from '../../native-host/faststream-mpv-host.mjs';

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
async function watching(tag, heartbeatMs = undefined) {
  const pipe = pipeName(tag);
  const mpv = await fakeMpv(pipe);
  const sent = [];
  const watch = watchMpv((message) => sent.push(message), {pipe, heartbeatMs});
  await mpv.connected;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  return {mpv, sent, watch, settle};
}

const pathEvent = (data) => ({event: 'property-change', id: 1, name: 'path', ...(data === undefined ? {} : {data})});
const eofEvent = (data) => ({event: 'property-change', id: 2, name: 'eof-reached', ...(data === undefined ? {} : {data})});

describe('watchMpv', () => {
  it('asks mpv for its file and its end, marks the window followed, and says it watches', async () => {
    const {mpv, sent, watch} = await watching('start');
    expect(mpv.commands).toEqual([
      {command: ['observe_property', 1, 'path']},
      {command: ['observe_property', 2, 'eof-reached']},
      // Host 14: a pause at the end is an end too.
      {command: ['observe_property', 3, 'pause']},
      // Host 9: the mpv setup's episode buttons show while this holds.
      {command: ['set_property', 'user-data/faststream/connected', true]},
      // Host 10: and while this keeps changing.
      {command: ['set_property', 'user-data/faststream/heartbeat', expect.any(Number)]},
    ]);
    expect(sent).toEqual([{type: 'watching'}]);
    watch.stop();
  });

  it('beats while it follows the window, a new value each time, and stops when it lets go', async () => {
    const {mpv, watch} = await watching('heartbeat', 40);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const beats = () => mpv.commands
        .filter((c) => c.command[0] === 'set_property' && c.command[1] === 'user-data/faststream/heartbeat')
        .map((c) => c.command[2]);
    const seen = beats();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // Rising: a host started after a killed one is a change mpv hears at once.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[0]).toBeGreaterThan(Date.now() - 60000);
    watch.stop();
    // A beat written just before the stop may still be on its way (seen under load).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = beats().length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(beats().length).toBe(after);
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

  // Host 14: a skip past the end of an HLS stream with discontinuities stopped mpv at the
  // end, paused (keep-open), with eof-reached never set (measured with the pinned mpv,
  // 2026-10-13): MPV autoplay never started, until the user went back and played the last
  // seconds again (his report, 2026-10-13). An end is also mpv at the last half second of
  // its file when it pauses there or a seek lands there.
  describe('an end mpv does not mark (eof-reached unset)', () => {
    const pauseEvent = (data) => ({event: 'property-change', id: 3, name: 'pause', data});
    /** Answers the watch's question for the time left with this many seconds. */
    const answerTimeLeft = async (mpv, settle, seconds) => {
      await settle();
      const asks = mpv.commands.filter((c) => c.command[0] === 'get_property' && c.command[1] === 'time-remaining');
      expect(asks.length).toBeGreaterThan(0);
      mpv.event({request_id: asks.at(-1).request_id, error: 'success', data: seconds});
      await settle();
    };

    it('tells it when mpv pauses at the end', async () => {
      const {mpv, sent, watch, settle} = await watching('end-paused');
      mpv.event(pathEvent('https://cdn.test/ep4.m3u8'));
      mpv.event(eofEvent(false));
      mpv.event(pauseEvent(false));
      mpv.event(pauseEvent(true));
      await answerTimeLeft(mpv, settle, 0);
      expect(sent.filter((m) => m.type === 'ended')).toEqual([{type: 'ended', path: 'https://cdn.test/ep4.m3u8'}]);
      watch.stop();
    });

    it('tells it when a seek lands at the end, paused or not', async () => {
      const {mpv, sent, watch, settle} = await watching('end-seek');
      mpv.event(pathEvent('https://cdn.test/ep5.m3u8'));
      mpv.event(eofEvent(false));
      mpv.event(pauseEvent(false));
      mpv.event({event: 'playback-restart'});
      await answerTimeLeft(mpv, settle, 0.3);
      expect(sent.filter((m) => m.type === 'ended')).toEqual([{type: 'ended', path: 'https://cdn.test/ep5.m3u8'}]);
      watch.stop();
    });

    it('does not for a pause or a seek elsewhere in the file', async () => {
      const {mpv, sent, watch, settle} = await watching('end-not');
      mpv.event(pathEvent('https://cdn.test/ep6.m3u8'));
      mpv.event(eofEvent(false));
      mpv.event(pauseEvent(false));
      mpv.event(pauseEvent(true));
      await answerTimeLeft(mpv, settle, 600);
      mpv.event({event: 'playback-restart'});
      await answerTimeLeft(mpv, settle, 2);
      expect(sent.filter((m) => m.type === 'ended')).toEqual([]);
      watch.stop();
    });

    it('does not ask about the pause mpv was in when the watch began', async () => {
      // A file that had ended before the watch began, paused at its end, is no end now.
      const {mpv, watch, settle} = await watching('end-initial');
      mpv.event(pathEvent('https://cdn.test/ep7.m3u8'));
      mpv.event(eofEvent(false));
      mpv.event(pauseEvent(true));
      await settle();
      expect(mpv.commands.filter((c) => c.command[1] === 'time-remaining')).toEqual([]);
      watch.stop();
    });
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
    // Host 9: the autoplay button.
    mpv.event({event: 'client-message', args: ['faststream-autoplay']});
    await settle();
    expect(sent.filter((m) => m.type === 'request').at(-1)).toEqual({type: 'request', action: 'autoplay'});
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

  it('says how long a notice stays, and takes it down early (host 11)', async () => {
    // Before, every notice went after notify.lua's 2 s: "next episode in 5 s" was gone 3 s
    // before the episode came.
    const {mpv, watch, settle} = await watching('seconds');
    watch.notify('Autoplay', 'next episode in 5 s', 5);
    watch.notify('Next video', 'none found', 99);
    watch.notify('Next video', 'loading', 6.04);
    for (const bad of [0, -1, NaN, Infinity, '5', null, 0.01]) watch.notify('x', '', bad);
    watch.hide();
    await settle();
    const sent = mpv.commands.filter((c) => c.command[0] === 'script-message-to');
    expect(sent.map((c) => c.command.slice(2))).toEqual([
      ['show', 'faststream', 'Autoplay', 'next episode in 5 s', '5'],
      ['show', 'faststream', 'Next video', 'none found', '60'],
      ['show', 'faststream', 'Next video', 'loading', '6'],
      ...Array(7).fill(['show', 'faststream', 'x', '']),
      ['hide', 'faststream'],
    ]);
    // The hide has no answer to wait for: an mpv without notify.lua has nothing to take down.
    expect(sent.at(-1).request_id).toBeUndefined();
    // Without notify.lua: mpv's own text, for as long.
    mpv.event({request_id: sent[0].request_id, error: 'error running command'});
    await settle();
    expect(mpv.commands.at(-1)).toEqual({command: ['show-text', 'Autoplay: next episode in 5 s', 5000]});
    watch.stop();
  });

  it('tells mpv\'s autoplay button the setting, and only a yes or a no', async () => {
    const {mpv, watch, settle} = await watching('state');
    watch.state({autoplay: false});
    watch.state({autoplay: 'yes'});
    watch.state({});
    watch.state({autoplay: true});
    await settle();
    expect(mpv.commands.slice(5)).toEqual([
      {command: ['set_property', 'user-data/faststream/autoplay', false]},
      {command: ['set_property', 'user-data/faststream/autoplay', true]},
    ]);
    watch.stop();
  });

  it('unmarks the window when the extension lets go, before it closes the connection', async () => {
    const {mpv, sent, watch, settle} = await watching('letgo');
    watch.stop();
    expect(await watch.done).toBe('stopped');
    await settle();
    expect(mpv.commands.at(-1)).toEqual({command: ['set_property', 'user-data/faststream/connected', false]});
    expect(sent.at(-1)).toEqual({type: 'closed', reason: 'stopped'});
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

  it('takes the frames that came in the same chunk as the first message (glm\'s review)', async () => {
    // The extension posts 'watch' and may post a state at once: both in one chunk of stdin,
    // where readMessage read the first and dropped the rest.
    const input = new PassThrough();
    input.write(Buffer.concat([frame({type: 'watch'}), frame({type: 'state', autoplay: true}), frame({type: 'notify', title: 'x'}).subarray(0, 5)]));
    expect(await readMessage(input)).toEqual({type: 'watch'});
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
