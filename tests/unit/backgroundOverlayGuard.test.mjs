import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// When the player's frame goes and its iframe stays, the background tells the frames above to let
// go of what they hid.

const PAGE = 'https://site.test/watch/1';
const PLAYER = 'moz-extension://bg-test/player/index.html?opener=page-1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/** A page whose player is in frame 5. */
async function playerInPage() {
  bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
  await bg.navigated(1, PAGE);
  await bg.frameAdded(1, 0, PAGE, 'page-1');
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER, parentFrameId: 0}, {tabId: 1, frameId: 5});
  bg.sentToTabs.length = 0;
}

const releases = () => bg.sent('RELEASE_OVERLAY_GUARD').map((m) => [m.frameId, m.message.frameId]);

describe('the overlay guard over a player that went', () => {
  it('is let go by the frame above, once the player\'s frame went', async () => {
    await playerInPage();
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 5, url: PLAYER});
    expect(releases()).toEqual([[0, 5]]);
  });

  it('is not asked of anyone when a frame with no player in it goes', async () => {
    await playerInPage();
    // A frame of the page with no player in it goes: nothing to let go.
    await bg.frameAdded(1, 9, 'https://ads.test/a', 'ad-1');
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 9});
    expect(releases()).toEqual([]);
  });
});
