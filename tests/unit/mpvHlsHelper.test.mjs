import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {
  HlsDirPrefix, checkHlsPackage, checkPlayMessage, ffmpegAttributes, hlsAddresses, loggedMessage, playMpv,
  writeHlsPackage,
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

  it('marks a private window\'s folder, which goes ten minutes on', () => {
    const base = scratch();
    const entry = writeHlsPackage([{name: '0.m3u8', text: media()}], 'https://cdn.test/v#fs-id=ab&fs-private=1', base);
    expect(path.basename(path.dirname(entry)).startsWith(HlsDirPrefix + 'p-')).toBe(true);
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(path.dirname(entry), stale, stale);
    writeHlsPackage([{name: '0.m3u8', text: media()}], 'https://cdn.test/v', base);
    expect(fs.existsSync(path.dirname(entry))).toBe(false);
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
    expect(load.options).toMatchObject({'demuxer': 'lavf', 'demuxer-lavf-format': 'hls',
      'demuxer-lavf-o': 'protocol_whitelist=[file,http,https,tcp,tls,crypto]'});
  });
});
