import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';
import {loadContentScript} from './contentDom.mjs';

// content.js tells the background its page left at beforeunload, and Firefox fires
// beforeunload for navigations that never happen: a link answered with a download or a 204,
// a "Leave page?" the user said no to. The page stayed, marked gone, and the background
// refused every player it opened from then on (TabHolder.isPlayerOfGoneDocument), until a
// reload. A page still there a moment later now names itself again. Here the real
// content.js (contentDom.mjs) talks to the real background (backgroundHarness.mjs).

const PAGE = 'https://site.example/page';
const PLAYER = 'moz-extension://bg-test/player/index.html';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * Passes what content.js sent since the last call on to the background, from the tab's
 * top frame.
 * @param {Object} page - From loadContentScript.
 * @return {Promise<void>}
 */
async function deliver(page) {
  for (const message of page.sent.splice(0)) {
    await bg.message(message, {tabId: 1, frameId: 0});
  }
}

/**
 * The page opens a player in an iframe, which says it loaded.
 * @param {string} document - The page's name, which the player's URL carries (opener).
 * @param {number} frameId - The player's frame.
 * @return {Promise<*>} The background's answer: null for a refused player.
 */
function playerLoaded(document, frameId) {
  return bg.message({type: 'PLAYER_LOADED', url: `${PLAYER}?opener=${document}`, parentFrameId: 0},
      {tabId: 1, frameId});
}

describe('a page whose leaving never happened', () => {
  it('gets its players taken again once it named itself again', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    const page = loadContentScript();
    const name = page.sent.find((m) => m.type === 'FRAME_ADDED').document;
    await deliver(page);

    // A click on a download link: beforeunload, and the page stays.
    page.dispatchWindow('beforeunload');
    await deliver(page);
    expect(await playerLoaded(name, 5)).toBeNull();

    page.advance(2000);
    await deliver(page);
    expect(await playerLoaded(name, 6)).not.toBeNull();
  });
});
