import {afterEach, describe, expect, it, vi} from 'vitest';

import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
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

  it('sends nothing when the toolbar turned MPV off within the 3 s', async () => {
    // Off means off: nothing in the tab goes to mpv after it.
    await backToA();
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
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

describe('the allowlist\'s MPV, an address that changes only after its #', () => {
  // A gap #147 named: what a hash-only change does to a page the allowlist handed off.
  // isSamePageUrlChange says which of them is a new page.
  const EPISODE_2 = 'https://cdn.test/episode-2/master.m3u8';

  /**
   * An allowlisted page whose stream went to mpv by itself.
   * @param {string} page - Its address.
   * @return {Promise<void>}
   */
  async function handedOff(page) {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: page}]});
    await bg.navigated(1, page);
    await bg.frameAdded(1, 0, page, 'episode');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  }

  it('sends nothing again, and keeps the page, when only its anchor changes', async () => {
    await handedOff(PAGE);
    const removals = bg.sent('REMOVE_PLAYERS').length;
    await bg.navigated(1, PAGE + '#comments');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(bg.sent('REMOVE_PLAYERS')).toHaveLength(removals);
  });

  it('hands off the next page\'s stream after a hash route, a page of its own', async () => {
    await handedOff('https://site.test/#/watch/1');
    const removals = bg.sent('REMOVE_PLAYERS').length;
    await bg.navigated(1, 'https://site.test/#/watch/2');
    await bg.request({tabId: 1, url: EPISODE_2});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE, EPISODE_2]);
    expect(bg.sent('REMOVE_PLAYERS')).toHaveLength(removals + 1);
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
    answer = {ok: true, hostVersion: RequiredHostVersion};
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

// The host is not part of the extension: the copy a PC runs stays as it is through an
// extension update and a `git pull`. Until 2026-10-04 an e-mail said to install it again;
// now the button does, where MPV mode is used.
describe('an outdated mpv host', () => {
  const OUTDATED = 'FastStream - MPV - the mpv host on this computer is out of date: ' +
    'run update-local.cmd (or native-host\\install.ps1) in the FastStream repository';

  it('gets the stream, and the toolbar says to install the host again', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      // A host from before it sent its version.
      onNative: () => ({ok: true}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toBe(OUTDATED);
    const session = bg.session;
    bg.unload();

    // And still after the event page restarted, as a failed hand-off's "!" does.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], session});
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toBe(OUTDATED);
  });

  it('shows the reason first when the hand-off failed as well', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => ({ok: false, error: 'mpv executable not found'}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toBe('FastStream - MPV - the stream did not open: mpv executable not found');
  });

  it('is forgotten once the host answers as a current one', async () => {
    let answer = {ok: true, hostVersion: RequiredHostVersion - 1};
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => answer,
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: AD});
    expect(bg.badges.get(1)).toBe('!');
    // The host was installed again; the next page's stream goes through the new one.
    answer = {ok: true, hostVersion: RequiredHostVersion};
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([AD, EPISODE]);
    expect(bg.badges.get(1)).toBe('');
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });
});

