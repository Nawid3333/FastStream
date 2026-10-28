import {afterEach, describe, expect, it} from 'vitest';

import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// What the background detects from a page's requests (onBeforeSendHeaders, then
// onHeadersReceived), and what it keeps of it, driven through its real listeners.

const PAGE = 'https://site.test/watch/1';
const PLAYER = 'moz-extension://bg-test/player/index.html';
// A player in the page's frame names the page that opened it (content.js adds ?opener=),
// or the background takes no parent frame from it (#225).
const PLAYER_IN_PAGE = PLAYER + '?opener=page-1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * A player that opened in frame 5, inside the page's frame 0, asks for the page's streams.
 * @return {Promise<Array<Object>>} The sources the background sent it.
 */
async function sourcesForPlayer() {
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
  bg.sentToTabs.length = 0;
  await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
  await bg.wait(3000);
  const sent = bg.sent('SOURCES').filter((m) => m.frameId === 5);
  expect(sent).toHaveLength(1);
  return sent[0].message.sources;
}

// A player opened in a tab of its own lists the streams the other tabs' pages asked for
// (sendSourcesToMainFramePlayers), with their requests' headers.
describe('the streams a player tab lists from other tabs', () => {
  /**
   * Opens the player page in a tab of its own.
   * @param {number} tabId - The tab.
   * @return {Promise<void>}
   */
  async function openPlayerTab(tabId) {
    await bg.navigated(tabId, PLAYER);
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER}, {tabId, frameId: 0});
    bg.sentToTabs.length = 0;
  }

  /**
   * The streams a player tab was sent from elsewhere.
   * @param {number} tabId - The player's tab.
   * @return {Array<string>} Their URLs, from the latest list it got.
   */
  function listed(tabId) {
    const lists = bg.sent('SOURCES').filter((m) => m.tabId === tabId && m.message.autoSetSource === false);
    return lists.length ? lists[lists.length - 1].message.sources.map((s) => s.url) : [];
  }

  it('include a stream a page in another tab asked for', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}, {id: 2, url: PLAYER}]});
    await openPlayerTab(2);
    await bg.request({tabId: 1, url: 'https://cdn.test/v/master.m3u8'});
    expect(listed(2)).toEqual(['https://cdn.test/v/master.m3u8']);
  });

  it('leave out what was fetched outside any tab', async () => {
    // A service worker's requests have no tab (-1). Nothing ever reset what was kept for
    // them, and every player tab got the growing list, from a private window too.
    bg = await loadBackground({tabs: [{id: 2, url: PLAYER}]});
    await openPlayerTab(2);
    await bg.request({tabId: -1, url: 'https://cdn.test/sw/master.m3u8'});
    expect(listed(2)).toEqual([]);
  });

  it('stay on their side of private browsing', async () => {
    bg = await loadBackground({tabs: [
      {id: 1, url: PAGE, incognito: true},
      {id: 2, url: PLAYER, incognito: false},
      {id: 3, url: PLAYER, incognito: true},
    ]});
    await openPlayerTab(2);
    await openPlayerTab(3);
    await bg.request({tabId: 1, url: 'https://cdn.test/private/master.m3u8'});
    expect(listed(2)).toEqual([]);
    expect(listed(3)).toEqual(['https://cdn.test/private/master.m3u8']);
  });

  // One container's streams, with its cookies, went to another container's player tab
  // (review, 2026-10-09).
  it('stay in their container', async () => {
    bg = await loadBackground({tabs: [
      {id: 1, url: PAGE, cookieStoreId: 'firefox-container-1'},
      {id: 2, url: PLAYER, cookieStoreId: 'firefox-default'},
      {id: 3, url: PLAYER, cookieStoreId: 'firefox-container-1'},
    ]});
    await openPlayerTab(2);
    await openPlayerTab(3);
    await bg.request({tabId: 1, url: 'https://cdn.test/work/master.m3u8'});
    expect(listed(2)).toEqual([]);
    expect(listed(3)).toEqual(['https://cdn.test/work/master.m3u8']);
  });
});

