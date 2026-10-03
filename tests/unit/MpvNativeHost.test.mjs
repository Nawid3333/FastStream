import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {SubtitleDirPrefix, loadIntoExisting, mpvIpcRequest, mpvTargetUrl, pageFragmentFor, perFileOptions, resumeIdFor, startOf, streamTitle, subtitlesOf, withContentTypeFragment, writeSubtitleFiles} from '../../native-host/faststream-mpv-host.mjs';

// loadIntoExisting decides whether the "reuse the window we already own"
// path actually worked, from the IPC replies mpvIpcRequest collects. That
// function is injected here instead of hitting a real named pipe: it is
// Windows-only, and this suite runs on Linux CI too (see ci.yml).
//
// mpvIpcRequest can resolve {ok: true} on its own timeout as soon as *any*
// reply has arrived -- a live-but-slow pipe still counts as "ours" -- which
// means the loadfile reply specifically can be missing even though result.ok
// is true. Before the fix, a missing loadReply skipped the error check
// entirely and fell through to {ok: true, pid: undefined}: success was
// reported without ever confirming the video loaded.

const message = {url: 'https://example.com/video.m3u8'};
const headerFields = ['Referer: https://example.com/'];
const title = 'example.com';

const loadfileOf = (commands) => commands.find((c) => !Array.isArray(c.command) && c.command.name === 'loadfile').command;

describe('loadIntoExisting', () => {
  it('succeeds when every reply, including loadfile, comes back', async () => {
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: commands.length - 1, error: 'success'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: true, pid: 4242});
  });

  it('fails when the pipe answers but loadfile is refused', async () => {
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: commands.length - 1, error: 'invalid parameter'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('is busy, not phantom-successful, when only the fullscreen reply came back', async () => {
    // mpvIpcRequest's own timeout fired after the first reply: ok:true, but no
    // reply for loadfile or get_property pid. Not success; and not "no mpv" either,
    // since ours answered: a second mpv on the same pipe would get no IPC.
    const ipcRequest = async () => ({ok: true, replies: [{request_id: 1}]});
    const result = await loadIntoExisting({...message, fullscreen: true}, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false, busy: true});
  });

  it('fails when no instance of ours answers at all', async () => {
    const ipcRequest = async () => ({ok: false, error: 'no mpv ipc'});
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('passes busy on when ours is connected but silent', async () => {
    const ipcRequest = async () => ({ok: false, busy: true, error: 'mpv did not answer'});
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false, busy: true});
  });

  it('keeps request ids aligned when the fullscreen command is inserted', async () => {
    const ipcRequest = async (commands) => {
      // fullscreen adds a command first, shifting loadfile/get_property to
      // request_id 2 and 3 -- catches an off-by-one if the indices were
      // ever hardcoded instead of derived from commands.length.
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
    const result = await loadIntoExisting(
        {...message, fullscreen: true}, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: true, pid: 777});
  });

  it('appends the fs-content fragment to the loadfile command', async () => {
    let loadfileUrl;
    const ipcRequest = async (commands) => {
      loadfileUrl = loadfileOf(commands).url;
      return {ok: true, replies: [{request_id: 1, error: 'success'}, {request_id: 2, data: 1}]};
    };
    await loadIntoExisting({...message, contentType: 'anime'}, headerFields, title, ipcRequest);
    expect(loadfileUrl).toBe('https://example.com/video.m3u8#fs-content=anime');
  });

  it('sends the headers and title with the file, in that one command', async () => {
    // Set for the whole player (set_property), they stayed for the next file in the
    // window, and two hosts' sends could interleave (set A, set B, load A, load B).
    let sent;
    const ipcRequest = async (commands) => {
      sent = commands;
      return {ok: true, replies: [{request_id: 1, error: 'success'}, {request_id: 2, data: 1}]};
    };
    await loadIntoExisting(message, ['Referer: https://a.test/x?a=1,b=2', 'User-Agent: UA (x, y)'], 'A title', ipcRequest);
    expect(sent.some((c) => Array.isArray(c.command) && c.command[0] === 'set_property' &&
      ['http-header-fields', 'force-media-title'].includes(c.command[1]))).toBe(false);
    expect(loadfileOf(sent)).toEqual({
      name: 'loadfile',
      url: 'https://example.com/video.m3u8',
      flags: 'replace',
      index: -1,
      options: {
        'http-header-fields': 'Referer: https://a.test/x?a=1\\,b=2,User-Agent: UA (x\\, y)',
        'force-media-title': 'A title',
      },
    });
  });
});