// A tab a tab in MPV opens - a site's player in a pop-up tab, an episode middle-clicked -
// starts in MPV too, the MPV key's way: only a video the user starts there goes (#337).
describe('a tab a tab in MPV opens', () => {
  const POPUP = 'https://embed.test/e/1';

  /**
   * The user starts the video in tab 2, whose stream the page asks for next.
   * @return {Promise<void>}
   */
  async function playInPopup() {
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://embed.test/1', video: {src: '', duration: 1400}},
        {tabId: 2, frameId: 0});
    await bg.request({tabId: 2, url: EPISODE});
    await bg.wait(1000);
  }

  it('starts in MPV, and sends the video the user starts there', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await bg.command('toggle_mpv', 1);
    await bg.opened({id: 2, openerTabId: 1});
    expect(bg.session['tabState:2']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
    expect(bg.titles.get(2)).toContain('MPV');
    await bg.navigated(2, POPUP);
    await playInPopup();
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends nothing the pop-up plays by itself: most are ads', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[AD]: 30})});
    await bg.command('toggle_mpv', 1);
    await bg.opened({id: 2, openerTabId: 1});
    await bg.navigated(2, POPUP);
    await bg.request({tabId: 2, url: AD});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('takes the MPV key\'s way from the allowlist\'s MPV as well, not its first stream', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], fetch: playlists({[AD]: 30})});
    await bg.navigated(1, PAGE);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: true, mpvOnPlay: false});
    await bg.opened({id: 2, openerTabId: 1});
    await bg.navigated(2, POPUP);
    expect(bg.session['tabState:2']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
    await bg.request({tabId: 2, url: AD});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('inherits with the pop-up guard switched off too, which then closes nothing', async () => {
    bg = await loadBackground({options: {mpvMode: true, blockPopupsWhilePlaying: false}, tabs: [{id: 1, url: PAGE}]});
    await bg.command('toggle_mpv', 1);
    await bg.message({type: 'POPUP_GUARD_ARM'}, {tabId: 1, frameId: 0});
    await bg.opened({id: 2, openerTabId: 1});
    expect(bg.removedTabs).toEqual([]);
    expect(bg.session['tabState:2']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
  });

  it('leaves it alone when the opener has the in-page player on, or was turned off from MPV', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: 'https://other.test/watch/1'}, {id: 3, url: PAGE}]});
    // FastStream on, not MPV.
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.opened({id: 2, openerTabId: 1});
    // The allowlist's MPV, then the toolbar: Off.
    await bg.navigated(3, PAGE);
    await bg.click(3);
    expect(bg.session['tabState:3']).toMatchObject({isOn: false});
    await bg.opened({id: 4, openerTabId: 3});
    expect(bg.session['tabState:2']?.isMpv).not.toBe(true);
    expect(bg.session['tabState:4']?.isMpv).not.toBe(true);
  });

  it('gives nothing to a pop-up the guard closes', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.command('toggle_mpv', 1);
    await bg.message({type: 'POPUP_GUARD_ARM'}, {tabId: 1, frameId: 0});
    await bg.opened({id: 2, openerTabId: 1});
    expect(bg.removedTabs).toEqual([2]);
    expect(bg.session['tabState:2']?.isMpv).not.toBe(true);
  });

  it('leaves a tab alone whose opener is not in MPV, or that names none', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.opened({id: 2, openerTabId: 1});
    await bg.command('toggle_mpv', 1);
    await bg.opened({id: 3});
    expect(bg.session['tabState:2']?.isMpv).not.toBe(true);
    expect(bg.session['tabState:3']?.isMpv).not.toBe(true);
  });

  it('leaves it alone while MPV mode is off', async () => {
    // The tab went to MPV before the option was switched off.
    bg = await loadBackground({options: {mpvMode: false}, tabs: [{id: 1, url: PAGE}],
      session: {'tabState:1': {url: PAGE, isOn: true, isMpv: true, mpvOnPlay: true}}});
    await bg.opened({id: 2, openerTabId: 1});
    expect(bg.session['tabState:2']?.isMpv).not.toBe(true);
  });
});

// A playlist of the seek bar's thumbnails and a piece of a stream, as the background's
// length reads (StreamLengths) see them: the playlist says EXT-X-IMAGES-ONLY, and a media
// segment starts with styp and moof.
const THUMBS = 'https://cdn.test/episode/thumbs.m3u8';
const PIECE = 'https://cdn.test/episode/seg-14.mp4';
const THUMBS_PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-IMAGES-ONLY',
  '#EXTINF:10.0,', 'tile-1.jpg', '#EXTINF:10.0,', 'tile-2.jpg', '#EXT-X-ENDLIST'].join('\n');

/**
 * The start of a media segment: a styp box, then a moof.
 * @return {Uint8Array} Its bytes.
 */
function segmentBytes() {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 24);
  bytes.set(new TextEncoder().encode('stypmsdh'), 4);
  view.setUint32(24, 8);
  bytes.set(new TextEncoder().encode('moof'), 28);
  return bytes;
}

/**
 * The network: the episode's playlist (1400 s), the thumbnails' playlist and a segment,
 * each answered after a delay; a 404 for anything else.
 * @param {number} [delayMs] - How long each answer takes.
 * @return {function(string): Promise<Object>} fetch() for loadBackground.
 */
