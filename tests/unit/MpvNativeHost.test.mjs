import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MaxLogBytes, PrivateSubtitleDirPrefix, SubtitleDirPrefix, debugFromEnvironment, debugLog, ipcPipeFor, launchDirect,
  loadInto, loggedMessage, mpvIpcRequest, mpvNotFoundError, perFileOptions, removeOldSubtitleDirs, subtitlesOf,
  writeSubtitleFiles} from '../../native-host/faststream-mpv-host.mjs';

// loadInto decides from mpvIpcRequest's replies whether loading into a running mpv worked; injected
// (no pipes on Linux CI).
//
// mpvIpcRequest resolves ok on its timeout once any reply came: a missing loadfile reply is not
// success.

const message = {url: 'https://example.com/video.m3u8'};
const headerFields = ['Referer: https://example.com/'];
const title = 'example.com';

const loadfileOf = (commands) => commands.find((c) => !Array.isArray(c.command) && c.command.name === 'loadfile').command;

describe('loadInto a running mpv', () => {
  it('succeeds when every reply, including loadfile, comes back', async () => {
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: commands.length - 1, error: 'success'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadInto(message.url, perFileOptions(headerFields, title), false, ipcRequest);
    expect(result).toEqual({ok: true, pid: 4242});
  });

  it('is refused, not "no mpv", when the pipe answers but loadfile is refused', async () => {
    // Ours answered, so it runs: a fresh start would be a second mpv on its pipe.
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: commands.length - 1, error: 'invalid parameter'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadInto(message.url, perFileOptions(headerFields, title), false, ipcRequest);
    expect(result).toEqual({ok: false, refused: true, error: 'invalid parameter'});
  });

  it('is busy, not phantom-successful, when only the fullscreen reply came back', async () => {
    // Ours answered but not to loadfile: not success, and not "no mpv" either.
    const ipcRequest = async () => ({ok: true, replies: [{request_id: 1}]});
    const result = await loadInto(message.url, perFileOptions(headerFields, title), true, ipcRequest);
    expect(result).toEqual({ok: false, busy: true});
  });

  it('fails when no instance of ours answers at all', async () => {
    const ipcRequest = async () => ({ok: false, error: 'no mpv ipc'});
    const result = await loadInto(message.url, perFileOptions(headerFields, title), false, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('passes busy on when ours is connected but silent', async () => {
    const ipcRequest = async () => ({ok: false, busy: true, error: 'mpv did not answer'});
    const result = await loadInto(message.url, perFileOptions(headerFields, title), false, ipcRequest);
    expect(result).toEqual({ok: false, busy: true});
  });

  it('keeps request ids aligned when the fullscreen command is inserted', async () => {
    const ipcRequest = async (commands) => {
      // fullscreen shifts loadfile/get_property to request_id 2 and 3
      expect(commands).toHaveLength(3);
      expect(commands[0].command).toEqual(['set_property', 'fullscreen', true]);
      return {
        ok: true,
        replies: [
          {request_id: 1},
          {request_id: 2, error: 'success'},
          {request_id: 3, data: 777},
        ],
      };
    };
    const result = await loadInto(message.url, perFileOptions(headerFields, title), true, ipcRequest);
    expect(result).toEqual({ok: true, pid: 777});
  });

  it('sends the headers and title with the file, in that one command', async () => {
    // Set for the whole player (set_property), they stayed for the next file in the
    // window, and two hosts' sends could interleave (set A, set B, load A, load B).
    let sent;
    const ipcRequest = async (commands) => {
      sent = commands;
      return {ok: true, replies: [{request_id: 1, error: 'success'}, {request_id: 2, data: 1}]};
    };
    await loadInto(message.url, perFileOptions(['Referer: https://a.test/x?a=1,b=2', 'User-Agent: UA (x, y)'], 'A title'), false,
        ipcRequest);
    expect(sent.some((c) => Array.isArray(c.command) && c.command[0] === 'set_property' &&
      ['http-header-fields', 'force-media-title'].includes(c.command[1]))).toBe(false);
    expect(loadfileOf(sent)).toEqual({
      name: 'loadfile',
      url: 'https://example.com/video.m3u8',
      // No index: mpv before 0.38 has no such argument and refuses the command.
      flags: 'replace',
      options: {
        'http-header-fields': 'Referer: https://a.test/x?a=1\\,b=2,User-Agent: UA (x\\, y)',
        'force-media-title': 'A title',
      },
    });
  });
});

describe('perFileOptions', () => {
  // mpv's string list removes a backslash only right before a ','
  it('joins the headers as mpv\'s string list, escaping commas only', () => {
    expect(perFileOptions(['Referer: https://a.test/?q=1,2', 'X-Path: C:\\dir', 'X-Both: a\\,b'], 't')).toEqual({
      'http-header-fields': 'Referer: https://a.test/?q=1\\,2,X-Path: C:\\dir,X-Both: a\\\\,b',
      'force-media-title': 't',
    });
  });

  it('leaves out a field ending in a backslash, which would swallow the next one', () => {
    // mpv reads "\," as an escaped comma: the Referer took the User-Agent in (measured).
    expect(perFileOptions(['Referer: https://a.test/x\\', 'User-Agent: UA'], 't')['http-header-fields'])
        .toBe('User-Agent: UA');
  });

  it('clears the headers when there are none', () => {
    expect(perFileOptions([], 't')['http-header-fields']).toBe('');
  });
});

// Against a pipe of the test's own, never mpv's; its two budgets run on fake timers moved by the
// test.
describe('mpvIpcRequest', () => {
  const servers = [];
  const dirs = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });
  const pipeName = (tag) => {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\fs-test-${tag}-${process.pid}-${Date.now()}`;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ipc-'));
    dirs.push(dir);
    return path.join(dir, 'sock');
  };
  /**
   * Serves a pipe that hands each request it reads to the test.
   * @param {string} pipe - The pipe.
   * @return {Promise<function(): Promise<{socket: net.Socket, request: Object}>>} The
   *   next request, once it has arrived.
   */
  const listen = async (pipe) => {
    const arrived = [];
    const waiting = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          const request = {socket, request: JSON.parse(line)};
          if (waiting.length) waiting.shift()(request);
          else arrived.push(request);
        }
      });
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(pipe, resolve));
    return () => arrived.length ? Promise.resolve(arrived.shift()) : new Promise((resolve) => waiting.push(resolve));
  };
  const fakeBudgets = () => vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});

  it('is not ok, and not busy, without an instance', async () => {
    // No budget runs out: the connect error alone settles it.
    fakeBudgets();
    expect(await mpvIpcRequest([{command: ['get_property', 'pid']}], 300, 300, pipeName('none')))
        .toEqual({ok: false, error: 'no mpv ipc'});
  });

  it('is busy when an instance takes the connection and never answers', async () => {
    const pipe = pipeName('silent');
    const nextRequest = await listen(pipe);
    fakeBudgets();
    const result = mpvIpcRequest([{command: ['get_property', 'pid']}], 300, 300, pipe);
    await nextRequest();
    vi.advanceTimersByTime(300);
    expect(await result).toEqual({ok: false, busy: true, error: 'mpv did not answer'});
  });

  // mpv quitting as the request arrives (its window closed) closes the pipe: it is gone,
  // and a fresh mpv is what the send needs. The reply budget ran out 6 s later with "busy".
  it('is not busy when the instance closes the pipe without answering', async () => {
    const pipe = pipeName('closing');
    const nextRequest = await listen(pipe);
    fakeBudgets();
    const result = mpvIpcRequest([{command: ['get_property', 'pid']}], 300, 300, pipe);
    const {socket} = await nextRequest();
    socket.destroy();
    expect(await result).toEqual({ok: false, error: 'mpv closed the ipc'});
  });

  // An mpv that answered a first command (the fullscreen one) before it quit counted as live:
  // loadIntoExisting found no loadfile reply and said "busy".
  it('is not ok when the instance closes the pipe after answering part of it', async () => {
    const pipe = pipeName('closing-late');
    const nextRequest = await listen(pipe);
    fakeBudgets();
    const result = mpvIpcRequest([{command: ['set_property', 'fullscreen', true]}, {command: ['get_property', 'pid']}],
        300, 300, pipe);
    const {socket} = await nextRequest();
    socket.end(JSON.stringify({request_id: 1, error: 'success'}) + String.fromCharCode(10));
    expect(await result).toEqual({ok: false, error: 'mpv closed the ipc'});
  });

  it('gives a connected instance the reply time, not the connect time', async () => {
    const pipe = pipeName('slow');
    const nextRequest = await listen(pipe);
    fakeBudgets();
    const result = mpvIpcRequest([{command: ['get_property', 'pid']}], 200, 3000, pipe);
    const {socket, request} = await nextRequest();
    // Past the connect budget, well inside the reply budget.
    vi.advanceTimersByTime(400);
    socket.write(JSON.stringify({request_id: request.request_id, data: 7, error: 'success'}) + '\n');
    expect(await result).toEqual({ok: true, replies: [{request_id: 1, data: 7, error: 'success'}]});
  });
});

// gpu-toggles.lua reads the anime/movie tag from the URL fragment, which is never sent to the
// server.

// 'mpv executable not found' left a user who had typed a path in the options wondering what
// was wrong with it, and one who had none what to do.
describe('mpvNotFoundError', () => {
  it('names the path the options gave', () => {
    expect(mpvNotFoundError('D:\\Tools\\mpv-x.exe', 'win32')).toBe('mpv was not found at "D:\\Tools\\mpv-x.exe" ' +
      '(the mpv path in FastStream\'s options): give the full path of mpv.exe, or of the folder it is in');
    expect(mpvNotFoundError('/opt/mpv', 'linux')).toContain('give the full path of mpv, or of the folder');
  });

  it('says what to do without one', () => {
    for (const path of [undefined, '', '  ', 'mpv']) {
      expect(mpvNotFoundError(path, 'win32')).toBe(
          'mpv was not found: install mpv, or give its path in FastStream\'s options (MPV section)');
    }
  });
});

// The player's mpv button hands over where it was and the subtitles it shows (as SubRip
// text); the host writes those into a fresh folder and gives mpv the files.
describe('start and subtitles from the player', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-subs-test-'));
    dirs.push(dir);
    return dir;
  };

  it('takes at most 8 non-empty SubRip texts', () => {
    const many = Array.from({length: 10}, (_, i) => ({srt: `1\n00:00:01,000 --> 00:00:02,000\nline ${i}`, label: 'L' + i}));
    expect(subtitlesOf({subtitles: many})).toHaveLength(8);
    expect(subtitlesOf({subtitles: [{srt: ' '}, {srt: 5}, null, {srt: 'x', label: 7}]})).toEqual([{srt: 'x', label: ''}]);
    expect(subtitlesOf({subtitles: 'nope'})).toEqual([]);
  });

  it('writes each into a fresh folder, named for mpv\'s track list', () => {
    const base = scratch();
    const files = writeSubtitleFiles([{srt: 'one', label: 'English <CC>'}, {srt: 'two', label: ''}], base);
    expect(files.map((f) => path.basename(f))).toEqual(['1 English CC.srt', '2.srt']);
    expect(path.dirname(files[0]).startsWith(path.join(base, SubtitleDirPrefix))).toBe(true);
    expect(fs.readFileSync(files[0], 'utf8')).toBe('one');
    expect(path.basename(path.dirname(files[0])).startsWith(PrivateSubtitleDirPrefix)).toBe(false);
    expect(writeSubtitleFiles([], base)).toEqual([]);
  });

  // mpv-config's faststream-private.lua removes the subtitles of a folder so named once mpv moved on.
  it('marks a private window\'s folder by its name', () => {
    const base = scratch();
    const files = writeSubtitleFiles([{srt: 'one', label: 'English'}], base, true);
    expect(path.basename(path.dirname(files[0]))).toMatch(/^faststream-mpv-subs-p-\w{6}$/);
    expect(PrivateSubtitleDirPrefix.startsWith(SubtitleDirPrefix)).toBe(true);
  });

  it('removes its folders older than a day, and only those', () => {
    const base = scratch();
    const old = path.join(base, SubtitleDirPrefix + 'old');
    const recent = path.join(base, SubtitleDirPrefix + 'recent');
    const foreign = path.join(base, 'someone-else');
    for (const dir of [old, recent, foreign]) fs.mkdirSync(dir);
    const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    fs.utimesSync(foreign, twoDaysAgo, twoDaysAgo);
    writeSubtitleFiles([{srt: 'x', label: 'a'}], base);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  // As a private window's playlists: should no mpv remove them (none started, killed), the next helper to end does.
  it('removes a private window\'s folders after two minutes', () => {
    const base = scratch();
    const now = Date.now();
    const folders = {
      privateOld: [PrivateSubtitleDirPrefix + 'old', 3 * 60 * 1000, false],
      privateNew: [PrivateSubtitleDirPrefix + 'new', 60 * 1000, true],
      otherHours: [SubtitleDirPrefix + 'hours', 3 * 3600 * 1000, true],
      otherDays: [SubtitleDirPrefix + 'days', 2 * 24 * 3600 * 1000, false],
      foreign: ['someone-else', 2 * 24 * 3600 * 1000, true],
    };
    for (const [name, age] of Object.values(folders)) {
      fs.mkdirSync(path.join(base, name));
      fs.utimesSync(path.join(base, name), (now - age) / 1000, (now - age) / 1000);
    }
    removeOldSubtitleDirs(base, now);
    for (const [name, , kept] of Object.values(folders)) expect([name, fs.existsSync(path.join(base, name))]).toEqual([name, kept]);
  });

  it('leaves no folder when a file cannot be written', () => {
    const base = scratch();
    const write = fs.writeFileSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('ENOSPC: no space left on device');
      return write(...args);
    });
    try {
      expect(() => writeSubtitleFiles([{srt: 'one', label: 'a'}, {srt: 'two', label: 'b'}], base, true)).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('gives mpv the start and the files as per-file options', () => {
    // sub-files: ';' between paths on Windows, backslashes as they are
    expect(perFileOptions([], 't', {start: 754.5, subFiles: ['C:\\Temp\\a,b\\1 English.srt', 'C:\\Temp\\2.srt']}, ';')).toEqual({
      'http-header-fields': '',
      'force-media-title': 't',
      'start': '754.5',
      'sub-files': 'C:\\Temp\\a,b\\1 English.srt;C:\\Temp\\2.srt',
    });
    expect(perFileOptions([], 't', {})).toEqual({'http-header-fields': '', 'force-media-title': 't'});
  });

  it('leaves out a subtitle file whose path holds the list separator', () => {
    expect(perFileOptions([], 't', {subFiles: ['C:\\a;b\\1.srt', 'C:\\ok\\2.srt']}, ';')['sub-files']).toBe('C:\\ok\\2.srt');
    expect(perFileOptions([], 't', {subFiles: ['C:\\a;b\\1.srt']}, ';')).not.toHaveProperty('sub-files');
  });

  it('sends them with the file into a running mpv', async () => {
    let sent;
    const ipcRequest = async (commands) => {
      sent = commands;
      return {ok: true, replies: [{request_id: 1, error: 'success'}, {request_id: 2, data: 1}]};
    };
    // A path with neither ';' nor ':' (the delimiter on Windows and on Linux CI).
    await loadInto(message.url, perFileOptions([], 't', {start: 12, subFiles: ['/subs/1 English.srt']}), false, ipcRequest);
    expect(loadfileOf(sent).options).toMatchObject({'start': '12', 'sub-files': '/subs/1 English.srt'});
  });
});

describe('ipcPipeFor', () => {
  const token = 'fedcba9876543210fedcba9876543210';

  it('carries the config\'s token on Windows, whose pipe names are machine-wide (#156)', () => {
    expect(ipcPipeFor({ipcToken: token}, 'win32')).toBe(`\\\\.\\pipe\\faststream-mpv-${token}`);
  });

  it('keeps the old fixed name without a usable token', () => {
    for (const config of [{}, {ipcToken: 'short'}, {ipcToken: `..\\${token}`}, {ipcToken: 5}, null]) {
      expect(ipcPipeFor(config, 'win32')).toBe('\\\\.\\pipe\\faststream-mpv');
    }
  });

  it('is a socket in the user\'s runtime folder elsewhere, not a Windows name (#153)', () => {
    expect(ipcPipeFor({}, 'linux', {XDG_RUNTIME_DIR: '/run/user/1000'})).toMatch(/^\/run\/user\/1000\/faststream-mpv-\d+\.sock$/);
    expect(ipcPipeFor({}, 'darwin', {}).startsWith(os.tmpdir())).toBe(true);
    expect(ipcPipeFor({ipcToken: token}, 'linux', {})).not.toContain('pipe');
  });

  it('fits a Unix socket path in macOS\'s long temp folder', () => {
    // /var/folders/xx/.../T/ with the name and its token came to about 106 bytes, over a
    // socket path's 103: mpv could not make its socket, and nothing reached it again.
    const macTemp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000gn/T/';
    const socket = ipcPipeFor({ipcToken: token}, 'darwin', {TMPDIR: macTemp});
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    expect(socket).toMatch(new RegExp(`^/tmp/faststream-mpv-\\d+-${token}\\.sock$`));
    // A short temp folder stays where it is.
    expect(ipcPipeFor({ipcToken: token}, 'darwin', {TMPDIR: '/tmp/x'}).startsWith('/tmp/x/')).toBe(true);
  });

  it('names another of the helper\'s windows by its id after the pipe\'s name, and nothing else', () => {
    const id = '0123456789abcdef';
    expect(ipcPipeFor({ipcToken: token}, 'win32', {}, id)).toBe(`\\\\.\\pipe\\faststream-mpv-${token}-${id}`);
    expect(ipcPipeFor({ipcToken: token}, 'linux', {XDG_RUNTIME_DIR: '/run/user/1000'}, id))
        .toMatch(new RegExp(`^/run/user/1000/faststream-mpv-\\d+-${token}-${id}\\.sock$`));
    expect(ipcPipeFor({ipcToken: token}, 'win32', {}, '')).toBe(ipcPipeFor({ipcToken: token}, 'win32'));
    const macTemp = '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000gn/T/';
    expect(Buffer.byteLength(ipcPipeFor({ipcToken: token}, 'darwin', {TMPDIR: macTemp}, id))).toBeLessThanOrEqual(103);
    for (const window of ['..\\x', '0123456789ABCDEF', 'abc', '0123456789abcdef0', '/tmp/x']) {
      expect(() => ipcPipeFor({ipcToken: token}, 'win32', {}, window), window).toThrow('not a window id');
    }
  });

  it('carries the token elsewhere too when there is one: the temp folder can be shared (glm\'s review)', () => {
    expect(ipcPipeFor({ipcToken: token}, 'linux', {})).toMatch(new RegExp(`/faststream-mpv-\\d+-${token}\\.sock$`));
    expect(ipcPipeFor({ipcToken: 'short'}, 'linux', {XDG_RUNTIME_DIR: '/run/user/1000'})).toMatch(/^\/run\/user\/1000\/faststream-mpv-\d+\.sock$/);
  });
});

// Off Windows mpv is a child: one that quits at once reports why. Node stands in for mpv.
describe('launchDirect', () => {
  it('reports an mpv that quits at once', async () => {
    const result = await launchDirect(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exit code 3');
  });

  it('reports one that keeps running as started, with its pid', async () => {
    // Runs past the 500 ms launchDirect waits, and has ended by itself before the test does.
    expect(await launchDirect(process.execPath, ['-e', 'setTimeout(() => {}, 700)']))
        .toEqual({ok: true, pid: expect.any(Number)});
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
});

// "debug": true is easily left on: the log took every subtitle text and never stopped
// growing.
describe('the debug log', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('records subtitles as their number and size', () => {
    const logged = loggedMessage({type: 'open', url: 'https://cdn.test/v.m3u8',
      subtitles: [{label: 'English', srt: 'x'.repeat(1000)}, {label: 'German', srt: 'yy'}]});
    expect(logged.subtitles).toEqual({count: 2, chars: 1002});
    expect(logged.url).toBe('https://cdn.test/v.m3u8');
    expect(JSON.stringify(logged)).not.toContain('xxx');
    expect(loggedMessage(null)).toBeNull();
  });

  it('starts anew past MaxLogBytes, keeping the one before', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-host-log-'));
    dirs.push(dir);
    const file = path.join(dir, 'faststream-mpv-host.log');
    fs.writeFileSync(file, 'x'.repeat(MaxLogBytes + 1));
    debugLog({debug: true}, 'next', {n: 1}, file);
    expect(fs.statSync(file + '.1').size).toBe(MaxLogBytes + 1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).label).toBe('next');
    debugLog({debug: true}, 'again', {n: 2}, file);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('logs for FASTSTREAM_MPV_DEBUG=1, not for 0', () => {
    // Any value turned it on, "0" too.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-host-log-'));
    dirs.push(dir);
    const file = path.join(dir, 'faststream-mpv-host.log');
    try {
      vi.stubEnv('FASTSTREAM_MPV_DEBUG', '0');
      debugLog({}, 'off', {}, file);
      expect(fs.existsSync(file)).toBe(false);
      vi.stubEnv('FASTSTREAM_MPV_DEBUG', '1');
      debugLog({}, 'on', {}, file);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).label).toBe('on');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('takes 1, true, yes and on as on, anything else as off', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'On', ' 1 ']) {
      expect(debugFromEnvironment(value)).toBe(true);
    }
    for (const value of [undefined, '', '0', 'false', 'off', 'no', '2', 'debug']) {
      expect(debugFromEnvironment(value)).toBe(false);
    }
  });
});
