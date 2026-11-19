import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {
  HlsDirPrefix, checkHlsPackage, checkPlayMessage, ffmpegAttributes, hlsAddresses, hlsMasterIn, hlsPlayOptions,
  launchLockFile, loggedMessage, playMpv, privatePackageWatch, removeOldHlsPackages, takeLaunchLock, writeHlsPackage,
} from '../../native-host/faststream-mpv-host.mjs';

// Helper 27: an HLS stream mpv cannot open from its address goes as its playlists, every address whole, and mpv
// plays them from files (docs/notes/mpv.md, "Streams mpv cannot open alone"). The helper is the security
// boundary: ffmpeg must be given web addresses only, never a file of the user's.

const SEG = 'https://cdn.test/content/a/page-0.html?token=k';
const media = (lines = [`#EXTINF:6,`, SEG]) =>
  ['#EXTM3U', '#EXT-X-TARGETDURATION:6', ...lines, '#EXT-X-ENDLIST', ''].join('\n');
const master = (lines) => ['#EXTM3U', ...lines, ''].join('\n');

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-hls-test-'));
  dirs.push(dir);
  return dir;
};

describe('a tag\'s attributes, as ffmpeg reads them', () => {
  it.each([
    ['quoted', 'METHOD=AES-128,URI="https://k.test/key"', [['METHOD', 'AES-128'], ['URI', 'https://k.test/key']]],
    ['unquoted', 'URI=file:///C:/x', [['URI', 'file:///C:/x']]],
    ['parted by a space, not a comma', 'METHOD=AES-128 URI=file:///C:/x', [['METHOD', 'AES-128'], ['URI', 'file:///C:/x']]],
    ['right after a closing quote', 'METHOD="AES-128"URI=file:///C:/x', [['METHOD', 'AES-128'], ['URI', 'file:///C:/x']]],
    ['a backslash keeping the next character', 'URI="a\\"b"', [['URI', 'a"b']]],
  ])('%s', (_, text, expected) => {
    expect(ffmpegAttributes(text).map(({key, value}) => [key, value])).toEqual(expected);
  });

  it('finds every address ffmpeg would open, and refuses lines it would read otherwise', () => {
    expect(hlsAddresses(media(['#EXT-X-MAP:URI="https://cdn.test/init.mp4"', '#EXTINF:6,', SEG]))).toEqual([
      {address: 'https://cdn.test/init.mp4', tag: '#EXT-X-MAP'}, {address: SEG, tag: null}]);
    expect(hlsAddresses(media(['#EXTINF:6,', ` ${SEG}`]))).toBeNull();
    expect(hlsAddresses(media(['#EXTINF:6,', '  #EXT-X-KEY:URI="https://k.test/k"']))).toBeNull();
    expect(hlsAddresses(media(['#EXT-X-KEY:URI="https:\\/\\/k.test"']))).toBeNull();
  });
});

