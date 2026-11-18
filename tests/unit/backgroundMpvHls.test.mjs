import {afterEach, describe, expect, it, vi} from 'vitest';

import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {checkHlsPackage} from '../../native-host/faststream-mpv-host.mjs';
import {loadBackground, response} from './backgroundHarness.mjs';

// MPV mode on a stream mpv cannot open from its address (docs/notes/mpv.md, "Streams mpv cannot open alone"),
// through the background's real listeners: an HLS playlist at /pl/7?token=k its server calls text/plain, whose
// segments (page-0.html) are refused without the token. Helper 27 gets its playlists with every address whole and
// plays them from a file; an older helper would play the address and fail, so nothing goes and the user is told.

const EP1 = 'https://site.test/watch/1';
const STREAM = 'https://cdn.test/pl/7?token=k';
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/content/a/page-0.html\n#EXTINF:6,\n/content/a/page-1.html\n#EXT-X-ENDLIST\n';
const LOCAL = 'D:/Temp/faststream-mpv-hls-AbC123/0.m3u8';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/**
 * The hoster: every file only with the token.
 * @param {string} url
 * @return {Object}
 */
function hoster(url) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://cdn.test' || parsed.searchParams.get('token') !== 'k') return response('', 403, 'text/html');
  if (parsed.pathname === '/pl/7') return response(MEDIA, 200, 'text/plain; charset=utf-8');
  if (parsed.pathname.startsWith('/content/')) return response('TS', 200, 'text/html');
  return response('', 404);
}

/**
 * MPV on the site, the stream found by its type, and the helper's capabilities.
 * @param {Array<string>} capabilities
 * @return {Promise<Object>} The watch's port.
 */
async function handOff(capabilities) {
  const helper = {hostVersion: RequiredHostVersion, capabilities};
  bg = await loadBackground({
    options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true, mpvAutoplayNext: true,
      autoplayCountdown: 5},
    tabs: [{id: 1, url: EP1, title: 'Show - Episode 1'}],
    fetch: async (url) => hoster(url),
    thinHost: true,
    onNative: (message) => (message.type === 'play' && message.hls ? {ok: true, ...helper, local: LOCAL} : {ok: true, ...helper}),
    onTabMessage: ({frameId, message}) => (message.type === 'GET_VIDEO_SIZE' ? (frameId === 0 ? 640 * 360 : 0) :
      message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
  });
  await bg.navigated(1, EP1);
  await bg.frameAdded(1, 0, EP1, 'ep1');
  await bg.request({tabId: 1, url: STREAM, type: 'xmlhttprequest'},
      {responseHeaders: [{name: 'Content-Type', value: 'application/vnd.apple.mpegurl'}]});
  await bg.wait(1500);
  return bg.ports.at(-1);
}

const plays = () => bg.native.filter((m) => m.type === 'play');

describe('MPV mode on a stream mpv cannot open from its address', () => {
  it('sends helper 27 its playlist with every address whole and keyed, which the helper takes', async () => {
    await handOff(['play', 'ipc', 'relay', 'hls']);
    expect(plays()).toHaveLength(1);
    const play = plays()[0];
    expect(play.target.startsWith(STREAM + '#')).toBe(true);
    expect(play.hls.files.map((f) => f.name)).toEqual(['0.m3u8']);
    expect(play.hls.files[0].text).toContain('https://cdn.test/content/a/page-0.html?token=k');
    expect(checkHlsPackage(play.hls).ok).toBe(true);
  });

  it('sends an older helper nothing, which would play the address and fail', async () => {
    await handOff(['play', 'ipc', 'relay']);
    expect(plays()).toEqual([]);
  });

  it('counts down to the next episode when mpv ends the file it plays the stream from', async () => {
    const port = await handOff(['play', 'ipc', 'relay', 'hls']);
    port.emit({type: 'relaying', hostVersion: RequiredHostVersion, capabilities: ['play', 'ipc', 'relay', 'hls']});
    await bg.wait(50);
    port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path', data: LOCAL}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: false}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: true}});
    await bg.wait(1500);
    const notice = port.sent.find((m) => m.type === 'mpv' && m.command[0] === 'script-message-to' && m.command[2] === 'show');
    expect(notice?.command[5]).toBe('next episode in 5 s (n: now, Space: stop)');
  });
});
