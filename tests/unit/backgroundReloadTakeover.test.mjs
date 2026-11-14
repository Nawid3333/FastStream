import {afterEach, describe, expect, it} from 'vitest';

import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// A tab whose page FastStream had taken over is loaded again, and the page's own player
// stayed, whatever the user did there (the owner's report, 2026-11-14). The tab is still on,
// so the player is opened about half a second after the page's first stream request - while
// the page's player is still starting, its video not on screen yet - and content.js answers
// 'no_video'. Nothing tried again: every later request was for a stream already known, and a
// play the user starts was heard only in MPV mode. Now a missed open is tried again
// (background.mjs noteOpenMissed, reopenMissed). And two ways a page's player stayed after
// the background had been started anew (an idle event page is unloaded after 30 s).

const PAGE = 'https://series-site.example/watch/1';
const EMBED = 'https://hoster.example/e/abc';
const FILM = 'https://cdn.example/film/clip.mp4';
const MASTER = 'https://cdn.example/film/master.m3u8';
const VARIANT = 'https://cdn.example/film/1080.m3u8';
const player = (opener) => `moz-extension://bg-test/player/index.html?opener=${opener}`;
const MP4 = {responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]};
const HLS = {responseHeaders: [{name: 'Content-Type', value: 'application/vnd.apple.mpegurl'}]};

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * A background whose pages answer OPEN_PLAYER with these answers, one after another (the
 * last one again after that).
 * @param {string[]} answers
 * @param {Object} [setup]
 * @return {Promise<void>}
 */
