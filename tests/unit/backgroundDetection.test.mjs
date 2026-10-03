import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// What the background detects from a page's requests (onBeforeSendHeaders, then
// onHeadersReceived), and what it keeps of it, driven through its real listeners.

const PAGE = 'https://site.test/watch/1';
const PLAYER = 'moz-extension://bg-test/player/index.html';

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
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER, parentFrameId: 0}, {tabId: 1, frameId: 5});
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
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER, parentFrameId: 0}, {tabId: 1, frameId: 5});
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
