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