async function load(answers, setup = {}) {
  const left = [...answers];
  bg = await loadBackground({
    options: {autoEnableURLs: ['https://series-site.example/']}, tabs: [{id: 1, url: PAGE}],
    fetch: async (url) => {
      const network = {
        [MASTER]: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\n${VARIANT}\n`,
        [VARIANT]: hlsPlaylist(1400),
      };
      return network[url] === undefined ? response('', 404) : response(network[url]);
    },
    onTabMessage: ({message}) => {
      if (message.type === 'OPEN_PLAYER') return left.length > 1 ? left.shift() : left[0];
      if (message.type === 'IS_PLAYER_OPENER') return true;
      return undefined;
    },
    ...setup,
  });
}

/**
 * The first load: the page, its embed, the embed's file, and FastStream's player in the embed.
 * @param {string} url - The stream the embed's player asks for.
 * @param {Object} extra - Its response.
 * @param {string} type - The request's type.
 * @return {Promise<void>}
 */
async function firstLoadWithPlayer(url, extra, type) {
  await bg.navigated(1, PAGE);
  await bg.frameAdded(1, 0, PAGE, 'page-1');
  await bg.frameAdded(1, 3, EMBED, 'embed-1');
  await bg.request({tabId: 1, frameId: 3, parentFrameId: 0, type, url}, extra);
  await bg.wait(3000);
  expect(bg.sent('OPEN_PLAYER').map((m) => m.frameId)).toEqual([3]);
  const answer = await bg.message({type: 'PLAYER_LOADED', url: player('embed-1'), parentFrameId: 3}, {tabId: 1, frameId: 5});
  expect(answer?.isMainPlayer).toBe(true);
  await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
  await bg.wait(3000);
}

/**
 * F5: every page says it leaves (beforeunload), the player too; then the new page and its
 * embed (a new frame) name themselves.
 * @return {Promise<void>}
 */
async function reload() {
  await bg.message({type: 'FRAME_REMOVED', document: 'page-1'}, {tabId: 1, frameId: 0, url: PAGE});
  await bg.message({type: 'FRAME_REMOVED', document: 'embed-1'}, {tabId: 1, frameId: 3, url: EMBED});
  await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 5, url: player('embed-1')});
  await bg.tabChanged(1, {status: 'loading'});
  await bg.tabChanged(1, {status: 'loading', url: PAGE});
  await bg.frameAdded(1, 0, PAGE, 'page-2');
  await bg.frameAdded(1, 9, EMBED, 'embed-2');
  bg.sentToTabs.length = 0;
}

describe('control: a reload whose page shows its video in time', () => {
  it('opens the player again in the new embed', async () => {
    await load(['replace']);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER').map((m) => m.frameId)).toEqual([9]);
  });
});

describe('an open that ended without a player is tried again', () => {
  const MISS = 'no_video';
  const range = () => bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, {...MP4, statusCode: 206});
  const userPlays = (src = FILM) => bg.message({type: 'MPV_USER_PLAY', src, video: null}, {tabId: 1, frameId: 9, url: EMBED});
  const opens = () => bg.sent('OPEN_PLAYER').length;

  it('by itself a moment later: after a reload the page\'s video is on screen a little after its stream is asked for', async () => {
    await load(['replace', MISS, 'replace']);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(700);
    expect(opens()).toBe(1); // answered no_video: main stopped here, for good
    await bg.wait(1500);
    expect(opens()).toBe(2);
  });

  it('three times by itself (1, 3 and 7 s after), then no more until the page or the user does something', async () => {
    await load(['replace', MISS]);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(600);
    const seen = [];
    for (const wait of [1000, 2000, 4000, 60000]) {
      await bg.wait(wait);
      seen.push(opens());
    }
    expect(seen).toEqual([2, 3, 4, 4]);
  });

  it('when the user plays the page\'s MP4: at once', async () => {
    await load(['replace', MISS, MISS, MISS, MISS, 'replace']);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(20000);
    expect(opens()).toBe(4);
    // The video is far down the page; minutes later the user scrolls to it and presses play.
    await bg.wait(300000);
    await userPlays();
    await bg.wait(100);
    expect(opens()).toBe(5);
    // One press, two reports: one try.
    await userPlays();
    await bg.wait(100);
    expect(opens()).toBe(5);
  });

  it('when the user plays the page\'s HLS stream (master and variant known, the segments are no streams)', async () => {
    await load(['replace', MISS, MISS, MISS, MISS, 'replace']);
    await firstLoadWithPlayer(MASTER, HLS, 'xmlhttprequest');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'xmlhttprequest', url: MASTER}, HLS);
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'xmlhttprequest', url: VARIANT}, HLS);
    await bg.wait(20000);
    expect(opens()).toBe(4);
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'xmlhttprequest',
      url: 'https://cdn.example/film/seg-1.ts'}, {responseHeaders: [{name: 'Content-Type', value: 'video/mp2t'}]});
    await userPlays('blob:https://hoster.example/1');
    await bg.wait(100);
    expect(opens()).toBe(5);
  });

  it('when the page asks for the stream again, less and less often while nothing is on screen', async () => {
    await load(['replace', MISS]);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(20000);
    expect(opens()).toBe(4);
    // The page's own player plays on, unseen: a range every second for five minutes.
    for (let second = 0; second < 300; second++) {
      await range();
      await bg.wait(1000);
    }
    // 16 s after the fourth miss, then 32 s, then every minute: not three hundred times.
    const tries = opens() - 4;
    expect(tries).toBeGreaterThanOrEqual(5);
    expect(tries).toBeLessThanOrEqual(8);
  });

  it('after the page took the player\'s iframe out as it loaded: not by itself, but when the user plays', async () => {
    await load(['replace']);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(3000);
    const opened = bg.sent('OPEN_PLAYER');
    expect(opened).toHaveLength(1);
    // The page's player re-rendered as it started, and the iframe went with its old box.
    await bg.message({type: 'PLAYER_OPEN_GONE', attempt: opened[0].message.attempt}, {tabId: 1, frameId: 9, url: EMBED});
    // The page that took it out would take it out again: nothing by itself, nor as the page's
    // own player goes on asking for the file.
    for (let second = 0; second < 60; second++) {
      await range();
      await bg.wait(1000);
    }
    expect(opens()).toBe(1);
    await userPlays();
    await bg.wait(100);
    expect(opens()).toBe(2);
  });

  it('after the page took a loaded player out: not by itself, but when the user plays the page\'s video', async () => {
    await load(['replace']);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(3000);
    expect(opens()).toBe(1);
    await bg.message({type: 'PLAYER_LOADED', url: player('embed-2'), parentFrameId: 9}, {tabId: 1, frameId: 11});
    // The page re-rendered its player's box: the iframe is gone, the page's video is back.
    await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 11, url: player('embed-2')});
    for (let second = 0; second < 60; second++) {
      await range();
      await bg.wait(1000);
    }
    expect(opens()).toBe(1);
    await userPlays();
    await bg.wait(100);
    expect(opens()).toBe(2);
    // A player that goes with its page leaves nothing to open on the next one.
    await bg.message({type: 'PLAYER_LOADED', url: player('embed-2'), parentFrameId: 9}, {tabId: 1, frameId: 12});
    await bg.message({type: 'FRAME_REMOVED', document: 'embed-2'}, {tabId: 1, frameId: 9, url: EMBED});
    await bg.frameAdded(1, 9, 'https://hoster.example/e/other', 'embed-3');
    await userPlays();
    await bg.wait(100);
    expect(opens()).toBe(2);
  });

  it('not for a page the frame has left meanwhile', async () => {
    await load(['replace', MISS]);
    await firstLoadWithPlayer(FILM, MP4, 'media');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'media', url: FILM}, MP4);
    await bg.wait(600);
    expect(opens()).toBe(1);
    // The embed goes on to another page before the first try: its streams went with it.
    await bg.message({type: 'FRAME_REMOVED', document: 'embed-2'}, {tabId: 1, frameId: 9, url: EMBED});
    await bg.frameAdded(1, 9, 'https://hoster.example/e/other', 'embed-3');
    await bg.wait(20000);
    await userPlays();
    await bg.wait(100);
    expect(opens()).toBe(1);
  });

  it('control: a stream the page asks for anew opens as before', async () => {
    await load(['replace', MISS, MISS, MISS, MISS, 'replace']);
    await firstLoadWithPlayer(MASTER, HLS, 'xmlhttprequest');
    await reload();
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'xmlhttprequest', url: MASTER}, HLS);
    await bg.wait(20000);
    expect(opens()).toBe(4);
    await bg.request({tabId: 1, frameId: 9, parentFrameId: 0, type: 'xmlhttprequest', url: VARIANT}, HLS);
    await bg.wait(3000);
    expect(opens()).toBe(5);
  });
});

describe('a file played with no request, told by the page to a background started anew', () => {
  /**
   * The tab on, its page loaded, then Firefox unloads the idle background.
   * @return {Promise<void>}
   */
  async function onThenRestart() {
    const session = {};
    await load(['replace'], {session});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-2');
    bg.unload();
    await load(['replace'], {session});
  }

  it('control: told to the background that saw the page load, it opens the player', async () => {
    await load(['replace']);
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-2');
    await bg.message({type: 'LOADED_MEDIA', live: true, url: PAGE, document: 'page-2',
      resources: [{url: FILM, media: true, cors: false, time: Date.now()}]}, {tabId: 1, frameId: 0, url: PAGE});
    await bg.wait(5000);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
  });

  it('opens the player', async () => {
    await onThenRestart();
    expect(bg.badges.get(1)).toBe('On');
    await bg.message({type: 'LOADED_MEDIA', live: true, url: PAGE, document: 'page-2',
      resources: [{url: FILM, media: true, cors: false, time: Date.now()}]}, {tabId: 1, frameId: 0, url: PAGE});
    await bg.wait(5000);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
  });
});

describe('a player the page took out while the background asked whose it is', () => {
  for (const during of [false, true]) {
    it(`${during ? '' : 'control: '}opens a player for the page's next video, the player gone ${during ? 'during' : 'after'} the question`, async () => {
      const session = {};
      await load(['replace'], {session});
      await bg.navigated(1, PAGE);
      await bg.frameAdded(1, 0, PAGE, 'page-2');
      bg.unload();
      bg = await loadBackground({
        options: {autoEnableURLs: ['https://series-site.example/']}, tabs: [{id: 1, url: PAGE}], session,
        onTabMessage: ({message}) => {
          if (message.type === 'OPEN_PLAYER') return 'replace';
          if (message.type === 'IS_PLAYER_OPENER') return new Promise((resolve) => setTimeout(() => resolve(true), 50));
          return undefined;
        },
      });
      await bg.request({tabId: 1, type: 'media', url: FILM}, MP4);
      await bg.wait(3000);
      expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);

      const loaded = bg.message({type: 'PLAYER_LOADED', url: player('page-2'), parentFrameId: 0}, {tabId: 1, frameId: 5});
      if (!during) {
        await bg.wait(100);
        await loaded;
      }
      await bg.message({type: 'FRAME_REMOVED'}, {tabId: 1, frameId: 5, url: player('page-2')});
      await bg.wait(100);
      await loaded;

      await bg.request({tabId: 1, type: 'media', url: 'https://cdn.example/next/clip.mp4'}, MP4);
      await bg.wait(3000);
      expect(bg.sent('OPEN_PLAYER')).toHaveLength(2);
    });
  }
});