describe('the playlists the helper takes', () => {
  it.each([
    ['one complete media playlist', [{name: '0.m3u8', text: media()}]],
    ['a master, its variants and an audio rendition', [
      {name: 'master.m3u8', text: master(['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="de",URI="2.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '0.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2,AUDIO="a"', '1.m3u8'])},
      {name: '0.m3u8', text: media()}, {name: '1.m3u8', text: media()}, {name: '2.m3u8', text: media()}]],
    ['a key and an init section on the web', [{name: '0.m3u8', text: media([
      '#EXT-X-KEY:METHOD=AES-128,URI="https://k.test/key?token=k"', '#EXT-X-MAP:URI="https://cdn.test/init.mp4"',
      '#EXTINF:6,', SEG])}]],
  ])('%s', (_, files) => {
    expect(checkHlsPackage({files})).toEqual({ok: true, files});
  });

  it.each([
    ['a local file as a segment', [{name: '0.m3u8', text: media(['#EXTINF:6,', 'file:///C:/Windows/win.ini'])}]],
    ['a segment relative to the folder', [{name: '0.m3u8', text: media(['#EXTINF:6,', '../../secret.ts'])}]],
    ['a UNC path', [{name: '0.m3u8', text: media(['#EXTINF:6,', '\\\\host\\share\\a.ts'])}]],
    ['an unquoted local init section', [{name: '0.m3u8', text: media(['#EXT-X-MAP:URI=file:///C:/x', '#EXTINF:6,', SEG])}]],
    ['a local key after a space', [{name: '0.m3u8', text: media(['#EXT-X-KEY:METHOD=AES-128 URI=file:///C:/k', '#EXTINF:6,', SEG])}]],
    ['a local key right after a quote', [{name: '0.m3u8', text: media(['#EXT-X-KEY:METHOD="AES-128"URI=data:,x', '#EXTINF:6,', SEG])}]],
    ['a line with leading spaces', [{name: '0.m3u8', text: media(['#EXTINF:6,', ' C:/x.ts'])}]],
    ['an address with credentials', [{name: '0.m3u8', text: media(['#EXTINF:6,', 'https://u:p@cdn.test/a.ts'])}]],
    ['a live playlist (no end)', [{name: '0.m3u8', text: '#EXTM3U\n#EXTINF:6,\n' + SEG + '\n'}]],
    ['a media playlist naming a variant', [{name: '0.m3u8', text: media(['#EXT-X-STREAM-INF:BANDWIDTH=1', SEG])}]],
    ['a master naming a playlist on the web, unchecked', [
      {name: 'master.m3u8', text: master(['#EXT-X-STREAM-INF:BANDWIDTH=1', 'https://evil.test/a.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2', '0.m3u8'])},
      {name: '0.m3u8', text: media()}]],
    ['a master naming itself', [{name: 'master.m3u8', text: master(['#EXT-X-STREAM-INF:BANDWIDTH=1', 'master.m3u8'])}]],
    ['a master naming a playlist in an I-frame tag', [
      {name: 'master.m3u8', text: master(['#EXT-X-I-FRAME-STREAM-INF:URI="0.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1', '0.m3u8'])},
      {name: '0.m3u8', text: media()}]],
    ['a playlist its master does not name', [
      {name: 'master.m3u8', text: master(['#EXT-X-STREAM-INF:BANDWIDTH=1', '0.m3u8'])},
      {name: '0.m3u8', text: media()}, {name: '1.m3u8', text: media()}]],
    ['two playlists without a master', [{name: '0.m3u8', text: media()}, {name: '1.m3u8', text: media()}]],
    ['a name going up a folder', [{name: '../0.m3u8', text: media()}]],
    ['a name twice', [{name: '0.m3u8', text: media()}, {name: '0.m3u8', text: media()}]],
    ['the master not first', [{name: '0.m3u8', text: media()}, {name: 'master.m3u8', text: master(['0.m3u8'])}]],
    ['no playlist text', [{name: '0.m3u8', text: '<html>'}]],
    ['a control character', [{name: '0.m3u8', text: media(['#EXTINF:6,\u0000', SEG])}]],
    ['none', []],
  ])('refuses %s', (_, files) => {
    expect(checkHlsPackage({files}).ok).toBe(false);
  });

  it('refuses the whole play message for one bad playlist', () => {
    const checked = checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k', title: 'T',
      hls: {files: [{name: '0.m3u8', text: media(['#EXTINF:6,', 'file:///C:/x'])}]}});
    expect(checked.ok).toBe(false);
  });

  it('keeps the playlists, which hold the stream\'s key, out of the debug log', () => {
    const logged = loggedMessage({type: 'play', target: 'https://cdn.test/v', hls: {files: [{name: '0.m3u8', text: media()}]}});
    expect(JSON.stringify(logged)).not.toContain('token=k');
    expect(logged.hls).toEqual({files: 1});
  });
});

describe('writing the playlists', () => {
  it('writes them into a fresh folder with the stream as sent beside them, and removes old folders', () => {
    const base = scratch();
    const old = path.join(base, HlsDirPrefix + 'old000');
    fs.mkdirSync(old);
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    const target = 'https://cdn.test/pl/7?token=k#fs-id=0123456789abcdef';
    const entry = writeHlsPackage([{name: 'master.m3u8', text: master(['0.m3u8'])}, {name: '0.m3u8', text: media()}], target, base);
    expect(path.basename(entry)).toBe('master.m3u8');
    expect(path.basename(path.dirname(entry)).startsWith(HlsDirPrefix)).toBe(true);
    expect(fs.readFileSync(path.join(path.dirname(entry), '0.m3u8'), 'utf8')).toBe(media());
    expect(fs.readFileSync(path.join(path.dirname(entry), 'target.txt'), 'utf8')).toBe(target);
    expect(fs.existsSync(old)).toBe(false);
  });

  // ffmpeg resolves a name against the master's own address up to a '#' or '?' (measured with mpv 0.42: "hls:
  // Opening '<the path up to the #>\0.m3u8'", "Failed to recognize file format"): the temp folder of a Windows
  // account whose name has a '#'. A whole path it opens as written.
  it('names a master\'s playlists by their whole paths in a folder whose path ffmpeg would cut', () => {
    const base = path.join(scratch(), 'user#1');
    fs.mkdirSync(base);
    const text = master(['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="1.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '0.m3u8']);
    const files = [{name: 'master.m3u8', text}, {name: '0.m3u8', text: media()}, {name: '1.m3u8', text: media()}];
    expect(checkHlsPackage({files})).toMatchObject({ok: true});
    const entry = writeHlsPackage(files, 'https://cdn.test/pl/7?token=k', base);
    const dir = path.dirname(entry).split(path.sep).join('/');
    expect(fs.readFileSync(entry, 'utf8')).toBe(master([`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="${dir}/1.m3u8"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', `${dir}/0.m3u8`]));
    // As ffmpeg reads the written master: its two playlists and nothing else.
    expect(hlsAddresses(fs.readFileSync(entry, 'utf8')).map(({address}) => address)).toEqual([`${dir}/1.m3u8`, `${dir}/0.m3u8`]);
    expect(fs.readFileSync(path.join(path.dirname(entry), '0.m3u8'), 'utf8')).toBe(media());

    // Any other folder: the names as sent, which resolve to the master's own folder.
    const plainBase = scratch();
    if (!/[#?]/.test(plainBase)) {
      expect(fs.readFileSync(writeHlsPackage(files, 'https://cdn.test/pl/7?token=k', plainBase), 'utf8')).toBe(text);
    }
  });

  it('leaves a master as sent when its playlists cannot be named whole as ffmpeg reads them', () => {
    // An unquoted URI is one to ffmpeg and to the helper's check; only the quoted form the extension writes is rewritten.
    const base = path.join(scratch(), 'user#1');
    fs.mkdirSync(base);
    const text = master(['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI=1.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '0.m3u8']);
    const files = [{name: 'master.m3u8', text}, {name: '0.m3u8', text: media()}, {name: '1.m3u8', text: media()}];
    expect(checkHlsPackage({files})).toMatchObject({ok: true});
    expect(fs.readFileSync(writeHlsPackage(files, 'https://cdn.test/pl/7?token=k', base), 'utf8')).toBe(text);
  });

  it('writes the whole paths by each system\'s own rules, whichever one runs this test', () => {
    const text = (/** @type {string} */ dir, end = '\n') => ['#EXTM3U', `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="${dir}1.m3u8"`,
      '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', `${dir}0.m3u8`, ''].join(end);
    expect(hlsMasterIn(text(''), 'D:\\Temp\\a#b\\faststream-mpv-hls-abc123', path.win32))
        .toBe(text('D:/Temp/a#b/faststream-mpv-hls-abc123/'));
    expect(hlsMasterIn(text('', '\r\n'), 'D:\\Temp\\a#b\\faststream-mpv-hls-abc123', path.win32))
        .toBe(text('D:/Temp/a#b/faststream-mpv-hls-abc123/', '\r\n'));
    expect(hlsMasterIn(text(''), '/tmp/a?b/faststream-mpv-hls-abc123', path.posix)).toBe(text('/tmp/a?b/faststream-mpv-hls-abc123/'));
    expect(hlsMasterIn(text(''), 'D:\\Temp\\faststream-mpv-hls-abc123', path.win32)).toBe(text(''));
    // A folder name no quoted value can hold: as sent.
    expect(hlsMasterIn(text(''), '/tmp/a"#b/faststream-mpv-hls-abc123', path.posix)).toBe(text(''));
  });

  it('marks a private window\'s folder, which goes two minutes on', () => {
    const base = scratch();
    const entry = writeHlsPackage([{name: '0.m3u8', text: media()}], 'https://cdn.test/v#fs-id=ab&fs-private=1', base);
    expect(path.basename(path.dirname(entry)).startsWith(HlsDirPrefix + 'p-')).toBe(true);
    removeOldHlsPackages(base, Date.now() + 110 * 1000);
    expect(fs.existsSync(path.dirname(entry))).toBe(true);
    removeOldHlsPackages(base, Date.now() + 130 * 1000);
    expect(fs.existsSync(path.dirname(entry))).toBe(false);
  });

  it('removes a private window\'s folder once mpv moved on from it or closed, not when the extension let go', () => {
    const base = scratch();
    const write = (target) => writeHlsPackage([{name: '0.m3u8', text: media()}], target, base);
    const first = write('https://cdn.test/v#fs-private=1');
    const second = write('https://cdn.test/w#fs-private=1');
    const kept = write('https://cdn.test/x');
    const outside = path.join(scratch(), HlsDirPrefix + 'p-zzzzzz', '0.m3u8');
    fs.mkdirSync(path.dirname(outside));
    const path_ = (data) => ({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path', data}});
    const there = (entry) => fs.existsSync(path.dirname(entry));

    const watch = privatePackageWatch(base);
    watch.see(path_(first));
    watch.see({type: 'mpv', data: {event: 'property-change', id: 2, name: 'time-pos', data: 3}});
    // Loaded again: mpv has no path between the two.
    watch.see(path_(undefined));
    watch.see(path_(first));
    expect(there(first)).toBe(true);
    watch.see(path_(second));
    expect([there(first), there(second)]).toEqual([false, true]);
    watch.end('stopped');
    expect(there(second)).toBe(true);

    const next = privatePackageWatch(base);
    next.see(path_(kept));
    next.see(path_(outside));
    next.see(path_(second));
    expect([there(kept), there(outside), there(second)]).toEqual([true, true, true]);
    next.end('mpv closed');
    expect(there(second)).toBe(false);
  });

  it('removes old folders whenever asked, past one it cannot remove', () => {
    const base = scratch();
    const hours = (n) => Date.now() + n * 60 * 60 * 1000;
    const blocked = path.join(base, HlsDirPrefix + 'a');
    const old = path.join(base, HlsDirPrefix + 'b');
    const other = path.join(base, HlsDirPrefix + 'c');
    for (const dir of [blocked, old, other]) fs.mkdirSync(dir);
    const realStat = fs.statSync;
    fs.statSync = (file, ...rest) => {
      if (file === blocked) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
      return realStat(file, ...rest);
    };
    try {
      removeOldHlsPackages(base, hours(47));
      expect([fs.existsSync(blocked), fs.existsSync(old), fs.existsSync(other)]).toEqual([true, true, true]);
      removeOldHlsPackages(base, hours(49));
      expect([fs.existsSync(blocked), fs.existsSync(old), fs.existsSync(other)]).toEqual([true, false, false]);
    } finally {
      fs.statSync = realStat;
    }
  });
});

describe('playing them', () => {
  it('loads the entry file as HLS (never mpv\'s own playlist), and names it in the answer', async () => {
    const base = scratch();
    const asks = [];
    const io = {
      hlsBase: base,
      ipcRequest: async (commands) => {
        asks.push(commands.map((c) => c.command));
        return {ok: true, replies: commands.map((c, i) => ({request_id: i + 1, error: 'success', data: 4242}))};
      },
      focus: async () => 'True',
      platform: 'linux',
    };
    const checked = checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k#fs-id=ab', title: 'T',
      hls: {files: [{name: '0.m3u8', text: media()}]}});
    expect(checked.ok).toBe(true);
    const answer = await playMpv('mpv', /** @type {*} */ (checked).play, {ipcToken: 'x'}, io);
    const load = asks.flat().find((command) => !Array.isArray(command) && command.name === 'loadfile');
    expect(load.url).toBe(answer.local);
    expect(path.dirname(load.url).startsWith(base)).toBe(true);
    expect(load.options).toMatchObject({'demuxer': 'lavf',
      'demuxer-lavf-o': 'protocol_whitelist=[http,https,tcp,tls,crypto],format_whitelist=[hls,mpegts,mov,aac,mp3,ac3,eac3,webvtt,srt]'});
    expect(load.options['demuxer-lavf-format']).toBeUndefined();
  });

  it('removes the playlists of a stream that did not go', async () => {
    const base = scratch();
    const io = {
      hlsBase: base,
      ipcRequest: async (commands) => ({ok: true, replies: [
        {request_id: commands.length - 1, error: 'invalid parameter'}, {request_id: commands.length, data: 1}]}),
      focus: async () => 'True',
      platform: 'linux',
      start: async () => {
        started++;
        return {ok: false, error: 'not here'};
      },
    };
    let started = 0;
    const checked = checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k#fs-id=ab', title: 'T',
      hls: {files: [{name: '0.m3u8', text: media()}]}});
    const answer = await playMpv('mpv', /** @type {*} */ (checked).play, {ipcToken: 'x'}, io);
    expect(answer).toEqual({ok: false, error: 'the open mpv refused the stream (invalid parameter): close it and send again'});
    expect(fs.readdirSync(base)).toEqual([]);
    expect(started).toBe(0);
  });

  // Measured with a real mpv held for longer than the helper waits (6 s): once it ran on, it took the load out
  // of its pipe, stopped the video it was playing and failed on the folder the helper had removed.
  it('keeps the playlists when mpv was only busy: the load is in its pipe, and mpv may still run it', async () => {
    const base = scratch();
    let started = 0;
    const io = {
      hlsBase: base,
      ipcRequest: async () => ({ok: false, busy: true, error: 'mpv did not answer'}),
      focus: async () => 'True',
      platform: 'linux',
      start: async () => {
        started++;
        return {ok: false, error: 'not here'};
      },
    };
    const checked = checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k#fs-id=ab', title: 'T',
      hls: {files: [{name: '0.m3u8', text: media()}]}});
    const answer = await playMpv('mpv', /** @type {*} */ (checked).play, {ipcToken: 'x'}, io);
    // The answer as before, for the extension.
    expect(answer).toEqual({ok: false, error: 'mpv is busy and did not answer: try again in a moment'});
    const folders = fs.readdirSync(base);
    expect(folders).toHaveLength(1);
    expect(fs.readdirSync(path.join(base, folders[0])).sort()).toEqual(['0.m3u8', 'target.txt']);
    expect(started).toBe(0);
  });

  it('keeps them for a new mpv that took the load into its pipe and did not answer it', async () => {
    const play = /** @type {*} */ (checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k#fs-id=ab', title: 'T',
      newWindow: true, hls: {files: [{name: '0.m3u8', text: media()}]}})).play;
    // Its pipe answers; the load after it gets no answer in time, or only the answer of the command behind it.
    for (const loadAnswer of [{ok: false, busy: true, error: 'mpv did not answer'}, {ok: true, replies: [{request_id: 2, data: 77}]}]) {
      const base = scratch();
      const stopped = [];
      const answer = await playMpv('mpv', play, {ipcToken: 'x'}, {
        hlsBase: base,
        ipcRequest: async (commands) => commands.length === 1 ? {ok: true, replies: [{request_id: 1, error: 'success', data: 77}]} : loadAnswer,
        focus: async () => 'True',
        platform: 'linux',
        start: async () => ({ok: true, pid: 77}),
        stop: (pid) => stopped.push(pid),
        randomHex: () => '0a1b2c',
      });
      expect(answer).toEqual({ok: false, error: 'the new mpv did not take the stream: try again in a moment'});
      // The mpv runs on, with the load in its pipe.
      expect(stopped).toEqual([]);
      expect(fs.readdirSync(base)).toHaveLength(1);
    }
  });

  it('keeps them when the mpv another helper was starting is busy after the wait', async () => {
    const base = scratch();
    const lockFile = launchLockFile({ipcToken: 'x'}, scratch());
    const other = takeLaunchLock(lockFile);
    expect(other.taken).toBe(true);
    let slept = 0;
    let started = 0;
    const checked = checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k#fs-id=ab', title: 'T',
      hls: {files: [{name: '0.m3u8', text: media()}]}});
    const answer = await playMpv('mpv', /** @type {*} */ (checked).play, {ipcToken: 'x'}, {
      hlsBase: base,
      lockFile,
      // No mpv at first; the other helper's is up after a second, opening its own stream.
      ipcRequest: async () => slept >= 1000 ? {ok: false, busy: true, error: 'mpv did not answer'} : {ok: false, error: 'no mpv ipc'},
      focus: async () => 'True',
      platform: 'linux',
      sleep: async (ms) => {
        slept += ms;
        if (slept >= 1000) other.release();
      },
      now: () => slept,
      start: async () => {
        started++;
        return {ok: false, error: 'not here'};
      },
    });
    expect(answer).toEqual({ok: false, error: 'mpv is busy and did not answer: try again in a moment'});
    expect(slept).toBe(1000);
    expect(started).toBe(0);
    expect(fs.readdirSync(base)).toHaveLength(1);
  });

  // Nothing may be left to remove it later (no helper runs again until the next hand-off), and its addresses are
  // browsing history: as before host 28.
  it('removes a private window\'s playlists at once all the same when mpv was only busy', async () => {
    const base = scratch();
    const checked = checkPlayMessage({type: 'play', target: 'https://cdn.test/pl/7?token=k#fs-id=ab&fs-private=1', title: 'T',
      hls: {files: [{name: '0.m3u8', text: media()}]}});
    const answer = await playMpv('mpv', /** @type {*} */ (checked).play, {ipcToken: 'x'}, {
      hlsBase: base,
      ipcRequest: async () => ({ok: false, busy: true, error: 'mpv did not answer'}),
      focus: async () => 'True',
      platform: 'linux',
      start: async () => ({ok: false, error: 'not here'}),
    });
    expect(answer).toEqual({ok: false, error: 'mpv is busy and did not answer: try again in a moment'});
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('lets ffmpeg open files for a master only, whose playlists lie beside it', () => {
    expect(hlsPlayOptions(path.join('t', HlsDirPrefix + 'x', 'master.m3u8'))['demuxer-lavf-o'])
        .toMatch(/^protocol_whitelist=\[file,http,https,tcp,tls,crypto\],format_whitelist=\[hls,/);
    expect(hlsPlayOptions(path.join('t', HlsDirPrefix + 'x', '0.m3u8'))['demuxer-lavf-o'])
        .toMatch(/^protocol_whitelist=\[http,https,tcp,tls,crypto\],/);
  });
});
