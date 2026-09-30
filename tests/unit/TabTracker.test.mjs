import {beforeAll, describe, expect, it} from 'vitest';

// FRAME_REMOVED: the page took a frame out. The background forgets it and the frames
// inside it, gives back their player count, and answers whatever waited for one of them
// to load - WAIT_UNTIL_MAIN_LOADED - with null, or that caller hangs for good. After
// Firefox unloaded the idle background, the frame could be one it never knew, and the
// message handler threw on it.

let TabTracker;

beforeAll(async () => {
  // BackgroundUtils, which TabTracker imports, reads the player URL when it loads.
  globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
  ({TabTracker} = await import('../../chrome/background/TabTracker.mjs'));
});

/**
 * A tab with a page frame (1) holding a player frame (2), which holds another frame (3).
 * @return {{tab: Object, page: Object, player: Object, inner: Object}}
 */
function tabWithFrames() {
  const tab = new TabTracker().getTabOrCreate(7);
  const page = tab.getFrameOrCreate(1);
  const player = tab.getFrameOrCreate(2);
  const inner = tab.getFrameOrCreate(3);
  player.setParentFrame(page);
  inner.setParentFrame(player);
  player.isPlayer = true;
  tab.playerCount = 1;
  return {tab, page, player, inner};
}

describe('forgetFrame', () => {
  it('ignores a frame it does not know', () => {
    const {tab} = tabWithFrames();
    expect(() => tab.forgetFrame(tab.getFrame(99))).not.toThrow();
    expect([...tab.frames.keys()]).toEqual([1, 2, 3]);
    expect(tab.playerCount).toBe(1);
  });

  it('forgets the frame and every frame inside it', () => {
    const {tab, page, player} = tabWithFrames();
    tab.forgetFrame(player);
    expect([...tab.frames.keys()]).toEqual([1]);
    expect(page.children.size).toBe(0);
    expect(player.parent).toBeNull();
  });

  it('gives back the players it held', () => {
    const {tab, player} = tabWithFrames();
    tab.forgetFrame(player);
    expect(tab.playerCount).toBe(0);
  });

  it('answers everything waiting for those frames to load with null', () => {
    const {tab, player, inner} = tabWithFrames();
    const answers = [];
    player.loadedCallbacks.add((value) => answers.push(['player', value]));
    inner.loadedCallbacks.add((value) => answers.push(['inner', value]));
    tab.forgetFrame(player);
    expect(answers).toEqual([['player', null], ['inner', null]]);
    expect(player.loadedCallbacks.size).toBe(0);
    expect(inner.loadedCallbacks.size).toBe(0);
  });

  it('answers the rest when one waiting caller throws', () => {
    const {tab, player} = tabWithFrames();
    const answers = [];
    player.loadedCallbacks.add(() => {
      throw new Error('a closed port');
    });
    player.loadedCallbacks.add((value) => answers.push(value));
    const error = console.error;
    console.error = () => {};
    try {
      tab.forgetFrame(player);
    } finally {
      console.error = error;
    }
    expect(answers).toEqual([null]);
  });
});

// PLAYER_LOADED from a player whose page reloaded while it started: Ctrl+Shift+U with the
// player just opened. It said it loaded after the new page's FRAME_ADDED, and the new page
// then counted as holding a player: its streams were dropped, and no player opened on it.
// The player's URL names the page that opened it, and each page names itself in FRAME_ADDED.
describe('isPlayerOfGoneDocument', () => {
  /**
   * A page frame (1) that named itself 'page-a', and a player frame (2) in it.
   * @return {{tab: Object, page: Object, player: Object}}
   */
  function pageWithPlayer() {
    const tab = new TabTracker().getTabOrCreate(7);
    const page = tab.getFrameOrCreate(1);
    page.documentKey = 'page-a';
    const player = tab.getFrameOrCreate(2);
    return {tab, page, player};
  }

  it('keeps a player the page in the frame above opened', () => {
    const {tab, player} = pageWithPlayer();
    expect(tab.isPlayerOfGoneDocument(player, 1, 'page-a')).toBe(false);
  });

  it('refuses a player that page opened once another page took the frame', () => {
    const {tab, page, player} = pageWithPlayer();
    page.resetSelfAndChildren();
    page.documentKey = 'page-b';
    expect(tab.isPlayerOfGoneDocument(player, 1, 'page-a')).toBe(true);
  });

  it('keeps a player the page sent its own frame to', () => {
    // handlePlayerOpen's redirect: the player loads in the page's frame, below the frame
    // above it, which shows a page of its own.
    const {tab, page} = pageWithPlayer();
    const outer = tab.getFrameOrCreate(0);
    outer.documentKey = 'outer';
    page.setParentFrame(outer);
    expect(tab.isPlayerOfGoneDocument(page, 0, 'page-a')).toBe(false);
  });

  it('keeps a player whose frames never named a page', () => {
    // The tab was reset for the reload and the new page has not said FRAME_ADDED yet, or
    // the background started again after the page loaded: nothing to tell by.
    const tab = new TabTracker().getTabOrCreate(7);
    const player = tab.getFrameOrCreate(2);
    expect(tab.isPlayerOfGoneDocument(player, 1, 'page-a')).toBe(false);
    tab.getFrameOrCreate(1);
    expect(tab.isPlayerOfGoneDocument(player, 1, 'page-a')).toBe(false);
  });

  it('keeps a player no content script opened', () => {
    // A page that embeds the player itself, or the player page in a tab: no opener.
    const {tab, player} = pageWithPlayer();
    expect(tab.isPlayerOfGoneDocument(player, 1, null)).toBe(false);
    expect(tab.isPlayerOfGoneDocument(player, undefined, null)).toBe(false);
  });

  it('forgets the page name when the frame resets', () => {
    const {page} = pageWithPlayer();
    page.resetSelfAndChildren();
    expect(page.documentKey).toBeNull();
  });
});
