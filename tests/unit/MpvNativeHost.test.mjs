import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadIntoExisting, mpvTargetUrl, pageFragmentFor, resumeIdFor, withContentTypeFragment, withIpcLock} from '../../native-host/faststream-mpv-host.mjs';

// loadIntoExisting decides whether the "reuse the window we already own"
// path actually worked, from the IPC replies mpvIpcRequest collects. That
// function is injected here instead of hitting a real named pipe: it is
// Windows-only, and this suite runs on Linux CI too (see ci.yml).
//
// mpvIpcRequest can resolve {ok: true} on its own 1.5s timeout as soon as
// *any* reply has arrived -- a live-but-slow pipe still counts as "ours" --
// which means the loadfile reply specifically can be missing even though
// result.ok is true. Before the fix, a missing loadReply skipped the error
// check entirely and fell through to {ok: true, pid: undefined}: success
// was reported without ever confirming the video loaded, so the caller
// never started a fresh instance to actually play it.

const message = {url: 'https://example.com/video.m3u8'};
const headerFields = ['Referer: https://example.com/'];
const title = 'example.com';

describe('loadIntoExisting', () => {
  it('succeeds when every reply, including loadfile, comes back', async () => {
    const ipcRequest = async (commands) => ({
      ok: true,
      replies: [
        {request_id: 1},
        {request_id: 2},
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
        {request_id: 1},
        {request_id: 2},
        {request_id: commands.length - 1, error: 'property unavailable'},
        {request_id: commands.length, data: 4242},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('fails, not phantom-succeeds, when the loadfile reply never arrives', async () => {
    // Simulates mpvIpcRequest's own timeout firing after only the two
    // set_property replies came back -- ok:true, but no reply for loadfile
    // or get_property pid yet. This is the regression case: it must not be
    // reported as success.
    const ipcRequest = async () => ({
      ok: true,
      replies: [
        {request_id: 1},
        {request_id: 2},
      ],
    });
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('fails when no instance of ours answers at all', async () => {
    const ipcRequest = async () => ({ok: false, error: 'no mpv ipc'});
    const result = await loadIntoExisting(message, headerFields, title, ipcRequest);
    expect(result).toEqual({ok: false});
  });

  it('keeps request ids aligned when the fullscreen command is inserted', async () => {
    const ipcRequest = async (commands) => {
      // fullscreen adds a 5th command, shifting loadfile/get_property to
      // request_id 4 and 5 -- catches an off-by-one if the indices were
      // ever hardcoded instead of derived from commands.length.
      expect(commands).toHaveLength(5);
      return {
        ok: true,
        replies: [
          {request_id: 1},
          {request_id: 2},
          {request_id: 3},
          {request_id: 4, error: 'success'},
          {request_id: 5, data: 777},
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
      loadfileUrl = commands.find((c) => c.command[0] === 'loadfile').command[1];
      return {
        ok: true,
        replies: [
          {request_id: 1},
          {request_id: 2},
          {request_id: commands.length - 1, error: 'success'},
          {request_id: commands.length, data: 1},
        ],
      };
    };
    await loadIntoExisting({...message, contentType: 'anime'}, headerFields, title, ipcRequest);
    expect(loadfileUrl).toBe('https://example.com/video.m3u8#fs-content=anime');
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

// Each "Send to mpv" is its own host process, and loading into the running mpv sets the
// headers globally before loading the file: two sends milliseconds apart could interleave
// as set A, set B, load B, load A, so A played with B's headers.
describe('withIpcLock', () => {
  let lockDir;
  let lockFile;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ipc-lock-'));
    lockFile = path.join(lockDir, 'ipc.lock');
  });

  afterEach(() => {
    fs.rmSync(lockDir, {recursive: true, force: true});
  });

  const exchange = (events, name, ms) => async () => {
    events.push(name + ' start');
    await new Promise((resolve) => setTimeout(resolve, ms));
    events.push(name + ' end');
    return name;
  };

  it('runs two overlapping exchanges one after the other', async () => {
    const events = [];
    const results = await Promise.all([
      withIpcLock(exchange(events, 'A', 80), lockFile),
      withIpcLock(exchange(events, 'B', 10), lockFile),
    ]);
    expect(results).toEqual(['A', 'B']);
    expect(events).toEqual(['A start', 'A end', 'B start', 'B end']);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('releases the lock when the exchange throws', async () => {
    await expect(withIpcLock(async () => {
      throw new Error('pipe broke');
    }, lockFile)).rejects.toThrow('pipe broke');
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('takes over a lock left by a host that was killed', async () => {
    fs.writeFileSync(lockFile, '');
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(lockFile, old, old);
    const started = Date.now();
    expect(await withIpcLock(async () => 'ran', lockFile, 5000)).toBe('ran');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('goes ahead after its wait when another host holds the lock too long', async () => {
    fs.writeFileSync(lockFile, '');
    const started = Date.now();
    expect(await withIpcLock(async () => 'ran', lockFile, 150)).toBe('ran');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    // The other host's lock is not ours to remove.
    expect(fs.existsSync(lockFile)).toBe(true);
  });
});

describe('loadIntoExisting from two hosts at once', () => {
  it('sends one host\'s headers and file before the other\'s', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ipc-lock-'));
    const lockFile = path.join(lockDir, 'ipc.lock');
    const sent = [];
    // A pipe that takes a while: each batch's commands arrive over some milliseconds.
    const slowPipe = async (commands) => {
      for (const command of commands) {
        sent.push(command.command);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {ok: true, replies: commands.map((c, i) => ({request_id: i + 1, error: 'success'}))};
    };
    try {
      await Promise.all([
        loadIntoExisting({url: 'https://a.test/v.m3u8'}, ['Referer: https://a.test/'], 'a', slowPipe, lockFile),
        loadIntoExisting({url: 'https://b.test/v.m3u8'}, ['Referer: https://b.test/'], 'b', slowPipe, lockFile),
      ]);
    } finally {
      fs.rmSync(lockDir, {recursive: true, force: true});
    }
    // Each loadfile follows its own header setting, with nothing of the other between.
    const order = sent.filter((c) => c[1] === 'http-header-fields' || c[0] === 'loadfile')
        .map((c) => c[0] === 'loadfile' ? 'load ' + new URL(c[1]).hostname : 'set ' + c[2][0]);
    expect(order).toEqual([
      'set Referer: https://a.test/', 'load a.test',
      'set Referer: https://b.test/', 'load b.test',
    ]);
  });
});
