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
    expect(await ask(player)).toEqual({page: PAGE, near: PAGE, handOff: null});
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

  it('is found by the tab\'s page when the stream came under another link (a new token in its path)', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}, {id: 2, url: 'https://site.test/watch/2'}]});
    const player = await playerOn(1, PAGE);
    const told = await ask(player);
    await bg.navigated(1, PAGE);
    await bg.message({...handOff, near: told.near}, player);
    const NEW = 'https://cdn.test/hls/t2/master.m3u8';
    // Another tab page finds none.
    const elsewhere = await playerOn(2, 'https://site.test/watch/2');
    expect((await bg.message({type: 'BUFFER_TAKE', identifier: NEW, url: NEW}, elsewhere))?.handOff).toBeNull();
    // Its own key finds none (another identifier): the tab's page does, lent until the player says whose it is.
    const next = await playerOn(1, PAGE);
    const lent = await bg.message({type: 'BUFFER_TAKE', identifier: NEW, url: NEW}, next);
    expect(lent?.handOff?.url).toBe(SOURCE + '?t=A');
    expect(lent?.lent).toEqual(expect.any(Number));
    expect((await bg.message({type: 'BUFFER_TAKE', identifier: NEW, url: NEW}, next))?.handOff).toBeNull();
    // Only that player says; another video's: back for its own.
    expect(await bg.message({type: 'BUFFER_LENT', lent: lent.lent, same: false}, elsewhere)).toBe(false);
    expect(await bg.message({type: 'BUFFER_LENT', lent: lent.lent, same: false}, next)).toBe(false);
    const own = await take(await playerOn(1, PAGE));
    expect(own?.url).toBe(SOURCE + '?t=A');
  });

  it('lent and found to be the new player\'s video: its for good', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    const player = await playerOn(1, PAGE);
    const told = await ask(player);
    await bg.navigated(1, PAGE);
    await bg.message({...handOff, near: told.near}, player);
    const NEW = 'https://cdn.test/hls/t2/master.m3u8';
    const next = await playerOn(1, PAGE);
    const {lent} = await bg.message({type: 'BUFFER_TAKE', identifier: NEW, url: NEW}, next);
    expect(await bg.message({type: 'BUFFER_LENT', lent, same: true}, next)).toBe(true);
    // No longer lent: a later word brings nothing back.
    expect(await bg.message({type: 'BUFFER_LENT', lent, same: false}, next)).toBe(false);
    expect(await take(await playerOn(1, PAGE))).toBeNull();
  });

  it('comes from FastStream\'s player alone', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await playerOn(1, PAGE);
    await bg.message(handOff, {tabId: 1, frameId: 5, url: PAGE});
    expect(await take(await playerOn(1, PAGE))).toBeNull();
  });

  it('is kept for the time the user picked; a private window\'s 20 s at most, and none when "Off"', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}, {id: 2, url: PAGE}], options: {bufferKeep: 3600}});
    // The background's own copy of the module (each load is a fresh one).
    const {BufferStash} = await import('../../chrome/background/BufferStash.mjs');
    const put = vi.spyOn(BufferStash.prototype, 'put');
    await bg.message(handOff, await playerOn(1, PAGE));
    await bg.message(handOff, await playerOn(2, PAGE, {incognito: true}));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls.map(([, , ms, where]) => [ms, where])).toEqual([[3600000, {ramOnly: false, near: null}], [20000, {ramOnly: true, near: null}]]);
    bg.unload();

    // "RAM only" writes nothing to the disk: its buffer stays in RAM too, 20 s at most.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}], options: {bufferKeep: 3600, bufferToDisk: false}});
    const {BufferStash: RamOnlyStash} = await import('../../chrome/background/BufferStash.mjs');
    const ramOnlyPut = vi.spyOn(RamOnlyStash.prototype, 'put');
    await bg.message(handOff, await playerOn(1, PAGE));
    await vi.waitFor(() => expect(ramOnlyPut).toHaveBeenCalledTimes(1));
    expect(ramOnlyPut.mock.calls.map(([, , ms, where]) => [ms, where])).toEqual([[20000, {ramOnly: true, near: null}]]);
    bg.unload();

    // "Off" deletes its files at once: no OPFS here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}], options: {bufferKeep: 0}});
    await bg.message(handOff, await playerOn(1, PAGE));
    expect(await take(await playerOn(1, PAGE))).toBeNull();
    vi.restoreAllMocks();
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
