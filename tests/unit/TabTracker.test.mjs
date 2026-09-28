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