function episodeFiles(delayMs = 100) {
  const bodies = {[EPISODE]: hlsPlaylist(1400), [THUMBS]: THUMBS_PLAYLIST, [PIECE]: segmentBytes()};
  return (url) => new Promise((resolve) => {
    setTimeout(() => resolve(url in bodies ? response(bodies[url]) : response('', 404)), delayMs);
  });
}

describe('the shortcut\'s MPV, a stream that shows no video of its own', () => {
  // The lengths of the seek bar's thumbnails and of a piece of a stream are no lengths
  // (STILLS_LENGTH, PIECE_LENGTH), and StreamPick.conflicts took them for unknown ones: a
  // play waiting for its stream took the first of them that came. mpv showed the
  // thumbnails, or played a few seconds of the video.

  it('waits on past the seek bar\'s thumbnails for the video\'s stream', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: episodeFiles()});
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: THUMBS});
    await bg.wait(50);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('waits on past a piece of a stream', async () => {
    // The player's next segment, its manifest one the background did not see.
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: episodeFiles()});
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: PIECE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends no piece for a play in a frame that detected nothing else', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: episodeFiles()});
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: PIECE});
    await bg.request({tabId: 1, url: PIECE.replace('14', '15')});
    await bg.wait(500);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: '', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });
});

describe('the allowlist\'s MPV, a stream already known to show no video', () => {
  it('does not send the seek bar\'s thumbnails the page\'s last load read', async () => {
    // The allowlist sends a page's first stream as it is detected, before its length is
    // read: a playlist of stills asked for first still goes the first time. One read
    // before, here on the page's last load, does not.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], fetch: episodeFiles()});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'load-1');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.request({tabId: 1, url: THUMBS});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
    // The page is loaded again: the same address is a page of its own.
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'load-2');
    await bg.request({tabId: 1, url: THUMBS});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE, EPISODE]);
  });
});

describe('the shortcut\'s MPV after Firefox stopped the event page', () => {
  it('asks the page what it loaded, and sends the video\'s stream from that', async () => {
    // MPV has no extension page open to keep the background running, and the streams it
    // detected go when Firefox stops it. The page asked for its manifest as it opened, and
    // asks for none when the user starts the video: nothing went to mpv, and the video
    // played in the page. content.js answers REPORT_LOADED_MEDIA with a LOADED_MEDIA.
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], session,
      fetch: playlists({[EPISODE]: 1400})});
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: '', duration: 1400}},
        {tabId: 1, frameId: 0});
    expect(bg.sent('REPORT_LOADED_MEDIA')).toHaveLength(1);
    await bg.message({type: 'LOADED_MEDIA', url: PAGE, document: 'page-1',
      resources: [{url: EPISODE, media: false, time: Date.now() - 60000}]}, {tabId: 1, frameId: 0});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
    // With the browser's User-Agent, which the page's request had: mpv's own is refused by
    // CDNs, and the request's own headers went with the background that saw it.
    const open = bg.native.find((m) => m.type === 'open');
    expect(open.headers).toContainEqual({name: 'User-Agent', value: navigator.userAgent});
  });
});