describe('perFileOptions', () => {
  it('joins the headers as mpv\'s string list, escaping commas and backslashes', () => {
    expect(perFileOptions(['Referer: https://a.test/?q=1,2', 'X-Path: C:\\dir'], 't')).toEqual({
      'http-header-fields': 'Referer: https://a.test/?q=1\\,2,X-Path: C:\\\\dir',
      'force-media-title': 't',
    });
  });

  it('clears the headers when there are none', () => {
    expect(perFileOptions([], 't')['http-header-fields']).toBe('');
  });
});

describe('streamTitle', () => {
  it('is the tab\'s title when the extension sent one', () => {
    expect(streamTitle({url: 'https://cdn.test/v.m3u8', title: 'Show - Episode 3'})).toBe('Show - Episode 3');
  });

  it('is one line, trimmed and bounded', () => {
    expect(streamTitle({url: 'https://cdn.test/v.m3u8', title: '  Show\n\tEpisode\u00073  '})).toBe('Show Episode 3');
    expect(streamTitle({url: 'https://cdn.test/v.m3u8', title: 'x'.repeat(500)})).toHaveLength(200);
  });

  it('is the stream\'s host name without a usable title', () => {
    expect(streamTitle({url: 'https://cdn.test/v.m3u8'})).toBe('cdn.test');
    expect(streamTitle({url: 'https://cdn.test/v.m3u8', title: ' \n '})).toBe('cdn.test');
    expect(streamTitle({url: 'https://cdn.test/v.m3u8', title: 42})).toBe('cdn.test');
    expect(streamTitle({url: 'not a url'})).toBe('FastStream');
  });
});

// mpvIpcRequest against a pipe of the test's own (never mpv's real one, which a running
// mpv may hold): no server is "no mpv"; one that accepts but never answers is busy.
// The pipe is real; its two budgets run on fake timers, moved on by the test once the
// request has reached the server. With real 200-400 ms budgets a loaded machine could
// take longer than the connect budget to connect.
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

// The mpv URL fragment is how gpu-toggles.lua learns a stream's anime/movie
// tag on the mpv side: fragments are never sent to the HTTP server, so this
// cannot break a signed/tokenized CDN URL, unlike a query parameter would.

describe('withContentTypeFragment', () => {
  it('appends a fragment marker when there is none yet', () => {
    expect(withContentTypeFragment('https://example.com/a.m3u8', 'anime'))
        .toBe('https://example.com/a.m3u8#fs-content=anime');
    expect(withContentTypeFragment('https://example.com/a.m3u8', 'movie'))
        .toBe('https://example.com/a.m3u8#fs-content=movie');
  });

  it('extends an existing fragment instead of adding a second #', () => {
    expect(withContentTypeFragment('https://example.com/a.m3u8#t=30', 'anime'))
        .toBe('https://example.com/a.m3u8#t=30&fs-content=anime');
  });

  it('fills an empty existing fragment without a leading &', () => {
    expect(withContentTypeFragment('https://example.com/a.m3u8#', 'movie'))
        .toBe('https://example.com/a.m3u8#fs-content=movie');
  });

  it('leaves the URL untouched for an unset or invalid contentType', () => {
    expect(withContentTypeFragment('https://example.com/a.m3u8', undefined))
        .toBe('https://example.com/a.m3u8');
    expect(withContentTypeFragment('https://example.com/a.m3u8', null))
        .toBe('https://example.com/a.m3u8');
    expect(withContentTypeFragment('https://example.com/a.m3u8', 'documentary'))
        .toBe('https://example.com/a.m3u8');
  });
});

// fs-id= is the key stream-resume.lua saves the playback position under: a
// hash of the tab's page URL, because the stream URL usually changes on every
// visit (expiring CDN token) while the episode page does not.

describe('resumeIdFor', () => {
  it('is 16 hex digits and stable for the same page', () => {
    const id = resumeIdFor('https://example.com/anime/show/episode-3');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(resumeIdFor('https://example.com/anime/show/episode-3')).toBe(id);
  });

  it('differs between pages', () => {
    expect(resumeIdFor('https://example.com/anime/show/episode-3'))
        .not.toBe(resumeIdFor('https://example.com/anime/show/episode-4'));
  });

  it('is undefined for a missing or non-http(s) page URL', () => {
    expect(resumeIdFor(undefined)).toBeUndefined();
    expect(resumeIdFor('')).toBeUndefined();
    expect(resumeIdFor('about:blank')).toBeUndefined();
    expect(resumeIdFor('moz-extension://abc/player.html')).toBeUndefined();
  });
});

