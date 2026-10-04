import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// While a FastStream player in a tab plays, every frame of the tab holds the page's own
// media paused (content.js holdPageMedia): opening the player paused only what was inside
// the box it took over, and a site's player outside it, or in another frame, played on
// under FastStream's. The players say when they play (PLAYER_PLAYING); the background
// tells every frame (HOLD_PAGE_MEDIA).

const PAGE = 'https://site.test/watch/1';
const PLAYER = 'moz-extension://bg-test/player/index.html?opener=page-1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * @return {Array<?boolean>} The holds the background sent, in order; each to every frame.
 */
function holds() {
  return bg.sent('HOLD_PAGE_MEDIA').map((m) => (m.frameId === undefined ? m.message.hold : 'one frame only'));
}

/**
 * A player in a frame of tab 1 starts or stops playing.
 * @param {number} frameId - Its frame.
 * @param {boolean} playing - Whether it plays now.
 * @return {Promise<*>}
 */
function player(frameId, playing) {
  return bg.message({type: 'PLAYER_PLAYING', playing}, {tabId: 1, frameId, url: PLAYER});
}

describe('the page\'s media under a playing player', () => {
  it('is held while the player plays, and let go when it pauses', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await player(5, true);
    await player(5, false);
    expect(holds()).toEqual([true, false]);
  });

  it('stays held while another player of the tab still plays', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await player(5, true);
    await player(7, true);
    await player(5, false);
    expect(holds()).toEqual([true, true, true]);
    await player(7, false);
    expect(holds().at(-1)).toBe(false);
  });

  it('is let go when the playing player\'s frame goes', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await player(5, true);
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 5, url: PLAYER});
    expect(holds()).toEqual([true, false]);
  });

  it('is let go when the page reports the playing player\'s iframe gone', async () => {
    // content.js names a player iframe that left the page by its frame (removePlayers).
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await player(5, true);
    await bg.message({type: 'FRAME_REMOVED', frameId: 5}, {tabId: 1, frameId: 0, url: PAGE});
    expect(holds()).toEqual([true, false]);
  });

  it('is let go when the playing player went with the page around it, without a word', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 2, 'https://embed.test/e/1', 'embed-1');
    // The player's iframe inside that frame.
    bg.requestSent({tabId: 1, frameId: 5, parentFrameId: 2, type: 'sub_frame', url: PLAYER});
    await player(5, true);
    // The frame goes on to another page, and the player inside it with it.
    await bg.frameAdded(1, 2, 'https://embed.test/e/2', 'embed-2');
    expect(holds()).toEqual([true, false]);
  });

  it('is let go when a player\'s frame goes that a restarted background never saw play', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await player(5, true);
    const session = bg.session;
    bg.unload();
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}], session});
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 5, url: PLAYER});
    expect(holds()).toEqual([false]);
  });

  it('is held in a frame that loads while the player plays', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await player(5, true);
    await bg.frameAdded(1, 9, 'https://embed.test/e/1', 'embed-1');
    expect(holds()).toEqual([true, true]);
  });

  it('is not held for a frame that loads with no player playing', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.frameAdded(1, 9, 'https://embed.test/e/1', 'embed-1');
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 9, url: 'https://embed.test/e/1'});
    expect(holds()).toEqual([]);
  });

  it('takes a play only from FastStream\'s player page', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.message({type: 'PLAYER_PLAYING', playing: true}, {tabId: 1, frameId: 0, url: PAGE});
    expect(holds()).toEqual([]);
  });
});