describe('a hand-off the host answers after the tab went on to the next page', () => {
  // A fresh mpv answers seconds after the send (WMI, then the wait for its window), and
  // the answer went to whatever page the tab showed by then.
  const PAGE_2 = 'https://site.test/watch/2';

  /**
   * The mpv host: an open answered after 2 s, as a fresh mpv's is; the decoder question
   * at once.
   * @param {Object} openAnswer - The answer to the open.
   * @return {function(Object): *} onNative for loadBackground.
   */
  function slowHost(openAnswer) {
    return (message) => (message.type === 'open' ?
      new Promise((resolve) => setTimeout(() => resolve(openAnswer), 2000)) :
      {ok: true, running: true, hostVersion: RequiredHostVersion, decoder: {api: 'no', format: 'h264', width: 1280, height: 720}});
  }

  /**
   * The user starts a video in the shortcut's MPV, and goes on to the next page before
   * the host answered.
   * @param {Object} openAnswer - The host's answer to the open.
   * @return {Promise<void>}
   */
  async function playThenNextPage(openAnswer) {
    bg = await loadBackground({options: {mpvMode: true, mpvSingleInstance: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}, 50), onNative: slowHost(openAnswer)});
    await bg.navigated(1, PAGE);
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(500);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: '', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([EPISODE]);
    await bg.navigated(1, PAGE_2);
    await bg.frameAdded(1, 0, PAGE_2, 'page-2');
    await bg.wait(3000);
  }

  it('pauses nothing on the next page, and asks mpv nothing for it', async () => {
    await playThenNextPage({ok: true, hostVersion: RequiredHostVersion});
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
    expect(bg.native.filter((m) => m.type === 'status')).toEqual([]);
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });

  it('shows the page before\'s failure not on the next page', async () => {
    await playThenNextPage({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion});
    expect(bg.badges.get(1)).toBe('');
    expect(bg.session['tabState:1'].mpvError).toBe(null);
  });

  it('lets no late failure of the page before send the next page\'s second stream', async () => {
    // The allowlist's MPV: the failure opened the page's hand-off again, and the next page,
    // whose stream had gone already, sent its next one too.
    const A = 'https://cdn.test/a/master.m3u8';
    const B = 'https://cdn.test/b/master.m3u8';
    const C = 'https://cdn.test/b/ad.m3u8';
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: (m) => (m.type === 'open' && m.url === A ?
        new Promise((resolve) => setTimeout(() => resolve({ok: false, error: 'mpv quit right after it started',
          hostVersion: RequiredHostVersion}), 2000)) :
        {ok: true, hostVersion: RequiredHostVersion}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: A});
    await bg.wait(500);
    await bg.navigated(1, PAGE_2);
    await bg.frameAdded(1, 0, PAGE_2, 'page-2');
    await bg.request({tabId: 1, url: B});
    await bg.wait(2000);
    await bg.request({tabId: 1, url: C});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([A, B]);
  });
});

describe('MPV mode switched off in the options', () => {
  // The option is the switch for the whole mpv integration, but a tab kept the mode it was
  // in: on a site on both the MPV Allowlist and the auto-enable list, every page's stream
  // went on to mpv.

  /**
   * The options page saves MPV mode off and says so.
   * @return {Promise<void>}
   */
  async function switchOff() {
    bg.options.mpvMode = false;
    await bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99});
  }

  it('takes a tab out of MPV, to the in-page player where the auto-enable list turns it on', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], autoEnableURLs: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    await switchOff();
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false, mpvOnPlay: false});
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.frameAdded(1, 0, 'https://site.test/watch/2', 'page-2');
    await bg.request({tabId: 1, url: 'https://cdn.test/episode-2/master.m3u8'});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
  });

  it('turns a tab in the MPV key\'s MPV off', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.command('toggle_mpv', 1);
    await switchOff();
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false, mpvOnPlay: false});
  });

  it('takes a tab out of MPV that a woken background put back in it', async () => {
    bg = await loadBackground({options: {mpvMode: false, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      session: {'tabState:1': {url: PAGE, isOn: true, isMpv: true, mpvOnPlay: false, regexMatched: true, mpvMatched: true}}});
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([]);
  });
});

describe('the toolbar button after MPV off and on again', () => {
  it('no longer shows the last hand-off\'s failure, with nothing sent since', async () => {
    let answer = {ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion};
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}), onNative: () => answer});
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.badges.get(1)).toBe('!');
    // mpv is put right, and the user turns MPV off and on again.
    answer = {ok: true, hostVersion: RequiredHostVersion};
    await bg.command('toggle_mpv', 1);
    await bg.command('toggle_mpv', 1);
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(bg.badges.get(1)).toBe('');
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });
});