describe('mpvTargetUrl', () => {
  const pageUrl = 'https://example.com/anime/show/episode-3';

  it('appends fs-content, fs-id and fs-page in one fragment', () => {
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8?token=1', contentType: 'anime', pageUrl}))
        .toBe(
            `https://cdn/a.m3u8?token=1#fs-content=anime&fs-id=${resumeIdFor(pageUrl)}&fs-page=${
              encodeURIComponent(pageUrl)}`);
  });

  it('gives the same key for a new stream token on the same page', () => {
    const first = mpvTargetUrl({url: 'https://cdn/a.m3u8?token=1', pageUrl});
    const second = mpvTargetUrl({url: 'https://cdn/a.m3u8?token=2', pageUrl});
    expect(first.split('#')[1]).toBe(second.split('#')[1]);
  });

  it('adds fs-id and fs-page when there is no contentType', () => {
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8', pageUrl}))
        .toBe(
            `https://cdn/a.m3u8#fs-id=${resumeIdFor(pageUrl)}&fs-page=${encodeURIComponent(pageUrl)}`);
  });

  it('is withContentTypeFragment alone without a page URL', () => {
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8', contentType: 'movie'}))
        .toBe('https://cdn/a.m3u8#fs-content=movie');
  });

  it('never puts the page address itself into the URL unencoded', () => {
    // The whole point of fs-page= being one percent-encoded tag: the raw
    // address, with its ?, & and # intact, must never leak into the URL.
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8', pageUrl}))
        .not.toContain(`fs-page=${pageUrl}`);
  });
});

describe('fs-page fragment (source-info.lua reads it)', () => {
  const pageUrl = 'https://example.com/anime/show/episode-3';
  const encoded = encodeURIComponent(pageUrl);

  it('appends fs-page right after fs-id', () => {
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8?token=1', contentType: 'anime', pageUrl}))
        .toBe(
            `https://cdn/a.m3u8?token=1#fs-content=anime&fs-id=${resumeIdFor(pageUrl)}&fs-page=${
              encoded}`);
  });

  it('still appends fs-page without a contentType tag', () => {
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8', pageUrl}))
        .toBe(`https://cdn/a.m3u8#fs-id=${resumeIdFor(pageUrl)}&fs-page=${encoded}`);
  });

  it('skips fs-page for a missing or non-http(s) page URL', () => {
    expect(pageFragmentFor(undefined)).toBeUndefined();
    expect(pageFragmentFor('')).toBeUndefined();
    expect(pageFragmentFor('about:blank')).toBeUndefined();
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8', pageUrl: 'about:blank'}))
        .toBe('https://cdn/a.m3u8');
  });

  it('encodes characters that would break the fragment (&, ?, #)', () => {
    const messy = 'https://example.com/watch?v=1&q=a&x#top';
    expect(mpvTargetUrl({url: 'https://cdn/a.m3u8', pageUrl: messy}))
        .toBe(`https://cdn/a.m3u8#fs-id=${resumeIdFor(messy)}&fs-page=${encodeURIComponent(messy)}`);
  });

  it('round-trips through decode (what mpv\'s source-info.lua does)', () => {
    const url = mpvTargetUrl({url: 'https://cdn/a.m3u8', pageUrl});
    // value between fs-page= and the next & / end: the whole rest here
    const value = url.slice(url.indexOf('fs-page=') + 'fs-page='.length);
    expect(decodeURIComponent(value)).toBe(pageUrl);
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

  it('takes a start position of a second or more, to the millisecond', () => {
    expect(startOf({start: 754.123456})).toBe(754.123);
    for (const start of [undefined, 0, 0.5, -3, NaN, Infinity, '754', 1e8]) {
      expect(startOf({start})).toBeUndefined();
    }
  });

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
    expect(writeSubtitleFiles([], base)).toEqual([]);
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

  it('gives mpv the start and the files as per-file options', () => {
    // sub-files is a path list: ';' between the paths on Windows, backslashes as they are
    // (escaped like a string list, mpv looked for "C:\\Temp\\..." - measured).
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
    await loadIntoExisting(message, [], 't', ipcRequest, {start: 12, subFiles: ['/subs/1 English.srt']});
    expect(loadfileOf(sent).options).toMatchObject({'start': '12', 'sub-files': '/subs/1 English.srt'});
  });
});