// A player that loads again in its frame ("Reload Frame") gets what it was handed (#288),
// but not after the sources browser's Clear: embed-page-query.e2e.mjs saw the cleared
// stream sent again on every REQUEST_SOURCES.
describe('what a player was handed', () => {
  /**
   * A page that detected one stream, with a player in frame 5 that was handed it.
   * @return {Promise<void>}
   */
  async function playerHandedAStream() {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, url: 'https://cdn.test/v/master.m3u8'});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual(['https://cdn.test/v/master.m3u8']);
  }

  /**
   * The player in frame 5 asks for its sources again.
   * @return {Promise<Array<string>>} The URLs it was sent.
   */
  async function askAgain() {
    bg.sentToTabs.length = 0;
    await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
    await bg.wait(3000);
    const sent = bg.sent('SOURCES').filter((m) => m.frameId === 5);
    expect(sent).toHaveLength(1);
    return sent[0].message.sources.map((s) => s.url);
  }

  it('is sent again when the player asks again', async () => {
    await playerHandedAStream();
    expect(await askAgain()).toEqual(['https://cdn.test/v/master.m3u8']);
  });

  it('is not sent again after the player\'s list was cleared', async () => {
    await playerHandedAStream();
    await bg.message({type: 'CLEAR_SOURCES'}, {tabId: 1, frameId: 5});
    expect(await askAgain()).toEqual([]);
  });

  it('is sent again after a content script asked for the list to be cleared', async () => {
    // Only the player's "Clear Sources" button clears it (MessageSenders).
    await playerHandedAStream();
    await bg.message({type: 'CLEAR_SOURCES'}, {tabId: 1, frameId: 5, url: 'https://site.test/watch'});
    expect(await askAgain()).toEqual(['https://cdn.test/v/master.m3u8']);
  });
});

describe('a page that is never left', () => {
  it('keeps its manifest and a bounded number of its stream\'s pieces', async () => {
    // Shaka Packager names a DASH stream's pieces .mp4 and its subtitle pieces .vtt: each
    // is a source or a subtitle of its own (source-length.e2e.mjs), thousands in an evening.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, url: 'https://cdn.test/v/manifest.mpd'});
    for (let n = 1; n <= 60; n++) {
      await bg.request({tabId: 1, url: `https://cdn.test/v/video-${n}.mp4`});
      await bg.request({tabId: 1, url: `https://cdn.test/v/text-${n}.vtt`});
    }
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    bg.sentToTabs.length = 0;
    await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
    await bg.wait(3000);
    const {sources, subtitles} = bg.sent('SOURCES').find((m) => m.frameId === 5).message;
    expect(sources.map((s) => s.url)).toEqual([
      'https://cdn.test/v/manifest.mpd',
      'https://cdn.test/v/video-1.mp4',
      ...Array.from({length: 19}, (_, i) => `https://cdn.test/v/video-${42 + i}.mp4`),
    ]);
    expect(subtitles).toHaveLength(20);
  });
});

describe('request headers', () => {
  it('keeps those of a request the page sent before it named itself', async () => {
    // A preload (Link: rel=preload, 103 Early Hints) goes out before the content script
    // runs, and its response can come after the page's FRAME_ADDED. The headers the CDN
    // checks (Referer) went with the page's reset, and the player's requests got a 403.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    const manifest = bg.requestSent({tabId: 1, url: 'https://cdn.test/v/master.m3u8'});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.responded(manifest);

    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual(['https://cdn.test/v/master.m3u8']);
    expect(sources[0].headers).toEqual([{name: 'Referer', value: 'https://site.test/'}]);
  });

  it('keeps them across the reset when the tab goes to another site', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: 'https://old.test/'}]});
    await bg.navigated(1, 'https://old.test/');
    const manifest = bg.requestSent({tabId: 1, url: 'https://cdn.test/v/master.m3u8'});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.responded(manifest);

    const sources = await sourcesForPlayer();
    expect(sources[0].headers).toEqual([{name: 'Referer', value: 'https://site.test/'}]);
  });
});

