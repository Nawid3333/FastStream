import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import {spawn} from 'node:child_process';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  Capabilities,
  HostVersion,
  LaunchLockMs,
  MaxRelayLineBytes,
  MaxTargetBytes,
  PipeWaitMs,
  checkPlayMessage,
  freshMpvArgs,
  ipcPipeFor,
  launchLockFile,
  launchLockHeld,
  loadInto,
  mpvNotFoundError,
  playMpv,
  relayMpv,
  runIpc,
  takeLaunchLock,
  waitForPipe,
} from '../../native-host/faststream-mpv-host.mjs';

// Host 15, the thin helper: play (start or reuse mpv, then one loadfile over its pipe), ipc
// (allowlisted commands, one answer) and relay (mpv's lines out, allowlisted commands in, over a
// port). The transport and the launch are stand-ins where the test is about the decisions, and
// a fake mpv on a pipe of the test's own where it is about the bytes (never mpv's real pipe,
// which a running mpv may hold). The allowlist itself: mpvAllowlist.test.mjs.

const NL = String.fromCharCode(10);
const servers = [];
const sockets = [];
const dirs = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});

const scratch = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const pipeName = (tag) => {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\fs-thin-${tag}-${process.pid}-${Date.now()}`;
  }
  return path.join(scratch('fs-thin-'), 'sock');
};

/**
 * A fake mpv on a pipe: the requests it gets, a way to send it mpv's lines, and, with answer,
 * replies of its own to each request (answer returns the reply's fields, or null for none).
 * @param {string} pipe
 * @param {(request: Object) => ?Object} [answer]
 * @return {Promise<{requests: Array<Object>, connected: Promise<void>, event: function(Object): void,
 *   raw: function((string|Buffer)): void, close: function(): void}>}
 */
async function fakeMpv(pipe, answer = undefined) {
  const requests = [];
  let socket;
  let connectedResolve;
  const connected = new Promise((resolve) => {
    connectedResolve = resolve;
  });
  let closedResolve;
  // Its side of the pipe closed: every line sent to it before has been read.
  const closed = new Promise((resolve) => {
    closedResolve = resolve;
  });
  const server = net.createServer((s) => {
    socket = s;
    sockets.push(s);
    s.on('error', () => {});
    s.on('close', () => closedResolve());
    let buffer = '';
    s.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf(NL)) >= 0) {
        const request = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        requests.push(request);
        const reply = answer ? answer(request) : null;
        if (reply) s.write(JSON.stringify({...reply, request_id: request.request_id}) + NL);
      }
    });
    connectedResolve();
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(pipe, resolve));
  return {
    requests,
    connected,
    closed,
    event: (object) => socket.write(JSON.stringify(object) + NL),
    raw: (bytes) => socket.write(bytes),
    close: () => socket.destroy(),
  };
}

// What mpv answers: success, with its pid for get_property pid.
const mpvAnswers = (request) => Array.isArray(request.command) && request.command[0] === 'get_property' ?
  {error: 'success', data: request.command[1] === 'pid' ? 4242 : 1} : {error: 'success'};

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('freshMpvArgs', () => {
  it('is the pipe, idle once, an immediate window and no terminal: nothing else', () => {
    expect(freshMpvArgs('P', false)).toEqual(['--input-ipc-server=P', '--idle=once', '--force-window=immediate', '--no-terminal']);
    expect(freshMpvArgs('P', true)).toEqual(['--input-ipc-server=P', '--idle=once', '--force-window=immediate', '--no-terminal',
      '--fullscreen']);
  });
});

describe('waitForPipe', () => {
  it('asks for mpv\'s pid until it answers', async () => {
    const asked = [];
    let calls = 0;
    const ipcRequest = async (commands) => {
      asked.push(commands);
      return ++calls < 3 ? {ok: false, error: 'no mpv ipc'} : {ok: true, replies: [{request_id: 1, data: 7}]};
    };
    const slept = [];
    expect(await waitForPipe(ipcRequest, 15000, async (ms) => {
      slept.push(ms);
    }, () => 0)).toBe(true);
    expect(asked).toEqual(Array(3).fill([{command: ['get_property', 'pid']}]));
    expect(slept).toEqual([200, 200]);
  });

  it('gives up after the wait, asking no more after it', async () => {
    let time = 0;
    let calls = 0;
    const result = await waitForPipe(async () => {
      calls++;
      return {ok: false, busy: true};
    }, 1000, async (ms) => {
      time += ms;
    }, () => time);
    expect(result).toBe(false);
    // At 0, 200, ... 1000 ms: the last one at the deadline, none after it.
    expect(calls).toBe(6);
    expect(time).toBe(1000);
  });
});

describe('loadInto', () => {
  it('loads the target as given, with its options, in one named loadfile, then asks for the pid', async () => {
    let sent;
    const result = await loadInto('https://cdn.test/v.m3u8#fs-id=1', {'force-media-title': 't'}, true, async (commands) => {
      sent = commands;
      return {ok: true, replies: [{request_id: 1}, {request_id: 2, error: 'success'}, {request_id: 3, data: 9}]};
    });
    expect(result).toEqual({ok: true, pid: 9});
    expect(sent).toEqual([
      {command: ['set_property', 'fullscreen', true]},
      {command: {name: 'loadfile', url: 'https://cdn.test/v.m3u8#fs-id=1', flags: 'replace', options: {'force-media-title': 't'}}},
      {command: ['get_property', 'pid']},
    ]);
  });
});

describe('playMpv', () => {
  // Starts with "12", the start below: a random token held it in about one run in eight,
  // and the check that nothing the extension sent is on mpv's command line read the pipe.
  const token = '12' + crypto.randomBytes(15).toString('hex');
  const basePipe = `\\\\.\\pipe\\faststream-mpv-${token}`;
  const target = 'https://cdn.test/hls/v.m3u8?token=1#fs-content=anime&fs-id=0123456789abcdef&fs-page=https%3A%2F%2Fsite.test%2Fep3';
  /**
   * @param {Object} [fields] - The play message's other fields.
   * @return {Object} checkPlayMessage's play.
   */
  const play = (fields = {}) => {
    const checked = checkPlayMessage({type: 'play', target, title: 'Show - Episode 3', ...fields});
    expect(checked.ok).toBe(true);
    return checked.play;
  };

  /**
   * Stand-ins for the transport, the focus and the launch, around a model of which pipes have
   * an mpv: running holds them; start adds the pipe its arguments name (once its pipe is up).
   * @param {{running?: Array<string>, answer?: function(Object, string): ?Object, start?: Object,
   *   pipeUpAfter?: number}} [setup] - The pipes with an mpv at first, the replies, the launch's
   *   result and how many asks a new mpv's pipe takes to come up.
   * @return {Object} io for playMpv, and the record.
   */
  const stand = (setup = {}) => {
    const running = new Set(setup.running || []);
    const record = {asks: [], focused: [], started: [], stopped: [], slept: 0};
    let pipeUpIn = Infinity;
    let pendingPipe = null;
    return {
      record,
      platform: 'win32',
      ipcRequest: async (commands, timeoutMs, replyTimeoutMs, pipe) => {
        record.asks.push({pipe, commands: commands.map((c) => c.command)});
        if (pendingPipe === pipe && --pipeUpIn <= 0) running.add(pipe);
        if (!running.has(pipe)) return {ok: false, error: 'no mpv ipc'};
        if (setup.answer) {
          const result = setup.answer(commands, pipe);
          if (result) return result;
        }
        return {ok: true, replies: commands.map((c, i) => ({request_id: i + 1, ...mpvAnswers(c)}))};
      },
      focus: async (pid) => {
        record.focused.push(pid);
        return 'FOCUS=True FGOK=True';
      },
      start: async (mpvPath, args) => {
        record.started.push({mpvPath, args});
        pendingPipe = args[0].slice('--input-ipc-server='.length);
        pipeUpIn = setup.pipeUpAfter || 1;
        return setup.start || {ok: true, pid: 77, focus: 'True', foreground: 'True', tries: 1};
      },
      stop: (pid) => {
        record.stopped.push(pid);
      },
      sleep: async (ms) => {
        record.slept += ms;
      },
      now: () => record.slept,
    };
  };
  const loadfiles = (record) => record.asks.flatMap((ask) => ask.commands.filter((c) => !Array.isArray(c) && c.name === 'loadfile')
      .map((command) => ({pipe: ask.pipe, command})));

  beforeEach(() => {
    vi.stubEnv('FASTSTREAM_MPV_DEBUG', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads the stream into the mpv on the helper\'s pipe and raises its window, starting none', async () => {
    const io = stand({running: [basePipe]});
    expect(await playMpv('mpv.exe', play(), {ipcToken: token}, io))
        .toStrictEqual({ok: true, reused: true, focus: 'True', foreground: 'True'});
    expect(io.record.started).toEqual([]);
    expect(io.record.focused).toEqual([4242]);
    expect(loadfiles(io.record)).toEqual([{pipe: basePipe, command: {
      name: 'loadfile', url: target, flags: 'replace',
      options: {'http-header-fields': '', 'force-media-title': 'Show - Episode 3'},
    }}]);
  });

  it('sends the target byte for byte, as the extension built it', async () => {
    // No new URL(), no fragment tags of the helper's: the extension's are the only ones.
    const odd = 'https://cdn.test/a b/v.m3u8?x="1"#fs-id=abc&fs-quality=%5B%5D';
    const io = stand({running: [basePipe]});
    await playMpv('mpv.exe', play({target: odd}), {ipcToken: token}, io);
    expect(loadfiles(io.record)[0].command.url).toBe(odd);
  });

  it('makes the window fullscreen first when asked', async () => {
    const io = stand({running: [basePipe]});
    await playMpv('mpv.exe', play({fullscreen: true}), {ipcToken: token}, io);
    expect(io.record.asks[0].commands[0]).toEqual(['set_property', 'fullscreen', true]);
  });

  it('gives the headers, the start and the title with the file (per-file options)', async () => {
    const io = stand({running: [basePipe]});
    await playMpv('mpv.exe', play({start: '754.5',
      headers: ['Referer: https://site.test/a?b=1,2', 'User-Agent: UA (x, y)']}), {ipcToken: token}, io);
    expect(loadfiles(io.record)[0].command.options).toEqual({
      'http-header-fields': 'Referer: https://site.test/a?b=1\\,2,User-Agent: UA (x\\, y)',
      'force-media-title': 'Show - Episode 3',
      'start': '754.5',
    });
  });

  it('writes the subtitles into a folder of its own and passes them as sub-files', async () => {
    const base = scratch('fs-thin-subs-');
    const io = stand({running: [basePipe]});
    await playMpv('mpv.exe', play({subtitles: [{label: 'English', srt: 'one'}, {label: '../../evil', srt: 'two'}]}),
        {ipcToken: token}, {...io, subtitleBase: base});
    const files = loadfiles(io.record)[0].command.options['sub-files'].split(path.delimiter);
    expect(files).toHaveLength(2);
    expect(files.map((file) => path.basename(file))).toEqual(['1 English.srt', '2 .. .. evil.srt']);
    for (const file of files) expect(path.dirname(file).startsWith(base)).toBe(true);
    expect(files.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(['one', 'two']);
  });

  it('starts no second mpv when the one on the pipe is busy or refuses the stream', async () => {
    const busy = stand({running: [basePipe], answer: () => ({ok: false, busy: true, error: 'mpv did not answer'})});
    expect(await playMpv('mpv.exe', play(), {ipcToken: token}, busy))
        .toEqual({ok: false, error: 'mpv is busy and did not answer: try again in a moment'});
    expect(busy.record.started).toEqual([]);

    const refusing = stand({running: [basePipe], answer: (commands) => ({ok: true, replies: [
      {request_id: commands.length - 1, error: 'invalid parameter'}, {request_id: commands.length, data: 1}]})});
    expect(await playMpv('mpv.exe', play(), {ipcToken: token}, refusing))
        .toEqual({ok: false, error: 'the open mpv refused the stream (invalid parameter): close it and send again'});
    expect(refusing.record.started).toEqual([]);
  });

  it('starts one with helper-fixed arguments only when none runs, then loads the stream over its pipe', async () => {
    const io = stand();
    const message = play({start: '12', headers: ['Referer: https://site.test/'], fullscreen: false,
      subtitles: [{label: 'English', srt: 'one'}]});
    expect(await playMpv('C:/mpv/mpv.exe', message, {ipcToken: token}, {...io, subtitleBase: scratch('fs-thin-subs-')}))
        .toStrictEqual({ok: true, focus: 'True', foreground: 'True'});
    expect(io.record.started).toEqual([{mpvPath: 'C:/mpv/mpv.exe',
      args: [`--input-ipc-server=${basePipe}`, '--idle=once', '--force-window=immediate', '--no-terminal']}]);
    // Nothing the extension sent is on the command line (the pipe is the helper's own).
    const line = io.record.started[0].args.join(' ').split(basePipe).join('<pipe>');
    for (const part of ['cdn.test', 'fs-id', 'Show', 'site.test', 'Referer', '12', 'English', '.srt']) {
      expect(line).not.toContain(part);
    }
    // First the pipe (no mpv), then the start, then mpv's pid, then the stream.
    expect(io.record.asks.map((ask) => ask.commands.map((c) => Array.isArray(c) ? c.join(' ') : c.name)))
        .toEqual([['loadfile', 'get_property pid'], ['get_property pid'], ['loadfile', 'get_property pid']]);
    expect(loadfiles(io.record).map((load) => load.pipe)).toEqual([basePipe, basePipe]);
    expect(loadfiles(io.record)[1].command.options).toMatchObject({'start': '12', 'http-header-fields': 'Referer: https://site.test/'});
  });

  it('waits for another helper starting an mpv, then plays the stream in that one', async () => {
    // Two sends within one start (a second tab): each helper found no mpv on the pipe and
    // started one, and the second ran without the pipe for good. The second now waits for
    // the first helper to be done, so its own stream also comes after the first one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-launch-'));
    try {
      const lockFile = launchLockFile(basePipe, dir);
      const other = takeLaunchLock(lockFile);
      expect(other.taken).toBe(true);
      const io = stand();
      io.lockFile = lockFile;
      const sleep = io.sleep;
      io.sleep = async (ms) => {
        await sleep(ms);
        // The other helper's mpv is up and has its stream: it lets go.
        if (io.record.slept >= 2000) {
          io.record.running = true;
          other.release();
        }
      };
      const ipcRequest = io.ipcRequest;
      io.ipcRequest = (commands, timeoutMs, replyTimeoutMs, pipe) => io.record.running ?
        Promise.resolve({ok: true, replies: commands.map((c, i) => ({request_id: i + 1, error: 'success',
          data: c.command[0] === 'get_property' ? 4242 : null}))}) :
        ipcRequest(commands, timeoutMs, replyTimeoutMs, pipe);
      const result = await playMpv('mpv.exe', play(), {ipcToken: token}, io);
      expect(result.ok).toBe(true);
      expect(result.reused).toBe(true);
      expect(io.record.started).toEqual([]);
      expect(io.record.slept).toBeGreaterThanOrEqual(2000);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('lets go of the launch lock once its own start is done, or failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-launch-'));
    try {
      const io = stand({pipeUpAfter: 2});
      io.lockFile = launchLockFile(basePipe, dir);
      expect((await playMpv('mpv.exe', play(), {ipcToken: token}, io)).ok).toBe(true);
      expect(io.record.started).toHaveLength(1);
      expect(launchLockHeld(io.lockFile)).toBe(false);
      const failing = stand({start: {ok: false, error: 'no'}});
      failing.lockFile = io.lockFile;
      expect((await playMpv('mpv.exe', play(), {ipcToken: token}, failing)).ok).toBe(false);
      expect(launchLockHeld(io.lockFile)).toBe(false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  it('starts it fullscreen from the command line, not with a set_property after', async () => {
    const io = stand();
    await playMpv('mpv.exe', play({fullscreen: true}), {ipcToken: token}, io);
    expect(io.record.started[0].args.at(-1)).toBe('--fullscreen');
    expect(io.record.asks.at(-1).commands.some((c) => Array.isArray(c) && c[0] === 'set_property')).toBe(false);
  });

  it('waits for the new mpv\'s pipe, polling, and reports one that never answers', async () => {
    const io = stand({pipeUpAfter: 5});
    expect((await playMpv('mpv.exe', play(), {ipcToken: token}, io)).ok).toBe(true);
    expect(io.record.slept).toBe(4 * 200);

    const silent = stand({pipeUpAfter: Infinity});
    expect(await playMpv('mpv.exe', play(), {ipcToken: token}, silent))
        .toEqual({ok: false, error: 'mpv started, but did not answer on its pipe within 15 s'});
    expect(silent.record.slept).toBeLessThanOrEqual(PipeWaitMs);
    expect(silent.record.slept).toBeGreaterThan(PipeWaitMs - 1000);
    // The stream never went anywhere.
    expect(loadfiles(silent.record)).toHaveLength(1);
  });

  it('gives a new window a pipe of its own, and never asks the helper\'s pipe', async () => {
    const io = stand({running: [basePipe]});
    expect(await playMpv('mpv.exe', play({newWindow: true}), {ipcToken: token}, {...io, randomHex: () => '0a1b2c'}))
        .toStrictEqual({ok: true, focus: 'True', foreground: 'True'});
    expect(io.record.started[0].args[0]).toBe(`--input-ipc-server=${basePipe}-0a1b2c`);
    expect(io.record.asks.every((ask) => ask.pipe === `${basePipe}-0a1b2c`)).toBe(true);
    expect(loadfiles(io.record)).toHaveLength(1);

    const random = stand();
    await playMpv('mpv.exe', play({newWindow: true}), {ipcToken: token}, random);
    const pipe = random.record.started[0].args[0].slice('--input-ipc-server='.length);
    expect(pipe).toMatch(new RegExp(`^${basePipe.replace(/\\/g, '\\\\')}-[0-9a-f]{16}$`));
  });

  it('reports a new mpv that did not start, and one that refuses the stream', async () => {
    const failing = stand({start: {ok: false, error: 'mpv quit right after it started: check the mpv path'}});
    expect(await playMpv('mpv.exe', play(), {}, failing))
        .toEqual({ok: false, error: 'Could not start mpv: mpv quit right after it started: check the mpv path'});
    expect(await playMpv('/usr/bin/mpv', play(), {}, {...failing, platform: 'linux'}))
        .toEqual({ok: false, error: 'mpv quit right after it started: check the mpv path'});

    const refusing = stand({answer: (commands) => commands.some((c) => c.command.name === 'loadfile') ?
      {ok: true, replies: [{request_id: 1, error: 'unknown command'}, {request_id: 2, data: 1}]} : null});
    expect(await playMpv('mpv.exe', play(), {}, refusing))
        .toEqual({ok: false, error: 'the new mpv refused the stream (unknown command)'});
  });

  // --idle=once keeps an mpv that never loaded a file open for good: an empty window after
  // the error (glm's review of host 15).
  it('ends the mpv it started when its pipe stays silent or it refuses the stream, and only that one', async () => {
    const silent = stand({pipeUpAfter: Infinity});
    expect((await playMpv('mpv.exe', play(), {ipcToken: token}, silent)).ok).toBe(false);
    expect(silent.record.stopped).toEqual([77]);

    const refusing = stand({answer: (commands) => commands.some((c) => c.command.name === 'loadfile') ?
      {ok: true, replies: [{request_id: 1, error: 'unknown command'}, {request_id: 2, data: 1}]} : null});
    expect((await playMpv('mpv.exe', play(), {ipcToken: token}, refusing)).ok).toBe(false);
    expect(refusing.record.stopped).toEqual([77]);

    // A late answer: mpv may well have the stream and play it.
    const slow = stand({answer: (commands) => commands.some((c) => c.command.name === 'loadfile') ?
      {ok: true, replies: [{request_id: 2, data: 77}]} : null});
    expect(await playMpv('mpv.exe', play(), {ipcToken: token}, slow))
        .toEqual({ok: false, error: 'the new mpv did not take the stream: try again in a moment'});
    expect(slow.record.stopped).toEqual([]);

    // Nothing to end without a pid, and never the window on the pipe it found.
    const nameless = stand({pipeUpAfter: Infinity, start: {ok: true}});
    await playMpv('/usr/bin/mpv', play(), {ipcToken: token}, {...nameless, platform: 'linux'});
    expect(nameless.record.stopped).toEqual([]);
    for (const answer of [() => ({ok: false, busy: true, error: 'mpv did not answer'}),
      () => ({ok: true, replies: [{request_id: 1, error: 'unknown command'}, {request_id: 2, data: 4242}]})]) {
      const found = stand({running: [basePipe], answer});
      await playMpv('mpv.exe', play(), {ipcToken: token}, found);
      expect(found.record.stopped).toEqual([]);
    }
  });

  it('needs no mpv path to reuse a window, and says what to do without one', async () => {
    expect((await playMpv(null, play(), {ipcToken: token}, stand({running: [basePipe]}))).reused).toBe(true);
    const io = stand();
    // The legacy open's words: play takes the options page's path too.
    expect(await playMpv(null, play(), {ipcToken: token}, io)).toEqual({ok: false, error: mpvNotFoundError(undefined)});
    expect(await playMpv(null, {...play(), mpvPath: 'D:/Tools/mpv.exe'}, {ipcToken: token}, stand()))
        .toEqual({ok: false, error: mpvNotFoundError('D:/Tools/mpv.exe')});
    expect(io.record.started).toEqual([]);
  });

  it('raises no window off Windows', async () => {
    const reuse = stand({running: [ipcPipeFor({ipcToken: token}, 'linux')]});
    expect(await playMpv('/usr/bin/mpv', play(), {ipcToken: token}, {...reuse, platform: 'linux'}))
        .toStrictEqual({ok: true, reused: true});
    expect(reuse.record.focused).toEqual([]);
    const fresh = stand({start: {ok: true}});
    expect(await playMpv('/usr/bin/mpv', play(), {ipcToken: token}, {...fresh, platform: 'linux'})).toStrictEqual({ok: true});
  });

  // The same flow over real pipes: mpvIpcRequest and a fake mpv the stand-in launch puts on
  // the pipe its arguments name, as mpv would.
  describe('over a real pipe', () => {
    const realToken = crypto.randomBytes(16).toString('hex');
    beforeEach(() => {
      if (process.platform !== 'win32') vi.stubEnv('XDG_RUNTIME_DIR', scratch('fs-thin-run-'));
    });
    const launch = (record) => async (mpvPath, args) => {
      const pipe = args[0].slice('--input-ipc-server='.length);
      record.mpv = await fakeMpv(pipe, mpvAnswers);
      record.args = args;
      return {ok: true, pid: 4242};
    };

    it('starts mpv on the helper\'s pipe and loads the stream into it, then into the same window again', async () => {
      const record = {};
      const io = {platform: process.platform, start: launch(record), focus: async () => 'FOCUS=True FGOK=True'};
      const config = {ipcToken: realToken};
      const first = await playMpv('mpv', play(), config, io);
      expect(first.ok).toBe(true);
      expect(first.reused).toBeUndefined();
      expect(record.args[0]).toBe(`--input-ipc-server=${ipcPipeFor(config)}`);
      const loads = () => record.mpv.requests.filter((r) => r.command.name === 'loadfile');
      expect(loads()).toEqual([{request_id: 1, command: {name: 'loadfile', url: target, flags: 'replace',
        options: {'http-header-fields': '', 'force-media-title': 'Show - Episode 3'}}}]);

      // The next play goes into this one: no second start.
      const fakeOne = record.mpv;
      const second = await playMpv('mpv', play({title: 'Episode 4'}), config, io);
      expect(second.reused).toBe(true);
      expect(record.mpv).toBe(fakeOne);
      expect(loads().map((r) => r.command.options['force-media-title'])).toEqual(['Show - Episode 3', 'Episode 4']);
    });

    it('gives a new window a pipe of its own', async () => {
      const record = {};
      const config = {ipcToken: realToken};
      const result = await playMpv('mpv', play({newWindow: true}), config,
          {platform: process.platform, start: launch(record), focus: async () => 'FOCUS=True'});
      expect(result.ok).toBe(true);
      expect(record.args[0]).toMatch(/-[0-9a-f]{16}$/);
      expect(record.args[0]).not.toBe(`--input-ipc-server=${ipcPipeFor(config)}`);
      expect(record.mpv.requests.filter((r) => r.command.name === 'loadfile')).toHaveLength(1);
    });
  });
});

describe('runIpc', () => {
  it('sends allowlisted commands with the helper\'s own request ids and answers in their order', async () => {
    let sent;
    const result = await runIpc([['get_property', 'path'], ['set_property', 'pause', true], ['get_property', 'duration']], {
      ipcRequest: async (commands, timeoutMs, replyTimeoutMs, pipe) => {
        sent = {commands, pipe};
        // mpv answers in its own time; a reply's id says which command it answers.
        return {ok: true, replies: [
          {request_id: 3, error: 'success', data: 1440.5},
          {request_id: 1, error: 'success', data: 'https://cdn.test/v.m3u8'},
          {request_id: 2, error: 'success'},
        ]};
      },
      pipe: 'P',
    });
    expect(sent).toEqual({pipe: 'P', commands: [
      {command: ['get_property', 'path']}, {command: ['set_property', 'pause', true]}, {command: ['get_property', 'duration']}]});
    expect(result).toEqual({ok: true, replies: [
      {error: 'success', data: 'https://cdn.test/v.m3u8'}, {error: 'success', data: undefined}, {error: 'success', data: 1440.5}]});
  });

  it('refuses the whole message, sending nothing, when one command is not allowed', async () => {
    let calls = 0;
    const ipcRequest = async () => {
      calls++;
      return {ok: true, replies: []};
    };
    expect(await runIpc([['get_property', 'path'], ['run', 'calc.exe']], {ipcRequest}))
        .toEqual({ok: false, error: 'refused', index: 1, reason: 'command not allowed: run'});
    expect(await runIpc([{name: 'get_property', data: 'path'}], {ipcRequest}))
        .toEqual({ok: false, error: 'refused', index: 0, reason: 'not an array-form command'});
    expect(await runIpc([['get_property', 'options/sub-files']], {ipcRequest}))
        .toEqual({ok: false, error: 'refused', index: 0, reason: 'get_property: property not allowed'});
    expect(await runIpc(Array(33).fill(['get_property', 'pid']), {ipcRequest}))
        .toEqual({ok: false, error: 'refused', reason: 'commands is not a list of at most 32'});
    for (const commands of [undefined, null, 'get_property pid', {0: ['get_property', 'pid']}]) {
      expect((await runIpc(commands, {ipcRequest})).error).toBe('refused');
    }
    expect(calls).toBe(0);
    expect(await runIpc(Array(32).fill(['get_property', 'pid']), {ipcRequest})).toMatchObject({ok: true});
    expect(calls).toBe(1);
  });

  it('answers an empty list without asking mpv', async () => {
    expect(await runIpc([], {ipcRequest: async () => {
      throw new Error('asked');
    }})).toEqual({ok: true, replies: []});
  });

  it('says there is no mpv, or a busy one, as mpvIpcRequest does', async () => {
    expect(await runIpc([['get_property', 'pid']], {ipcRequest: async () => ({ok: false, error: 'no mpv ipc'})}))
        .toEqual({ok: false, error: 'no mpv ipc'});
    expect(await runIpc([['get_property', 'pid']], {ipcRequest: async () => ({ok: false, busy: true, error: 'mpv did not answer'})}))
        .toEqual({ok: false, error: 'mpv did not answer', busy: true});
  });

  it('marks a command mpv gave no answer to before the time ran out', async () => {
    expect(await runIpc([['get_property', 'pid'], ['get_property', 'path']], {
      ipcRequest: async () => ({ok: true, replies: [{request_id: 1, error: 'success', data: 5}]}),
    })).toEqual({ok: true, replies: [{error: 'success', data: 5}, {error: 'no reply', data: undefined}]});
  });

  it('talks to an mpv on a real pipe', async () => {
    const pipe = pipeName('ipc');
    const mpv = await fakeMpv(pipe, mpvAnswers);
    expect(await runIpc([['get_property', 'pid'], ['observe_property', 5, 'eof-reached']], {pipe}))
        .toEqual({ok: true, replies: [{error: 'success', data: 4242}, {error: 'success'}]});
    expect(mpv.requests).toEqual([
      {request_id: 1, command: ['get_property', 'pid']},
      {request_id: 2, command: ['observe_property', 5, 'eof-reached']},
    ]);
    expect(await runIpc([['get_property', 'pid']], {pipe: pipeName('ipc-none')})).toEqual({ok: false, error: 'no mpv ipc'});
  });
});

describe('relayMpv', () => {
  /**
   * Starts a relay to a fake mpv and collects what it sends the extension.
   * @param {string} tag
   * @param {Object} [options] - checkRelayMessage's.
   * @param {function(Object): ?Object} [answer] - The fake mpv's replies.
   */
  async function relaying(tag, options = {}, answer = undefined) {
    const pipe = pipeName(tag);
    const mpv = await fakeMpv(pipe, answer);
    const sent = [];
    const relay = relayMpv((message) => sent.push(message), options, {pipe});
    await mpv.connected;
    await settle();
    return {mpv, sent, relay};
  }
  const ofType = (sent, type) => sent.filter((m) => m.type === type);

  it('says it relays, and passes every line of mpv\'s on', async () => {
    const {mpv, sent, relay} = await relaying('lines');
    expect(sent).toEqual([{type: 'relaying'}]);
    mpv.event({event: 'property-change', id: 1, name: 'path', data: 'https://cdn.test/v.m3u8#fs-id=1'});
    mpv.event({event: 'end-file', reason: 'eof', playlist_entry_id: 1});
    mpv.event({event: 'client-message', args: ['faststream-next']});
    // A reply that is not to one of the relay's requests (an id it never used).
    mpv.event({request_id: 999, error: 'success'});
    mpv.raw('not json' + NL + NL + '5' + NL);
    await settle();
    expect(ofType(sent, 'mpv').map((m) => m.data)).toEqual([
      {event: 'property-change', id: 1, name: 'path', data: 'https://cdn.test/v.m3u8#fs-id=1'},
      {event: 'end-file', reason: 'eof', playlist_entry_id: 1},
      {event: 'client-message', args: ['faststream-next']},
      {request_id: 999, error: 'success'},
    ]);
    relay.stop();
  });

  it('keeps a character mpv sends in two chunks whole', async () => {
    const {mpv, sent, relay} = await relaying('utf8');
    const title = 'Caf' + String.fromCharCode(0xE9);
    const line = Buffer.from(JSON.stringify({event: 'property-change', name: 'media-title', data: title}) + NL, 'utf8');
    const cut = line.indexOf(0xC3) + 1;
    mpv.raw(line.subarray(0, cut));
    await settle();
    mpv.raw(line.subarray(cut));
    await settle();
    expect(ofType(sent, 'mpv').map((m) => m.data.data)).toEqual([title]);
    relay.stop();
  });

  it('writes the extension\'s commands with ids of its own and answers the ones the extension numbered', async () => {
    const {mpv, sent, relay} = await relaying('commands', {}, mpvAnswers);
    relay.receive({type: 'mpv', command: ['observe_property', 1, 'eof-reached'], id: 1});
    relay.receive({type: 'mpv', command: ['get_property', 'pid'], id: 1});
    relay.receive({type: 'mpv', command: ['set_property', 'user-data/faststream/connected', true]});
    relay.receive({type: 'mpv', command: ['get_property', 'time-remaining'], id: 77});
    await settle();
    // The helper numbers the requests: the extension's ids (1 twice) never reach mpv.
    expect(mpv.requests).toEqual([
      {command: ['observe_property', 1, 'eof-reached'], request_id: 1},
      {command: ['get_property', 'pid'], request_id: 2},
      {command: ['set_property', 'user-data/faststream/connected', true], request_id: 3},
      {command: ['get_property', 'time-remaining'], request_id: 4},
    ]);
    expect(ofType(sent, 'mpv-reply')).toEqual([
      {type: 'mpv-reply', id: 1, error: 'success'},
      {type: 'mpv-reply', id: 1, error: 'success', data: 4242},
      {type: 'mpv-reply', id: 77, error: 'success', data: 1},
    ].map((m) => ({data: undefined, ...m})));
    // The replies go as mpv-reply, or nowhere for the command without an id: never as mpv lines.
    expect(ofType(sent, 'mpv')).toEqual([]);
    relay.stop();
  });

  it('refuses what the allowlist refuses, writing nothing to mpv', async () => {
    const {mpv, sent, relay} = await relaying('refused');
    relay.receive({type: 'mpv', command: ['run', 'calc.exe'], id: 3});
    relay.receive({type: 'mpv', command: ['set_property', 'options/script-opts', 'x']});
    relay.receive({type: 'mpv', command: {name: 'loadfile', url: 'file:///C:/x'}, id: 4});
    relay.receive({type: 'mpv', command: ['get_property', 'pid'], id: 'x'});
    relay.receive({type: 'mpv', command: ['get_property', 'pid'], id: 1.5});
    relay.receive({type: 'notify', title: 'x'});
    relay.receive(null);
    await settle();
    expect(mpv.requests).toEqual([]);
    expect(ofType(sent, 'mpv-refused')).toEqual([
      {type: 'mpv-refused', id: 3, reason: 'command not allowed: run'},
      {type: 'mpv-refused', reason: 'set_property: property not allowed'},
      {type: 'mpv-refused', id: 4, reason: 'not an array-form command'},
      {type: 'mpv-refused', reason: 'the id is not an integer'},
      {type: 'mpv-refused', reason: 'the id is not an integer'},
      {type: 'mpv-refused', reason: 'unknown message'},
    ]);
    relay.stop();
  });

  it('beats on its property at once and every everyMs, a rising number, and keeps the replies to itself', async () => {
    const {mpv, sent, relay} = await relaying('heartbeat',
        {heartbeat: {property: 'user-data/faststream/heartbeat', everyMs: 40}}, mpvAnswers);
    await settle(150);
    const beats = () => mpv.requests.filter((r) => r.command[1] === 'user-data/faststream/heartbeat').map((r) => r.command[2]);
    const seen = beats();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(mpv.requests[0].command[0]).toBe('set_property');
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[0]).toBeGreaterThan(Date.now() - 60000);
    expect(sent.filter((m) => m.type !== 'relaying')).toEqual([]);
    relay.stop();
    await relay.done;
    // A beat written just before the stop could still be on its way (CI Windows,
    // 2026-10-14): count once the fake mpv has read everything, then see none follow.
    await mpv.closed;
    const after = beats().length;
    await settle(150);
    expect(beats().length).toBe(after);
  });

  it('drops a line over MaxRelayLineBytes and goes on with the next', async () => {
    const {mpv, sent, relay} = await relaying('big');
    mpv.event({event: 'property-change', name: 'path', data: 'x'.repeat(MaxRelayLineBytes)});
    mpv.event({event: 'property-change', name: 'path', data: 'https://cdn.test/v.m3u8'});
    // One that comes in pieces, never all of it in the relay's buffer.
    const piece = 'y'.repeat(100 * 1024);
    mpv.raw('{"event":"property-change","name":"path","data":"');
    for (let i = 0; i <= MaxRelayLineBytes / piece.length; i++) {
      await settle(10);
      mpv.raw(piece);
    }
    mpv.raw('"}' + NL + JSON.stringify({event: 'idle'}) + NL);
    // Just under the cap passes.
    const fits = JSON.stringify({event: 'x', data: ''}).length;
    mpv.event({event: 'x', data: 'z'.repeat(MaxRelayLineBytes - fits)});
    await settle(150);
    expect(ofType(sent, 'mpv').map((m) => m.data.data === undefined ? m.data.event : String(m.data.data).slice(0, 30)))
        .toEqual(['https://cdn.test/v.m3u8', 'idle', 'z'.repeat(30)]);
    relay.stop();
  });

  it('still answers a request whose reply was too large to pass on', async () => {
    const {mpv, sent, relay} = await relaying('big-reply');
    relay.receive({type: 'mpv', command: ['get_property', 'path'], id: 9});
    await settle();
    // As mpv writes a reply: data first, then the request id and the error.
    mpv.raw('{"data":"' + 'x'.repeat(MaxRelayLineBytes) + '","request_id":' + mpv.requests[0].request_id + ',"error":"success"}' + NL);
    relay.receive({type: 'mpv', command: ['get_property', 'path'], id: 10});
    await settle();
    mpv.raw('{"data":"');
    for (let i = 0; i <= MaxRelayLineBytes / (100 * 1024); i++) {
      await settle(10);
      mpv.raw('y'.repeat(100 * 1024));
    }
    mpv.raw('","request_id":' + mpv.requests[1].request_id + ',"error":"success"}' + NL);
    await settle(150);
    expect(ofType(sent, 'mpv-reply')).toEqual([
      {type: 'mpv-reply', id: 9, error: 'reply too large', data: undefined},
      {type: 'mpv-reply', id: 10, error: 'reply too large', data: undefined},
    ]);
    expect(ofType(sent, 'mpv')).toEqual([]);
    relay.stop();
  });

  it('passes on the path event of the longest stream play takes', async () => {
    // The relay dropped mpv's lines over 256 KB, while play takes a target up to 512 KB
    // (MaxTargetBytes): the path event of a longer one never arrived, and the extension's
    // end detection over the relay never saw that stream's path.
    const {mpv, sent, relay} = await relaying('longest');
    const head = 'https://cdn.test/v.m3u8#fs-quality=';
    const target = head + 'a'.repeat(MaxTargetBytes - head.length);
    expect(checkPlayMessage({target}).ok).toBe(true);
    mpv.event({event: 'property-change', id: 12345, name: 'path', data: target});
    await settle(150);
    expect(ofType(sent, 'mpv').map((m) => m.data.data)).toEqual([target]);
    relay.stop();
  });

  it('writes onStop when the extension lets go, then closes', async () => {
    const onStop = [['set_property', 'user-data/faststream/connected', false], ['script-message-to', 'notify', 'hide', 'faststream']];
    const {mpv, sent, relay} = await relaying('stop', {onStop});
    relay.stop();
    expect(await relay.done).toBe('stopped');
    await settle();
    expect(mpv.requests.map((r) => r.command)).toEqual(onStop);
    expect(sent.at(-1)).toEqual({type: 'closed', reason: 'stopped'});
    // Once only, and nothing after.
    relay.stop();
    relay.receive({type: 'mpv', command: ['get_property', 'pid'], id: 1});
    await settle();
    expect(mpv.requests).toHaveLength(2);
    expect(ofType(sent, 'closed')).toHaveLength(1);
  });

  it('does not write onStop when mpv goes', async () => {
    const {mpv, sent, relay} = await relaying('quit', {onStop: [['set_property', 'user-data/faststream/connected', false]]});
    mpv.close();
    expect(await relay.done).toBe('mpv closed');
    await settle();
    expect(mpv.requests).toEqual([]);
    expect(sent.at(-1)).toEqual({type: 'closed', reason: 'mpv closed'});
  });

  it('ends at once without an mpv', async () => {
    const sent = [];
    const relay = relayMpv((message) => sent.push(message), {onStop: [['set_property', 'pause', true]]}, {pipe: pipeName('none')});
    expect(await relay.done).toBe('no mpv');
    expect(sent).toEqual([{type: 'closed', reason: 'no mpv'}]);
  });
});

// The host as Firefox runs it: one framed message in, the framed answers out. Only refused
// messages here: an allowed one would talk to the pipe config.json names.
describe('the host process (host 15)', () => {
  const hostFile = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../native-host/faststream-mpv-host.mjs');

  /**
   * @param {Object} message
   * @return {Promise<Object>} The first answer.
   */
  function askHost(message) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hostFile], {stdio: ['pipe', 'pipe', 'inherit']});
      const timer = setTimeout(() => child.kill(), 15000);
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const out = Buffer.concat(chunks);
          resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
      const payload = Buffer.from(JSON.stringify(message), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(payload.length, 0);
      child.stdin.end(Buffer.concat([header, payload]));
    });
  }
  const versioned = {hostVersion: HostVersion, capabilities: [...Capabilities]};

  it('refuses a play of anything but an http(s) stream, before it looks for mpv', async () => {
    expect(await askHost({type: 'play', target: 'file:///C:/Windows/win.ini'}))
        .toEqual({ok: false, error: 'mpv is only given http(s) streams', ...versioned});
    expect(await askHost({type: 'play', target: 'https://cdn.test/v.m3u8', headers: ['Cookie: a=b']}))
        .toEqual({ok: false, error: 'a header is not Referer, Origin or User-Agent with a printable ASCII value', ...versioned});
  }, 30000);

  it('refuses an ipc message with a command the allowlist refuses', async () => {
    expect(await askHost({type: 'ipc', commands: [['get_property', 'pid'], ['run', 'calc.exe']]}))
        .toEqual({ok: false, error: 'refused', index: 1, reason: 'command not allowed: run', ...versioned});
  }, 30000);

  it('closes a relay whose options are refused', async () => {
    expect(await askHost({type: 'relay', onStop: [['load-script', 'x.lua']]}))
        .toEqual({type: 'closed', reason: 'refused', error: 'onStop command 0 refused: command not allowed: load-script', ...versioned});
  }, 30000);
});

describe('the launch lock', () => {
  it('is one helper’s at a time, and holds no longer once let go, old, or its process gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-launch-'));
    try {
      const file = launchLockFile('test-pipe', dir);
      const first = takeLaunchLock(file);
      expect(first.taken).toBe(true);
      expect(takeLaunchLock(file).taken).toBe(false);
      expect(launchLockHeld(file)).toBe(true);
      first.release();
      expect(launchLockHeld(file)).toBe(false);
      // Handed to the mpv started: held while that mpv runs, not once it is gone.
      const second = takeLaunchLock(file);
      second.hand(4242);
      expect(launchLockHeld(file, {alive: (pid) => pid === 4242})).toBe(true);
      expect(launchLockHeld(file, {alive: () => false})).toBe(false);
      expect(takeLaunchLock(file, {alive: () => false}).taken).toBe(true);
      // Left by a helper that died before it let go: old after LaunchLockMs.
      expect(launchLockHeld(file, {now: () => Date.now() + LaunchLockMs + 1000})).toBe(false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
