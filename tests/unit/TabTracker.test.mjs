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

/**
 * A tab with a main frame (0) named 'main' holding a frame (1) named 'embed', which
 * detected a stream and a subtitle.
 * @return {{tab: Object, main: Object, embed: Object}}
 */
function tabWithEmbed() {
  const tab = new TabTracker().getTabOrCreate(7);
  const main = tab.getFrameOrCreate(0);
  main.documentKey = 'main';
  const embed = tab.getFrameOrCreate(1);
  embed.documentKey = 'embed';
  embed.setParentFrame(main);
  embed.getSources().push({url: 'https://cdn.example.com/video.m3u8', mode: 'hls'});
  embed.getSubtitles().push({source: 'https://cdn.example.com/sub.vtt'});
  return {tab, main, embed};
}

// A page Back brings out of Firefox's back-forward cache keeps its content script, which
// names it again; its leaving made the background forget its frame, and it fetches
// nothing again. What it had detected is kept under its name for it.
describe('gone pages', () => {
  it('keeps what a removed page and the pages inside it had detected', () => {
    const {tab, main} = tabWithEmbed();
    tab.forgetRemovedFrame(main, 'main');
    expect([...tab.goneDocuments.keys()]).toEqual(['main', 'embed']);
    expect(tab.goneDocuments.get('embed').sources.map((s) => s.url))
        .toEqual(['https://cdn.example.com/video.m3u8']);
    expect(tab.frames.size).toBe(0);
  });

  it('gives it back when the page names itself again, wherever its URL went', () => {
    const {tab, embed} = tabWithEmbed();
    tab.forgetRemovedFrame(embed, 'embed');
    const back = tab.getFrameOrCreate(1);
    back.documentKey = 'embed';
    back.url = 'https://example.com/embed#t=30';
    tab.restoreGoneDocument(back);
    expect(back.getSources().map((s) => s.url)).toEqual(['https://cdn.example.com/video.m3u8']);
    expect(back.getSubtitles().map((s) => s.source)).toEqual(['https://cdn.example.com/sub.vtt']);
    // It is no longer gone: a player it opens now is its own.
    expect(tab.goneDocuments.has('embed')).toBe(false);
    expect(tab.isPlayerOfGoneDocument(tab.getFrameOrCreate(2), 1, 'embed')).toBe(false);
  });

  it('gives nothing to another page', () => {
    const {tab, embed} = tabWithEmbed();
    tab.forgetRemovedFrame(embed, 'embed');
    const next = tab.getFrameOrCreate(1);
    next.documentKey = 'next';
    tab.restoreGoneDocument(next);
    expect(next.getSources()).toEqual([]);
    expect(tab.goneDocuments.has('embed')).toBe(true);
  });

  it('does not add a stream the frame already has again', () => {
    // FRAME_ADDED keeps a source the frame had at the page's own URL.
    const {tab, embed} = tabWithEmbed();
    const source = embed.getSources()[0];
    tab.forgetRemovedFrame(embed, 'embed');
    const back = tab.getFrameOrCreate(1);
    back.documentKey = 'embed';
    back.getSources().push(source);
    tab.restoreGoneDocument(back);
    expect(back.getSources()).toEqual([source]);
  });

  it('keeps the 16 pages that went last', () => {
    const tab = new TabTracker().getTabOrCreate(7);
    for (let i = 0; i < 17; i++) {
      const frame = tab.getFrameOrCreate(i);
      frame.documentKey = 'page-' + i;
      tab.forgetRemovedFrame(frame, 'page-' + i);
      if (i === 15) {
        // Gone again, it counts as the newest.
        const again = tab.getFrameOrCreate(0);
        again.documentKey = 'page-0';
        tab.forgetRemovedFrame(again, 'page-0');
      }
    }
    expect(tab.goneDocuments.size).toBe(16);
    expect(tab.goneDocuments.has('page-0')).toBe(true);
    expect(tab.goneDocuments.has('page-1')).toBe(false);
    expect(tab.goneDocuments.has('page-16')).toBe(true);
  });

  it('marks nothing when a refused player\'s frame is forgotten', () => {
    // PLAYER_LOADED of a gone page forgets the player's frame (forgetFrame): that is no
    // page leaving.
    const {tab, main} = tabWithEmbed();
    tab.forgetFrame(main);
    expect(tab.goneDocuments.size).toBe(0);
  });
});

