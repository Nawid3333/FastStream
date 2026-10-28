import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// A player that goes away hands its buffer to the background (BUFFER_STASH), and the next
// player of the video on the same page takes it back (BUFFER_TAKE); nothing for another page,
// window or container, and nothing from a page that is no player.

const PAGE = 'https://site.test/watch/1';
const PLAYER = 'moz-extension://bg-test/player/index.html?opener=page-1';
const SOURCE = 'https://cdn.test/hls/x/master.m3u8';
const handOff = {type: 'BUFFER_STASH', page: PAGE, identifier: SOURCE, url: SOURCE + '?t=A', session: 'fsblob-1-2',
  entries: [{url: SOURCE.replace('master.m3u8', 'seg-1.ts?t=A'), rangeStart: undefined, rangeEnd: undefined,
    responseType: 'arraybuffer', dataSize: 3, blob: new Blob(['one'])}]};

let bg;
afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * A player in frame 5 of a tab's page, as content.js puts one there.
 * @param {number} tabId
 * @param {string} page
 * @param {Object} [tab] - The sender's tab (incognito, cookieStoreId).
 * @return {Object} The player's sender, for its messages.
 */
async function playerOn(tabId, page, tab) {
  await bg.navigated(tabId, page);
  await bg.frameAdded(tabId, 0, page, 'page-1');
  const from = {tabId, frameId: 5, url: PLAYER, ...(tab ? {tab: {id: tabId, url: page, ...tab}} : {})};
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER, parentFrameId: 0}, from);
  return from;
}

const ask = (from) => bg.message({type: 'BUFFER_TAKE', identifier: SOURCE}, from);
// What the player takes back.
const take = async (from) => (await ask(from))?.handOff ?? null;

describe('a player\'s buffer handed over as it goes', () => {
  it('is taken back by the next player of the video on the same page, once', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    const player = await playerOn(1, PAGE);
    // It asked as it set its source, and found none; it was told its page, for its hand-off.
    expect(await ask(player)).toEqual({page: PAGE, handOff: null});
    // The page reloads: its frame is the next page's before the player's hand-off comes
    // (measured: an empty address then), and a new player comes in the same place.
    await bg.navigated(1, PAGE);
    await bg.message(handOff, player);
    const next = await playerOn(1, PAGE);
    const taken = await take(next);
    expect(taken.url).toBe(SOURCE + '?t=A');
    expect(taken.session).toBe('fsblob-1-2');
    expect(taken.entries).toHaveLength(1);
    expect(await take(next)).toBeNull();
  });

  it('is no other page\'s, window\'s or container\'s', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}, {id: 2, url: PAGE}, {id: 3, url: PAGE}, {id: 4, url: PAGE}]});
    await bg.message(handOff, await playerOn(1, PAGE));
    expect(await take(await playerOn(2, 'https://site.test/watch/2'))).toBeNull();
    expect(await take(await playerOn(3, PAGE, {incognito: true}))).toBeNull();
    expect(await take(await playerOn(4, PAGE, {cookieStoreId: 'firefox-container-1'}))).toBeNull();
    // Another tab of the same page, same window kind: the same video there.
    expect((await take(await playerOn(2, PAGE)))?.entries).toHaveLength(1);
  });

  it('comes from FastStream\'s player alone', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await playerOn(1, PAGE);
    await bg.message(handOff, {tabId: 1, frameId: 5, url: PAGE});
    expect(await take(await playerOn(1, PAGE))).toBeNull();
  });

  it('is let go of after 20 s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.message(handOff, await playerOn(1, PAGE));
    await bg.wait(21000);
    expect(await take(await playerOn(1, PAGE))).toBeNull();
    vi.restoreAllMocks();
  });
});