describe('a tab closed right after its hand-off', () => {
  it('is not saved again by mpv\'s answer to the decoder question', async () => {
    // The stream plays in mpv, and the user closes the tab. The question takes up to 20 s,
    // and its answer saved the closed tab's state again: every later background made a
    // holder of it.
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
      onNative: (m) => (m.type === 'status' ?
        new Promise((resolve) => setTimeout(() => resolve({ok: true, running: true, hostVersion: RequiredHostVersion,
          decoder: {api: 'd3d11va', format: 'hevc', width: 1920, height: 1080}}), 5000)) :
        {ok: true, hostVersion: RequiredHostVersion}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    await bg.closed(1);
    await bg.wait(6000);
    expect(bg.session).not.toHaveProperty('tabState:1');
  });
});

describe('a message that wakes the background', () => {
  // The message that starts a stopped background comes before its options are read, and
  // the ping or the stream went without the user's mpv path.
  const MPV_PATH = 'D:/Tools/mpv/mpv.exe';

  /**
   * storage.local answers 200 ms late, as on a cold start.
   * @param {Object} chrome - The stand-in.
   */
  function slowStorage(chrome) {
    const get = chrome.storage.local.get;
    chrome.storage.local.get = (key, callback) => {
      setTimeout(() => get(key, callback), 200);
    };
  }

  it('tests the connection with the mpv path from the options', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvPath: MPV_PATH}, beforeImport: slowStorage,
      onNative: (m) => ({ok: true, mpv: !!m.mpvPath, path: m.mpvPath, hostVersion: RequiredHostVersion})});
    const answer = bg.message({type: 'MPV_TEST'}, {tabId: 5});
    await bg.wait(500);
    expect(await answer).toMatchObject({ok: true, mpv: true, path: MPV_PATH});
    expect(bg.native[0]).toEqual({type: 'ping', mpvPath: MPV_PATH});
  });

  it('sends the player\'s stream with the mpv path from the options (the player\'s mpv button)', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvPath: MPV_PATH}, tabs: [{id: 1, url: PAGE}],
      beforeImport: slowStorage});
    const answer = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []}, {tabId: 1, frameId: 0});
    await bg.wait(500);
    expect(await answer).toMatchObject({ok: true});
    expect(bg.native.find((m) => m.type === 'open')).toMatchObject({url: EPISODE, mpvPath: MPV_PATH});
  });
});

describe('how mpv\'s window came up', () => {
  it('is in the debug log after a hand-off', async () => {
    // The host says whether it raised mpv's window (focus), whether the window was in front
    // after that (foreground), and whether the stream went into the mpv already open
    // (reused): an mpv that opened behind the browser shows in the log.
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      beforeImport: (chrome) => {
        chrome.management.getSelf = async () => ({installType: 'development'});
      },
      onNative: () => ({ok: true, hostVersion: RequiredHostVersion, focus: 'True', foreground: 'False', reused: true}),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(log).toHaveBeenCalledWith('[MPV] mpv window: reused', true, 'focus', 'True', 'foreground', 'False');
  });
});

