import {beforeAll, describe, expect, it} from 'vitest';

// FRAME_REMOVED: the page took a frame out. The background forgets it and the frames
// inside it, and gives back their player count. After Firefox unloaded the idle
// background, the frame could be one it never knew, and the message handler threw on it.

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

// The reset on a new hostname (tabs.onUpdated) races the new page's own FRAME_ADDED. A page
// Back brings out of the back-forward cache names itself again and gets its streams back;
// when the reset came after that, it wiped them, and nothing gave them back.
describe('resetForNewSite', () => {
  /**
   * A tab whose frame 0 shows a page of example.com that named itself, with an embed.
   * @return {{tab: Object, main: Object, embed: Object}}
   */
  function namedPage() {
    const {tab, main, embed} = tabWithEmbed();
    main.url = 'https://example.com/watch';
    main.getSources().push({url: 'https://cdn.example.com/main.mp4', mode: 'normal'});
    tab.continuationOptions = {autoPlay: true};
    tab.mpvAutoOpened = true;
    tab.mpvSentUrls.add('https://cdn.example.com/main.mp4');
    return {tab, main, embed};
  }

  it('keeps a page of the new site that named itself first, with the frames under it', () => {
    const {tab, main, embed} = namedPage();
    embed.isPlayer = true;
    tab.playerCount = 3;
    tab.resetForNewSite('https://example.com/watch');
    expect(tab.getFrame(0)).toBe(main);
    expect(tab.getFrame(1)).toBe(embed);
    expect(main.getSources().map((s) => s.url)).toEqual(['https://cdn.example.com/main.mp4']);
    expect(tab.playerCount).toBe(1);
    // What reset() clears is cleared all the same.
    expect(tab.continuationOptions).toBe(null);
    expect(tab.mpvAutoOpened).toBe(false);
    expect(tab.mpvSentUrls.size).toBe(0);
  });

  it('drops the page of the site the tab left, as reset() does', () => {
    const {tab} = namedPage();
    tab.resetForNewSite('https://other.example.org/');
    expect(tab.frames.size).toBe(0);
    expect(tab.playerCount).toBe(0);
  });

  it('drops a frame 0 whose page never named itself', () => {
    const {tab, main} = namedPage();
    main.documentKey = null;
    tab.resetForNewSite('https://example.com/watch');
    expect(tab.frames.size).toBe(0);
  });

  it('drops the page a player the tab was sent to replaced', () => {
    // The player page runs no content script: frame 0 still shows the page before it.
    const {tab} = namedPage();
    tab.resetForNewSite('moz-extension://test/player/index.html');
    expect(tab.frames.size).toBe(0);
  });

  it('keeps what Back gave a page, whichever of the two came first', () => {
    const {tab, main} = namedPage();
    tab.forgetRemovedFrame(main, 'main');
    // The page Back gives back names itself (FRAME_ADDED), then the reset comes.
    const back = tab.getFrameOrCreate(0);
    back.documentKey = 'main';
    back.url = 'https://example.com/watch';
    tab.restoreGoneDocument(back);
    tab.resetForNewSite('https://example.com/watch');
    expect(tab.getFrame(0)).toBe(back);
    expect(back.getSources().map((s) => s.url)).toEqual(['https://cdn.example.com/main.mp4']);
  });
});

// An open timer (background.mjs onSourceRecieved) sends OPEN_PLAYER by frame id when it
// fires. A frame the tab no longer tracks must not: whatever page has that id now gets it.
describe('isTracked', () => {
  it('stays tracked through a new page in the frame, which keeps it', () => {
    const {tab, main} = tabWithEmbed();
    main.resetSelfAndChildren();
    expect(tab.getFrameOrCreate(0)).toBe(main);
    expect(main.isTracked()).toBe(true);
  });

  it('is not tracked once forgotten', () => {
    const {tab, embed} = tabWithEmbed();
    tab.forgetRemovedFrame(embed, 'embed');
    expect(embed.isTracked()).toBe(false);
  });

  it('is not tracked once the reset on a new site dropped it, streams and all', () => {
    const {tab, main} = tabWithEmbed();
    tab.resetForNewSite('https://other.example.org/');
    const next = tab.getFrameOrCreate(0);
    expect(next).not.toBe(main);
    expect(main.isTracked()).toBe(false);
    expect(next.isTracked()).toBe(true);
  });
});

// The allowlist's MPV sends a play's stream only on a page the back-forward cache gave back
// (background.mjs onUserPlay): elsewhere the play's own stream is detected and goes by itself.
describe('restoredFromCache', () => {
  it('marks a page given back its streams, until the frame shows another page', () => {
    const {tab, main} = tabWithEmbed();
    tab.forgetRemovedFrame(main, 'main');
    const back = tab.getFrameOrCreate(0);
    expect(back.restoredFromCache).toBe(false);
    back.documentKey = 'main';
    tab.restoreGoneDocument(back);
    expect(back.restoredFromCache).toBe(true);
    back.resetSelfAndChildren();
    expect(back.restoredFromCache).toBe(false);
  });

  it('does not mark a page that never left', () => {
    const {tab, main} = tabWithEmbed();
    tab.restoreGoneDocument(main);
    expect(main.restoredFromCache).toBe(false);
  });
});

// A request's headers wait for its response by request id, which is unique in the session:
// on the tab, so the page's reset (FRAME_ADDED, a new site) does not lose those of a request
// still in flight (backgroundDetection.test.mjs drives that through the background).
describe('request headers', () => {
  it('outlive the tab\'s resets', () => {
    const tab = new TabTracker().getTabOrCreate(7);
    tab.rememberRequestHeaders('r1', [{name: 'Referer', value: 'https://a.test/'}]);
    tab.getFrameOrCreate(0).resetSelfAndChildren();
    tab.resetForReload();
    tab.resetForNewSite('https://b.test/');
    expect(tab.requestHeaders.get('r1')).toEqual([{name: 'Referer', value: 'https://a.test/'}]);
  });

  it('go when their response comes', () => {
    const tracker = new TabTracker();
    tracker.getTabOrCreate(7).rememberRequestHeaders('r1', []);
    tracker.forgetRequestHeaders(7, 'r1');
    expect(tracker.getTab(7).requestHeaders.size).toBe(0);
  });

  it('do not bring back a closed tab', () => {
    // A closing tab's requests are cancelled, and the errors can come after tabs.onRemoved.
    const tracker = new TabTracker();
    tracker.forgetRequestHeaders(7, 'r1');
    expect(tracker.getTab(7)).toBeUndefined();
  });

  it('are kept for the latest 500 requests at most', () => {
    const tab = new TabTracker().getTabOrCreate(7);
    for (let i = 0; i < 520; i++) {
      tab.rememberRequestHeaders('r' + i, []);
    }
    expect(tab.requestHeaders.size).toBe(500);
    expect(tab.requestHeaders.has('r19')).toBe(false);
    expect(tab.requestHeaders.has('r20')).toBe(true);
  });
});
