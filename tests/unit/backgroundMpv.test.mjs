import {afterEach, describe, expect, it, vi} from 'vitest';

import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// MPV mode through the background's real listeners: the shortcut's MPV (only a video the
// user starts goes to mpv), the allowlist's (a page's first stream goes by itself), and
// what of it outlives the event page.

const PAGE = 'https://site.test/watch/1';
const AD = 'https://cdn.test/ad/master.m3u8';
const EPISODE = 'https://cdn.test/episode/master.m3u8';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/**
 * The network: each playlist with its length, answered after a delay.
 * @param {Object<string, number>} lengths - Seconds by URL.
 * @param {number} [delayMs] - How long each answer takes.
 * @return {function(string): Promise<Object>} fetch() for loadBackground.
 */
function playlists(lengths, delayMs = 300) {
  return (url) => new Promise((resolve) => {
    setTimeout(() => {
      resolve(url in lengths ? response(hlsPlaylist(lengths[url])) : response('', 404));
    }, delayMs);
  });
}

/**
 * Turns on the shortcut's MPV in tab 1, and has the user start a video there that plays
 * for the given time, whose stream the page has not asked for yet (an MSE player's blob:).
 * @param {number} duration - The video's length.
 * @return {Promise<void>}
 */
async function playWithShortcutMpv(duration) {
  await bg.command('toggle_mpv', 1);
  expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
  await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration}},
      {tabId: 1, frameId: 0});
}

describe('the shortcut\'s MPV, a play before its stream', () => {
  it('sends the video\'s stream when an ad\'s came first and the video\'s while it was read', async () => {
    // The ad's manifest took the play's slot while its length was read; the episode's,
    // 200 ms later, found the slot taken and was only tracked. The ad was another video's
    // length, the slot came back, and nothing looked at the episode again.
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[AD]: 30, [EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: AD});
    await bg.wait(200);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends the first stream that can be the video, and only that one', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[AD]: 1400, [EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: AD});
    await bg.wait(100);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([AD]);
  });

  it('waits on when none of them can be the video, and takes the next', async () => {
    const LATER = 'https://cdn.test/later/master.m3u8';
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[AD]: 30, [EPISODE]: 45, [LATER]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: AD});
    await bg.wait(100);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
    await bg.request({tabId: 1, url: LATER});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([LATER]);
  });

  it('drops what was waiting when the tab goes to another page', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[AD]: 30, [EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: AD});
    await bg.wait(100);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('still takes the video\'s stream after the event page restarted', async () => {
    // Firefox stops an idle background, and a restart for any reason took the waiting
    // play with it: the stream the player asked for next was only tracked.
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], session,
      fetch: playlists({[EPISODE]: 1400})});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends a video once when the player plays it again after a restart', async () => {
    // A player calls play() twice, or resumes after the page was paused: within 10 s the
    // same stream only pauses the page again. Forgotten at a restart, it opened a second
    // mpv window.
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], session,
      fetch: playlists({[EPISODE]: 1400})});
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.sent('PAUSE_MEDIA')).toHaveLength(1);
  });

  it('takes the next page\'s play by itself while the last page\'s stream is still read', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[AD]: 30, [EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: AD});
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.frameAdded(1, 0, 'https://site.test/watch/2', 'page-2');
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/2', video: {src: 'blob:https://site.test/2', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });
});

describe('the allowlist\'s MPV, a play on a page Back gave back', () => {
  const A = 'https://site.test/watch/a';
  const B = 'https://site.test/watch/b';
  const SA = 'https://cdn.test/a/master.m3u8';
  const SB = 'https://cdn.test/b/master.m3u8';

  /**
   * The tab shows page A, then page B, each sending its stream to mpv by itself, and goes
   * Back to A, which Firefox's back-forward cache gives back without a request.
   * @return {Promise<void>}
   */
  async function backToA() {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: A}],
    });
    await bg.navigated(1, A);
    await bg.frameAdded(1, 0, A, 'page-a');
    await bg.request({tabId: 1, url: SA});
    await bg.message({type: 'FRAME_REMOVED', document: 'page-a'}, {tabId: 1, frameId: 0});
    await bg.navigated(1, B);
    await bg.frameAdded(1, 0, B, 'page-b');
    await bg.request({tabId: 1, url: SB});
    await bg.message({type: 'FRAME_REMOVED', document: 'page-b'}, {tabId: 1, frameId: 0});
    await bg.navigated(1, A);
    await bg.frameAdded(1, 0, A, 'page-a');
    expect(bg.toMpv()).toEqual([SA, SB]);
    // An MSE player: the video plays a blob:, no URL of the page's streams.
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/a', video: {src: 'blob:https://site.test/a', duration: null}},
        {tabId: 1, frameId: 0});
  }

  it('sends the page\'s known stream when no other went within 3 s', async () => {
    await backToA();
    await bg.wait(3500);
    expect(bg.toMpv()).toEqual([SA, SB, SA]);
  });

  it('sends nothing when the tab went to another page within the 3 s', async () => {
    // The timer was the tab's, not the page's: Back once more within 3 s gave page B back
    // with its stream, and the play on page A sent B's stream.
    await backToA();
    await bg.message({type: 'FRAME_REMOVED', document: 'page-a'}, {tabId: 1, frameId: 0});
    await bg.navigated(1, B);
    await bg.frameAdded(1, 0, B, 'page-b');
    await bg.wait(3500);
    expect(bg.toMpv()).toEqual([SA, SB]);
  });

  it('sends nothing when another page came back at the same address within the 3 s', async () => {
    // Two history entries of one URL: the address tells nothing, the page's name does.
    await backToA();
    await bg.message({type: 'FRAME_REMOVED', document: 'page-a'}, {tabId: 1, frameId: 0});
    await bg.frameAdded(1, 0, A, 'page-b');
    await bg.wait(3500);
    expect(bg.toMpv()).toEqual([SA, SB]);
  });
});

