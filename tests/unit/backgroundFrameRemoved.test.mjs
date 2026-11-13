import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// A frame that goes takes the frames inside it along (TabHolder.forgetFrame). A player inside
// sends its own FRAME_REMOVED as well, and it can come after its page's: the background must
// not take it for a player it lost while Firefox had unloaded it (restorePlayerFrame), make
// its frames again and count it gone a second time (a review, 2026-11-13).

const PAGE = 'https://site.test/watch/1';
const EMBED = 'https://embed.test/e/1';
const player = (opener) => `moz-extension://bg-test/player/index.html?opener=${opener}`;

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

describe('a player that goes with the frame it was in', () => {
  it('is counted gone once, also when its own leaving comes last', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.frameAdded(1, 3, EMBED, 'embed-1');
    const first = await bg.message({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 7});
    const second = await bg.message({type: 'PLAYER_LOADED', url: player('embed-1'), parentFrameId: 3}, {tabId: 1, frameId: 5});
    expect([first?.isMainPlayer, second?.isMainPlayer]).toEqual([true, false]);

    // The embed's page goes, the player inside with it; the player's own message comes last.
    await bg.message({type: 'FRAME_REMOVED', document: 'embed-1'}, {tabId: 1, frameId: 3, url: EMBED});
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 5, url: player('embed-1')});

    // The first player still plays: a new one is not the tab's main player.
    const third = await bg.message({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 9});
    expect(third?.isMainPlayer).toBe(false);
    // Nor is the gone player's page frame kept for a background started anew.
    const kept = Object.values(bg.session).find((state) => state && typeof state === 'object' && 'playerPageFrames' in state);
    expect(Object.keys(kept?.playerPageFrames || {}).sort()).toEqual(['7', '9']);
  });
});