describe('a stream named in a request\'s query', () => {
  it('is no stream from a tracking pixel or a script, and one through a proxy', async () => {
    // Every kind of request reached the query fallback: an analytics pixel reporting the
    // media URL it watched (v=https://cdn/.../master.m3u8) was taken for the stream -
    // opened in the player, and sent to mpv ahead of the real manifest.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, type: 'image', url: 'https://analytics.test/pixel?c=1&v=https://cdn.test/x/master.m3u8'},
        {responseHeaders: [{name: 'Content-Type', value: 'image/gif'}]});
    await bg.request({tabId: 1, type: 'script', url: 'https://analytics.test/watch.js?src=https://cdn.test/y/master.m3u8'},
        {responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}]});
    await bg.request({tabId: 1, type: 'xmlhttprequest', url: 'https://cdn.test/proxy?url=https://cdn.test/z/index.m3u8'},
        {responseHeaders: [{name: 'Content-Type', value: 'application/octet-stream'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual(['https://cdn.test/proxy?url=https://cdn.test/z/index.m3u8']);
  });
});

// The stream a page asks for through a redirect (upstream #585, asked on #592): the request's
// response at the end of it, not the redirect's own, which Firefox shows as well. The real
// page's run is ext-specs/redirected-source.e2e.mjs.
describe('a stream reached through a redirect', () => {
  const LINK = 'https://hoster.test/go/7/clip.mp4';
  const CDN = 'https://cdn.test/v/7?tok=1';

  it('is the CDN\'s address, which the link led to, once', async () => {
    // Taken by the .mp4 in the link, the redirect's response was a stream of its own: the
    // player played the link, and its requests got to the CDN without the page's Referer.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const sent = bg.requestSent({tabId: 1, type: 'media', url: LINK});
    await bg.responded(bg.redirected(sent, CDN), {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual([CDN]);
    expect(sources[0].headers).toEqual([{name: 'Referer', value: 'https://site.test/'}]);
  });

  it('waits for a CDN slower than the player\'s opening', async () => {
    // No player on the redirect alone: it opens at the CDN's answer. Before, the player opened
    // on the link, and the CDN's answer came to a frame with a player, whose streams are not
    // taken any more.
    bg = await loadBackground({options: {autoEnableURLs: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const atCdn = bg.redirected(bg.requestSent({tabId: 1, type: 'media', url: LINK}), CDN);
    // Past the opening delay (replaceDelay, 500 ms) and the wait for the stream's length.
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
    await bg.responded(atCdn, {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual([CDN]);
  });

  it('is the file a 3xx without a Location is', async () => {
    // Firefox follows no redirect there: the response is the file.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, type: 'media', url: LINK},
        {statusCode: 302, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual([LINK]);
  });

  it('goes by the query of a proxy link redirected to an address that names nothing', async () => {
    const proxy = 'https://proxy.test/get?url=https%3A%2F%2Fcdn.test%2Fv%2Findex.m3u8';
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const sent = bg.requestSent({tabId: 1, url: proxy});
    await bg.responded(bg.redirected(sent, CDN), {responseHeaders: [{name: 'Content-Type', value: 'application/octet-stream'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => [s.url, s.mode])).toEqual([[CDN, 'accelerated_hls']]);
  });

  it('goes by the type a link opened in the tab named', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const sent = bg.requestSent({tabId: 1, type: 'main_frame', url: 'https://hoster.test/go/7/master.m3u8'});
    await bg.responded(bg.redirected(sent, CDN), {responseHeaders: [{name: 'Content-Type', value: 'application/octet-stream'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => [s.url, s.mode])).toEqual([[CDN, 'accelerated_hls']]);
  });

  it('goes by the type the link named, when the CDN\'s address names none', async () => {
    // hls.js fetches the manifest; the CDN calls it application/octet-stream.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const sent = bg.requestSent({tabId: 1, url: 'https://hoster.test/go/7/master.m3u8'});
    await bg.responded(bg.redirected(sent, CDN), {responseHeaders: [{name: 'Content-Type', value: 'application/octet-stream'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => [s.url, s.mode])).toEqual([[CDN, 'accelerated_hls']]);
  });

  it('is none when the link led to a page', async () => {
    // A link run out, sent to the hoster's "expired" page: the player opened on it.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const sent = bg.requestSent({tabId: 1, type: 'media', url: LINK});
    await bg.responded(bg.redirected(sent, 'https://hoster.test/expired'),
        {responseHeaders: [{name: 'Content-Type', value: 'text/html; charset=utf-8'}]});
    expect(await sourcesForPlayer()).toEqual([]);
  });

  it('is none when the link\'s own address answers with a page', async () => {
    // The "expired" page at …/clip.mp4 itself: the .mp4 named it a video, in a <video> and
    // opened in a frame or the tab alike.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    for (const type of ['media', 'sub_frame', 'main_frame']) {
      await bg.request({tabId: 1, type, url: LINK}, {responseHeaders: [{name: 'Content-Type', value: 'text/html'}]});
    }
    expect(await sourcesForPlayer()).toEqual([]);
  });
});

describe('a stream fetched with a header of the page\'s own', () => {
  it('has the fetch\'s headers, not its preflight\'s or a HEAD\'s', async () => {
    // Firefox shows add-ons the CORS preflight (OPTIONS) before the fetch: answered 200, its
    // headers, without the page's token, were taken for the stream's, and the server refused
    // the player.
    const url = 'https://api.test/live/master.m3u8';
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, url, method: 'OPTIONS', requestHeaders: [
      {name: 'Access-Control-Request-Method', value: 'GET'}, {name: 'Access-Control-Request-Headers', value: 'x-token'}]});
    await bg.request({tabId: 1, url, method: 'HEAD', requestHeaders: [{name: 'Referer', value: 'https://site.test/'}]});
    await bg.request({tabId: 1, url, method: 'GET', requestHeaders: [
      {name: 'Referer', value: 'https://site.test/'}, {name: 'X-Token', value: 'abc'}]});
    const sources = await sourcesForPlayer();
    expect(sources.map((s) => s.url)).toEqual([url]);
    expect(sources[0].headers).toEqual([{name: 'Referer', value: 'https://site.test/'}, {name: 'X-Token', value: 'abc'}]);
  });
});

// A copy-protected video (DRM) stays in the page's own player: FastStream's loaded it and
// showed nothing (Vimeo, 2026-10-28). The background reads the master and its first variant
// for the length anyway (StreamLengths), and the variant's keys tell.
describe('a copy-protected video', () => {
  const FILM = 'https://cdn.test/film/master.m3u8';
  const TRAILER = 'https://cdn.test/trailer/master.m3u8';
  const AD = 'https://ads.test/ad/index.m3u8';
  const WIDEVINE = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAANHBzc2g=",' +
    'KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
  const master = (dir) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nhttps://cdn.test/${dir}/1080.m3u8\n`;
  const drm = (seconds) => hlsPlaylist(seconds).replace('#EXT-X-VERSION:3', `#EXT-X-VERSION:3\n${WIDEVINE}`);

  /**
   * An auto-enabled page that asks for these streams, one after another.
   * @param {Object<string, string>} network - The playlists by URL.
   * @param {string[]} streams - What the page asks for.
   * @param {number} [delayMs] - How long the background's reads take.
   */
  async function page(network, streams, delayMs = 0) {
    bg = await loadBackground({
      options: {autoEnableURLs: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: (url) => new Promise((resolve) => setTimeout(() =>
        resolve(network[url] === undefined ? response('', 404) : response(network[url])), delayMs)),
    });
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    for (const url of streams) {
      const type = url.endsWith('.mpd') ? 'application/dash+xml' : 'application/vnd.apple.mpegurl';
      await bg.request({tabId: 1, type: 'xmlhttprequest', url}, {responseHeaders: [{name: 'Content-Type', value: type}]});
    }
    // Past the opening delay and the wait for the lengths.
    await bg.wait(3000);
  }

  it('opens no player in place of the page\'s, and the toolbar button says why', async () => {
    await page({[FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': drm(1400)}, [FILM]);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
    expect(bg.badges.get(1)).toBe('DRM');
    expect(bg.titles.get(1)).toContain('copy-protected');
  });

  it('nor for the page\'s clear ad: the film is what the player would play', async () => {
    // Left out of the pick, the copy-protected film let the ad win it, and the ad played.
    await page({
      [AD]: hlsPlaylist(30),
      [FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': drm(1400),
    }, [AD, FILM]);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
  });

  it('is a copy-protected trailer beside a clear film, which opens', async () => {
    await page({
      [TRAILER]: master('trailer'), 'https://cdn.test/trailer/1080.m3u8': drm(120),
      [FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': hlsPlaylist(1400),
    }, [TRAILER, FILM]);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
    expect(bg.badges.get(1)).toBe('On');
  });

  it('opens the player for an AES-128 stream, which FastStream decrypts itself', async () => {
    const aes = hlsPlaylist(1400).replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    await page({[FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': aes}, [FILM]);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
  });

  it('is a DASH stream too, its manifest read slower than the opening delay', async () => {
    // The read answers after replaceDelay (500 ms), within the wait for the lengths: not
    // waited for, the stream counted as clear, and the player opened on it.
    const mpd = '<MPD type="static" mediaPresentationDuration="PT24M"><Period><AdaptationSet contentType="video">' +
      '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>' +
      '<Representation id="1" width="1920"/></AdaptationSet></Period></MPD>';
    await page({'https://cdn.test/film/manifest.mpd': mpd}, ['https://cdn.test/film/manifest.mpd'], 1200);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
    expect(bg.badges.get(1)).toBe('DRM');
  });

  it('says nothing over FastStream\'s player when another frame asks for a copy-protected stream', async () => {
    // A frame with a player takes no more streams (onHeadersReceived), another frame does: an
    // embed's copy-protected trailer gets no player, and no "DRM" over the film FastStream plays.
    await page({
      [FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': hlsPlaylist(1400),
      [TRAILER]: master('trailer'), 'https://cdn.test/trailer/1080.m3u8': drm(3000),
    }, [FILM]);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    await bg.frameAdded(1, 7, 'https://embed.test/e/1', 'embed-1');
    await bg.request({tabId: 1, frameId: 7, parentFrameId: 0, type: 'xmlhttprequest', url: TRAILER},
        {responseHeaders: [{name: 'Content-Type', value: 'application/vnd.apple.mpegurl'}]});
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
    expect(bg.badges.get(1)).toBe('On');
  });

  it('says nothing either when another frame\'s clear video opens a player', async () => {
    bg = await loadBackground({
      options: {autoEnableURLs: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: async (url) => {
        const network = {[FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': drm(1400),
          [TRAILER]: master('trailer'), 'https://cdn.test/trailer/1080.m3u8': hlsPlaylist(1400)};
        return network[url] === undefined ? response('', 404) : response(network[url]);
      },
    });
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.frameAdded(1, 7, 'https://embed.test/e/1', 'embed-1');
    const hls = {responseHeaders: [{name: 'Content-Type', value: 'application/vnd.apple.mpegurl'}]};
    await bg.request({tabId: 1, type: 'xmlhttprequest', url: FILM}, hls);
    await bg.request({tabId: 1, frameId: 7, parentFrameId: 0, type: 'xmlhttprequest', url: TRAILER}, hls);
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER').map((m) => m.frameId)).toEqual([7]);
    expect(bg.badges.get(1)).toBe('On');
  });

  it('is forgotten on the next page', async () => {
    await page({[FILM]: master('film'), 'https://cdn.test/film/1080.m3u8': drm(1400)}, [FILM]);
    expect(bg.badges.get(1)).toBe('DRM');
    await bg.navigated(1, 'https://site.test/watch/2');
    expect(bg.badges.get(1)).toBe('On');
  });
});
