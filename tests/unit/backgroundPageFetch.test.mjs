import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// The background's part of loading through the page (#665), through its real listeners: a player
// is told the page it may load through (PageFetch.mjs), and none when it is its tab's page itself.

const PAGE = 'https://site.test/watch/1';
const PLAYER = 'moz-extension://bg-test/player/index.html';
const PLAYER_IN_PAGE = PLAYER + '?opener=page-1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

describe('the page a player is told it may load through', () => {
  it('is the page it plays in', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const answer = await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    expect(answer).toMatchObject({tabId: 1, pageFrameId: 0});
  });

  it('is none for a player that is its tab\'s page itself', async () => {
    // It lists the other tabs' streams too (sendSourcesToMainFramePlayers), whose frames are
    // no frames of its tab.
    bg = await loadBackground({tabs: [{id: 2, url: PLAYER}]});
    await bg.navigated(2, PLAYER);
    const answer = await bg.message({type: 'PLAYER_LOADED', url: PLAYER}, {tabId: 2, frameId: 0});
    expect(answer).toMatchObject({tabId: -1, pageFrameId: -1});
  });
});