// Off means off: once the user turned the tab off, or MPV off - the toolbar, the MPV key,
// MPV mode in the options - nothing in that tab goes to mpv until they turn MPV on again.
// Each case is one way something started before, or kept from before, could still send.
describe('after the user turned MPV off', () => {
  const PLAY = {type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: '', duration: 1400}};

  it('a play still waiting for its stream sends nothing (the MPV key)', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await playWithShortcutMpv(1400);
    await bg.command('toggle_mpv', 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false, mpvPlayPendingUntil: 0});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a play still waiting for its stream sends nothing (the toolbar)', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await playWithShortcutMpv(1400);
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false, mpvPlayPendingUntil: 0});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a stream being checked for the play sends nothing', async () => {
    // Its length is read (300 ms) when the key turns MPV off.
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.command('toggle_mpv', 1);
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a play whose stream\'s length was still read sends nothing', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.message(PLAY, {tabId: 1, frameId: 0});
    await bg.command('toggle_mpv', 1);
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a play sends nothing, and neither does the page\'s next stream', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400, [AD]: 1400})});
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: AD});
    await bg.command('toggle_mpv', 1);
    await bg.message(PLAY, {tabId: 1, frameId: 0});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a hand-off the host answers only after the Off does not pause the page', async () => {
    // mpv opens all the same - it was sent - but the page the user went back to plays on.
    bg = await loadBackground({options: {mpvMode: true, mpvPausePage: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}, 50),
      onNative: (m) => (m.type === 'open' ?
        new Promise((resolve) => setTimeout(() => resolve({ok: true, hostVersion: RequiredHostVersion}), 2000)) :
        {ok: false, error: 'unknown message', hostVersion: RequiredHostVersion})});
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(500);
    await bg.message(PLAY, {tabId: 1, frameId: 0});
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([EPISODE]);
    await bg.command('toggle_mpv', 1);
    await bg.wait(3000);
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
  });

  it('the allowlist sends nothing more on the page, nor on the site\'s next page', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: AD});
    expect(bg.toMpv()).toEqual([AD]);
    await bg.click(1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.frameAdded(1, 0, 'https://site.test/watch/2', 'page-2');
    await bg.request({tabId: 1, url: 'https://cdn.test/episode-2/master.m3u8'});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([AD]);
  });

  it('the allowlist\'s start by address, still waiting for the page, sends nothing', async () => {
    // startWithTrackedLater waits half a second for the new page to name itself.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: 'https://site.test/'}]});
    await bg.navigated(1, 'https://site.test/');
    await bg.frameAdded(1, 0, 'https://site.test/', 'app');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.navigated(1, PAGE);
    await bg.click(1);
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('the allowlist does not start again on the site after a page of it that is not listed', async () => {
    // An entry for the site's /watch pages: the user turns MPV off on an episode, goes to
    // the site's home page, and opens the next episode from there. Leaving the listed
    // pages forgot the user's Off, and the next episode went to mpv by itself.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: AD});
    expect(bg.toMpv()).toEqual([AD]);
    await bg.click(1);
    await bg.navigated(1, 'https://site.test/');
    await bg.frameAdded(1, 0, 'https://site.test/', 'home');
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.frameAdded(1, 0, 'https://site.test/watch/2', 'page-2');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([AD]);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: false});
    // Another site is a fresh decision, as before.
    bg.options.mpvAllowlist = ['https://site.test/watch', 'https://other.test/'];
    await bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99});
    await bg.navigated(1, 'https://other.test/watch/1');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
  });

  it('forgets the Off where the user puts the site on the allowlist afterwards', async () => {
    // MPV off with its key on a site, then the site put on the MPV Allowlist: a fresh
    // decision, and its next page goes to MPV. The Off outlived the listing
    // (mpv-shortcut.e2e.mjs, "on a site on the MPV allowlist").
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: []}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.command('toggle_mpv', 1);
    await bg.command('toggle_mpv', 1);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: false, mpvTurnedOff: true});
    bg.options.mpvAllowlist = ['https://site.test/'];
    await bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99});
    await bg.navigated(1, 'https://site.test/watch/2');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true, mpvTurnedOff: false});
  });

  it('keeps the Off when the allowlist changes for another site only', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: true});
    // MPV -> Off with the toolbar.
    await bg.click(1);
    bg.options.mpvAllowlist = ['https://site.test/', 'https://other.test/'];
    await bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99});
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: false, mpvTurnedOff: true});
  });

  it('a page on the auto-enable list too gets the in-page player there, not MPV', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch'],
      autoEnableURLs: ['https://site.test/watch']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: AD});
    expect(bg.toMpv()).toEqual([AD]);
    await bg.click(1);
    await bg.navigated(1, 'https://site.test/');
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.frameAdded(1, 0, 'https://site.test/watch/2', 'page-2');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([AD]);
  });

  it('a restarted background brings nothing of MPV back', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await playWithShortcutMpv(1400);
    await bg.command('toggle_mpv', 1);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], session,
      fetch: playlists({[EPISODE]: 1400})});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.message(PLAY, {tabId: 1, frameId: 0});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a restarted background keeps the Off on the site from the MPV Allowlist', async () => {
    const options = {mpvMode: true, mpvAllowlist: ['https://site.test/watch']};
    bg = await loadBackground({options, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: AD});
    await bg.click(1);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({options, tabs: [{id: 1, url: PAGE}], session});
    await bg.navigated(1, 'https://site.test/');
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('a pop-up tab that the user turned off sends nothing', async () => {
    // It started in MPV, the MPV key's way, from its opener (inheritMpv).
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400})});
    await bg.command('toggle_mpv', 1);
    await bg.opened({id: 2, openerTabId: 1});
    await bg.navigated(2, 'https://embed.test/e/1');
    expect(bg.session['tabState:2']).toMatchObject({isOn: true, isMpv: true});
    await bg.click(2);
    await bg.message(PLAY, {tabId: 2, frameId: 0});
    await bg.request({tabId: 2, url: EPISODE});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
    // A pop-up the opener opens after its Off starts with nothing of MPV.
    await bg.command('toggle_mpv', 1);
    await bg.opened({id: 3, openerTabId: 1});
    expect(bg.session['tabState:3']?.isMpv).not.toBe(true);
  });
});