// FRAME_REMOVED names the page that sent it. It can reach the background after the next
// page in the frame named itself; that late message must not forget the new page.
describe('forgetRemovedFrame', () => {
  it('forgets the frame of the page that sent it', () => {
    const {tab, embed} = tabWithEmbed();
    tab.forgetRemovedFrame(embed, 'embed');
    expect(tab.getFrame(1)).toBeUndefined();
  });

  it('ignores a late one from the page before', () => {
    const {tab, embed} = tabWithEmbed();
    tab.forgetRemovedFrame(embed, 'earlier');
    expect(tab.getFrame(1)).toBe(embed);
    expect(embed.getSources().length).toBe(1);
    expect(tab.goneDocuments.has('embed')).toBe(false);
  });

  it('takes a message or a frame without a name as before', () => {
    // The player page's own FRAME_REMOVED has no name, nor has content.js's for a player
    // iframe it took out; a frame whose page never named itself cannot be told by name.
    const {tab, main, embed} = tabWithEmbed();
    tab.forgetRemovedFrame(embed, undefined);
    expect(tab.getFrame(1)).toBeUndefined();
    main.documentKey = null;
    tab.forgetRemovedFrame(main, 'main');
    expect(tab.getFrame(0)).toBeUndefined();
    expect(() => tab.forgetRemovedFrame(undefined, 'main')).not.toThrow();
  });
});

// A page naming itself in a frame (FRAME_ADDED) ends the page the frame showed, and the
// pages inside it, whether their FRAME_REMOVED came first or not.
describe('noteDocumentReplaced', () => {
  it('marks the page before, and the pages inside it, gone', () => {
    const {tab, main} = tabWithEmbed();
    tab.noteDocumentReplaced(main, 'next');
    expect([...tab.goneDocuments.keys()]).toEqual(['main', 'embed']);
  });

  it('marks nothing for the same page again, or a frame without a name', () => {
    const {tab, main} = tabWithEmbed();
    tab.noteDocumentReplaced(main, 'main');
    expect(tab.goneDocuments.size).toBe(0);
    const unnamed = tab.getFrameOrCreate(5);
    tab.noteDocumentReplaced(unnamed, 'other');
    expect(tab.goneDocuments.size).toBe(0);
  });
});

// Ctrl+Shift+U, Ctrl+Shift+F's MPV exit or the toolbar's Off with a player still starting
// in an iframe of an iframe: reset, reload, and the player's late PLAYER_LOADED makes its
// frame and the frame above new ones, with no names on them.
describe('resetForReload', () => {
  it('refuses a late player of a page the reload took', () => {
    const {tab} = tabWithEmbed();
    tab.resetForReload();
    expect(tab.frames.size).toBe(0);
    const above = tab.getFrameOrCreate(1);
    const player = tab.getFrameOrCreate(2);
    player.setParentFrame(above);
    expect(tab.isPlayerOfGoneDocument(player, 1, 'embed')).toBe(true);
    expect(tab.isPlayerOfGoneDocument(tab.getFrameOrCreate(0), undefined, 'main')).toBe(true);
  });

  it('is not what a plain reset does', () => {
    // The reset on a new hostname can come after the new page named itself, or while a
    // player the tab was sent to, naming the page before, still starts.
    const {tab} = tabWithEmbed();
    tab.reset();
    expect(tab.goneDocuments.size).toBe(0);
    expect(tab.isPlayerOfGoneDocument(tab.getFrameOrCreate(0), undefined, 'main')).toBe(false);
  });
});