describe('a same-site link into an allowlisted or auto-enabled path', () => {
  const HOME = 'https://site.test/';
  const TRAILER = 'https://cdn.test/home/trailer.mp4';

  /**
   * The site's home page plays a trailer (a <video src>, detected while the tab is off),
   * then the user opens an episode, and the address changes before the episode's page
   * names itself (tabs.onUpdated and FRAME_ADDED come in either order).
   * @param {Object} options - The saved options.
   * @return {Promise<void>}
   */
  async function homeThenEpisode(options) {
    bg = await loadBackground({options, tabs: [{id: 1, url: HOME}]});
    await bg.navigated(1, HOME);
    await bg.frameAdded(1, 0, HOME, 'home');
    await bg.request({tabId: 1, url: TRAILER, type: 'media'});
    expect(bg.session['tabState:1']).toMatchObject({isOn: false});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
  }

  it('does not send the home page\'s trailer to mpv for the episode', async () => {
    // The allowlist's MPV started at the address change, and handed off the streams the
    // tab tracked at that moment: the home page's trailer. The episode's stream then found
    // the page already handed off, and was only tracked.
    await homeThenEpisode({mpvMode: true, mpvAllowlist: ['https://site.test/watch']});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('does not open the in-page player for the home page\'s trailer', async () => {
    await homeThenEpisode({autoEnableURLs: ['https://site.test/watch']});
    await bg.wait(1000);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
  });

  it('leaves a stream the new page asks for during the wait to its own start, captions first', async () => {
    // A stream found during the wait opens the player as any detected stream does
    // (onSourceRecieved): the page's <track> captions are read first, then the player opens
    // after replaceDelay. The start by address, half a second after the address changed,
    // opened it straight away from that same stream, and the player got the stream's
    // detected subtitle files without the page's labels (page-subtitles.e2e).
    await homeThenEpisode({autoEnableURLs: ['https://site.test/watch']});
    await bg.wait(100);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(5000);
    const types = bg.sentToTabs.map((m) => m.message.type);
    expect(types.filter((type) => type === 'OPEN_PLAYER')).toHaveLength(1);
    expect(types.indexOf('SCRAPE_CAPTIONS')).toBeGreaterThan(-1);
    expect(types.indexOf('SCRAPE_CAPTIONS')).toBeLessThan(types.indexOf('OPEN_PLAYER'));
  });

  it('drops the start when the address changes again meanwhile, and comes back', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: HOME}]});
    await bg.navigated(1, HOME);
    await bg.request({tabId: 1, url: TRAILER, type: 'media'});
    await bg.navigated(1, PAGE);
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.navigated(1, PAGE);
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('still hands off a stream a page asked for before it changed its address itself', async () => {
    // A page that changes its address with history.pushState names no new page: the
    // streams the tab tracks are that page's.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: HOME}]});
    await bg.navigated(1, HOME);
    await bg.frameAdded(1, 0, HOME, 'app');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.navigated(1, PAGE);
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });
});

describe('the allowlist\'s MPV, a page that plays a sound first', () => {
  it('sends the video, not the sound', async () => {
    // Every file a media element loaded was taken for an MP4 video, and the allowlist sends
    // a page's first stream: a notification sound went to mpv, and the video stayed.
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: 'https://site.test/sounds/ding', type: 'media'},
        {responseHeaders: [{name: 'Content-Type', value: 'audio/mpeg'}]});
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
  });
});

describe('a failed hand-off', () => {
  it('keeps the toolbar\'s "!" after the event page restarted', async () => {
    // The badge is the browser's, but a woken background redraws every tab's button from
    // what it knows, and it did not know of the failure any more.
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => ({ok: false, error: 'mpv executable not found'}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(bg.badges.get(1)).toBe('!');
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], session});
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toBe('FastStream - MPV - the stream did not open: mpv executable not found');
  });

  it('shows no "!" after a restart once a later hand-off worked', async () => {
    let answer = {ok: false, error: 'mpv executable not found'};
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => answer,
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: AD});
    expect(bg.badges.get(1)).toBe('!');
    answer = {ok: true};
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([AD, EPISODE]);
    expect(bg.badges.get(1)).toBe('');
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], session});
    expect(bg.badges.get(1)).toBe('');
  });
});
