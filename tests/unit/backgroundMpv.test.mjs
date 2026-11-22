import {afterEach, describe, expect, it, vi} from 'vitest';

import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {hlsPlaylist, loadBackground, mpvEvents, playOf, response} from './backgroundHarness.mjs';

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
 * The network: each playlist with its length, or a master playlist's text, answered after a
 * delay.
 * @param {Object<string, number|string>} lengths - Seconds, or the playlist itself, by URL.
 * @param {number} [delayMs] - How long each answer takes.
 * @return {function(string): Promise<Object>} fetch() for loadBackground.
 */
function playlists(lengths, delayMs = 300) {
  return (url) => new Promise((resolve) => {
    setTimeout(() => {
      const known = lengths[url];
      resolve(known === undefined ? response('', 404) :
        response(typeof known === 'string' ? known : hlsPlaylist(known)));
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
    // A stream another video's length frees the play's slot: the episode's manifest found meanwhile
    // is sent.
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
    // A waiting play survives a restart of the idle background.
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
    // A play repeated within 10 s only pauses the page again, also after a restart: no second mpv
    // window.
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

  it('sends the video again when the user plays it after closing mpv, within the repeat window', async () => {
    // The repeat window (10 s) outlived mpv, and a play right
    // after closing it only paused the page again.
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
    mpvEvents(bg.ports.at(-1)).emit({type: 'closed', reason: 'mpv closed'});
    await bg.wait(100);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE, EPISODE]);
  });

  it('keeps the repeat window when only the helper\'s port went and mpv plays on', async () => {
    // a repeat does not load the episode again in mpv
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}),
    });
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    mpvEvents(bg.ports.at(-1)).emit({type: 'closed', reason: 'the mpv host went'});
    await bg.wait(100);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
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

  // A play-triggered fetch lands within a few hundred ms: the known stream goes after 1 s.
  it('sends the page\'s known stream when no other went within 1 s, and not before', async () => {
    await backToA();
    await bg.wait(900);
    expect(bg.toMpv()).toEqual([SA, SB]);
    await bg.wait(300);
    expect(bg.toMpv()).toEqual([SA, SB, SA]);
  });

  it('sends nothing when the tab went to another page within the 1 s', async () => {
    // the wait is the page's, not the tab's: Back within it does not send the other page's stream
    await backToA();
    await bg.message({type: 'FRAME_REMOVED', document: 'page-a'}, {tabId: 1, frameId: 0});
    await bg.navigated(1, B);
    await bg.frameAdded(1, 0, B, 'page-b');
    await bg.wait(1200);
    expect(bg.toMpv()).toEqual([SA, SB]);
  });

  it('sends nothing when another page came back at the same address within the 1 s', async () => {
    // Two history entries of one URL: the address tells nothing, the page's name does.
    await backToA();
    await bg.message({type: 'FRAME_REMOVED', document: 'page-a'}, {tabId: 1, frameId: 0});
    await bg.frameAdded(1, 0, A, 'page-b');
    await bg.wait(1200);
    expect(bg.toMpv()).toEqual([SA, SB]);
  });

  it('sends nothing when the toolbar turned MPV off within the 1 s', async () => {
    // Off means off: nothing in the tab goes to mpv after it.
    await backToA();
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
    await bg.wait(1200);
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
    // The allowlist's MPV sends the episode's stream, not the home page's trailer tracked at the
    // address change.
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
    // A stream found during the wait opens the player as any detected one: captions read first,
    // after replaceDelay.
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

  it('still starts when only the part after # changes during the wait', async () => {
    // the page sets its own #t=... right after its address changed: the waiting start goes on
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: HOME}]});
    await bg.navigated(1, HOME);
    await bg.frameAdded(1, 0, HOME, 'app');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.navigated(1, PAGE);
    await bg.wait(100);
    await bg.navigated(1, PAGE + '#t=10');
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });
});

describe('the allowlist\'s MPV, an address that changes only after its #', () => {
  // What a hash-only change does to a page the allowlist handed off (isSamePageUrlChange).
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
    // a sound a media element loaded is not taken for the page's video
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
    // A woken background redraws every tab's button: it keeps the failure it shows.
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

// The host stays as installed through an extension update. One older than RequiredHostVersion gets no stream: the
// hand-off fails, and the button's "!" and tooltip say to install it again, as the player does.
describe('an outdated mpv host', () => {
  const OUTDATED = 'FastStream - MPV - the mpv helper on this computer is out of date: ' +
    'run "Update mpv" from the Start menu (in a FastStream checkout: update-local.cmd or native-host\\install.ps1)';

  it('gets no stream, only a ping, and the toolbar says to install the host again', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => ({ok: true, mpv: true, hostVersion: RequiredHostVersion - 1}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.native.map((m) => m.type)).toEqual(['ping']);
    expect(bg.ports).toEqual([]);
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toBe(OUTDATED);
    const session = bg.session;
    bg.unload();

    // And still after the event page restarted, as any failed hand-off's "!" is.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}], session});
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toBe(OUTDATED);
  });

  it('gets none either when it answers "unknown message", as a host from before versions does', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      onNative: () => ({ok: false, error: 'unknown message', hostVersion: undefined}),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.native.map((m) => m.type)).toEqual(['ping']);
    expect(bg.titles.get(1)).toBe(OUTDATED);
  });

  it('answers the player\'s mpv button with what to run, which the player shows as the reason', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      onNative: () => ({ok: true, mpv: true, hostVersion: RequiredHostVersion - 1})});
    const answer = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []},
        {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(500);
    expect(await answer).toEqual({ok: false, hostOutdated: true, error: 'The mpv helper on this computer is out of date: ' +
      'run "Update mpv" from the Start menu (in a FastStream checkout: update-local.cmd or native-host\\install.ps1).'});
    expect(bg.played()).toEqual([]);
  });

  // Firefox's word for the system, not navigator.platform ("Win32" under resistFingerprinting).
  it('names the Linux and macOS steps there, whatever navigator.platform says', async () => {
    vi.stubGlobal('navigator', {userAgent: navigator.userAgent, platform: 'Win32'});
    try {
      bg = await loadBackground({
        options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
        tabs: [{id: 1, url: PAGE}],
        onNative: () => ({ok: true, hostVersion: RequiredHostVersion - 1}),
        os: 'linux',
      });
      await bg.navigated(1, PAGE);
      await bg.request({tabId: 1, url: EPISODE});
      expect(bg.titles.get(1)).toBe('FastStream - MPV - the mpv helper on this computer is out of date: ' +
        'update the faststream-mpv-host.mjs that your native messaging manifest points to ' +
        '(git pull in your FastStream checkout; see native-host/README.md)');
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(bg.titles.get(1)).toBe(OUTDATED);
    // The host was installed again; the next page's stream goes through the new one.
    answer = {ok: true, hostVersion: RequiredHostVersion};
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    expect(bg.badges.get(1)).toBe('');
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV');
  });
});

// A tab a tab in MPV opens - a site's player in a pop-up tab, an episode middle-clicked -
// starts in MPV too, the MPV key's way: only a video the user starts there goes.
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

// A thumbnail playlist (EXT-X-IMAGES-ONLY) and a stream piece (styp, moof), as StreamLengths sees
// them.
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
  // Thumbnails and pieces have no length (STILLS_LENGTH, PIECE_LENGTH): a waiting play does not
  // take them.

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
    // The allowlist sends a page's first stream before its length is read; a playlist of stills
    // read before does not go.
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
    // A background stopped by Firefox loses its streams: content.js answers REPORT_LOADED_MEDIA
    // with LOADED_MEDIA.
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
    const open = bg.played()[0];
    expect(open.headers).toContainEqual({name: 'User-Agent', value: navigator.userAgent});
  });
});

describe('a hand-off the host answers after the tab went on to the next page', () => {
  // A fresh mpv answers seconds after the send (WMI, then the wait for its window), and
  // the answer went to whatever page the tab showed by then.
  const PAGE_2 = 'https://site.test/watch/2';

  /**
   * The mpv host: a play answered after 2 s, as a fresh mpv's is.
   * @param {Object} openAnswer - The answer to the play.
   * @return {function(Object): *} onNative for loadBackground.
   */
  function slowHost(openAnswer) {
    return (message) => (message.type === 'play' ?
      new Promise((resolve) => setTimeout(() => resolve(openAnswer), 2000)) : {ok: true});
  }

  /**
   * The user starts a video in the shortcut's MPV, and goes on to the next page before
   * the host answered.
   * @param {Object} openAnswer - The host's answer to the play.
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
    expect(bg.native.map((m) => m.type)).toEqual(['ping', 'play']);
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
      onNative: (m) => (m.type === 'play' && playOf(m).url === A ?
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

describe('a hand-off still being prepared when the page went, or MPV was turned off', () => {
  // The allowlist sends at once, and openInMpv waits for its master's read (hlsQualityChoice).
  async function detectWhileSlow() {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}, 1000)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(200);
    expect(bg.toMpv()).toEqual([]);
  }

  it('sends the stream once its master is read', async () => {
    await detectWhileSlow();
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends it when the page only changed its own address meanwhile (pushState)', async () => {
    await detectWhileSlow();
    await bg.navigated(1, PAGE + '?t=5');
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends nothing for a page the tab left meanwhile', async () => {
    await detectWhileSlow();
    await bg.navigated(1, 'https://site.test/watch/2');
    await bg.frameAdded(1, 0, 'https://site.test/watch/2', 'page-2');
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('sends nothing once MPV is off', async () => {
    await detectWhileSlow();
    await bg.command('toggle_mpv', 1);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: false});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.session['tabState:1'].mpvError).toBe(null);
  });

  it('sends nothing for a tab closed meanwhile', async () => {
    await detectWhileSlow();
    await bg.closed(1);
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
  });
});

describe('the same video played again while its send is answered', () => {
  const PLAY = {type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: '', duration: 1400}};

  async function playTwiceBeforeTheAnswer(openAnswer) {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}, 50),
      onNative: (m) => (m.type === 'play' ? new Promise((resolve) => setTimeout(() => resolve(openAnswer), 2000)) :
        {ok: true, hostVersion: RequiredHostVersion})});
    await bg.navigated(1, PAGE);
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(500);
    await bg.message(PLAY, {tabId: 1, frameId: 0});
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([EPISODE]);
    await bg.message(PLAY, {tabId: 1, frameId: 0});
    await bg.wait(100);
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
    await bg.wait(3000);
  }

  it('leaves the page playing when mpv failed', async () => {
    await playTwiceBeforeTheAnswer({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion});
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('pauses the page once mpv has it', async () => {
    await playTwiceBeforeTheAnswer({ok: true, hostVersion: RequiredHostVersion});
    expect(bg.sent('PAUSE_MEDIA').length).toBeGreaterThan(0);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });
});

describe('MPV mode switched off in the options', () => {
  // MPV mode off ends the mode a tab was in: no stream goes to mpv on a site on both lists.

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
  it('is not saved again by mpv\'s decoder, told over the relay as mpv opens the stream', async () => {
    // The decoder comes seconds after the hand-off: it must not save a tab closed meanwhile.
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
      tabs: [{id: 1, url: PAGE}],
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, url: EPISODE});
    expect(bg.toMpv()).toEqual([EPISODE]);
    const port = bg.ports.at(-1);
    await bg.closed(1);
    for (const [id, name, data] of [[10, 'hwdec-current', 'd3d11va'], [12, 'video-format', 'hevc'], [13, 'width', 1920],
      [14, 'height', 1080]]) {
      port.emit({type: 'mpv', data: {event: 'property-change', id, name, data}});
    }
    await bg.wait(100);
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

  it('answers a repeat click of the player\'s mpv button with the first one\'s answer, when it comes', async () => {
    // the repeat is not "sent" while the first send could still fail
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}],
      onNative: (m) => m.type === 'play' ? pending : {ok: true, hostVersion: RequiredHostVersion}});
    const one = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []}, {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(300);
    let repeat = null;
    const two = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []}, {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    two.then((r) => {
      repeat = r;
    });
    await bg.wait(500);
    expect(repeat).toBe(null);
    release({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion});
    await bg.wait(100);
    expect(await one).toMatchObject({ok: false, error: 'mpv executable not found'});
    expect(await two).toMatchObject({ok: false, error: 'mpv executable not found'});
    // One send for both clicks; after a failure the next click is a send of its own.
    expect(bg.played().length).toBe(1);
    const again = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []}, {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(500);
    await again;
    expect(bg.played().length).toBe(2);
  });

  it('sends the player\'s stream with the mpv path from the options (the player\'s mpv button)', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvPath: MPV_PATH}, tabs: [{id: 1, url: PAGE}],
      beforeImport: slowStorage});
    const answer = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []}, {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(500);
    expect(await answer).toMatchObject({ok: true});
    expect(bg.played()[0]).toMatchObject({url: EPISODE, mpvPath: MPV_PATH});
  });
});

describe('how mpv\'s window came up', () => {
  it('is in the debug log after a hand-off', async () => {
    // The host says whether it raised mpv's window, whether it was in front, and whether mpv was
    // reused.
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

// Off means off: after the user turned the tab or MPV off, nothing started before sends to mpv.
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
      onNative: (m) => (m.type === 'play' ?
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
    // The user's Off outlives leaving the allowlisted pages: the next episode does not go by
    // itself.
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
    // Putting a site on the allowlist is a fresh decision: its next page goes to MPV.
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

  it('answers new options once they are in effect: a page opened then is checked against them', async () => {
    // The answer comes after the storage read: a site just put on the allowlist is checked against
    // the new list.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: []},
      tabs: [{id: 1, url: 'https://other.test/'}]});
    await bg.navigated(1, 'https://other.test/');
    bg.options.mpvAllowlist = ['https://site.test/'];
    let opened;
    const answer = await bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99, onAnswer: () => {
      opened = bg.navigated(1, PAGE);
    }});
    await opened;
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    expect(answer).toBe(true);
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

describe('a stream that came through Firefox VPN', () => {
  // Firefox VPN carries the page's requests, not mpv's: nothing is handed off then, and the reason
  // shows.
  const VPN = {type: 'https', host: 'muc139.m1.fastly-masque.net', port: 2499,
    proxyAuthorizationHeader: 'Bearer token', connectionIsolationKey: 'iso', failoverTimeout: 10};

  it('is not handed to mpv by the allowlist, and the toolbar says why', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE, proxyInfo: VPN});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toContain('Firefox VPN');
  });

  it('is not sent by the player\'s mpv button, whose answer says why', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.request({tabId: 1, url: EPISODE, proxyInfo: VPN});
    const answer = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: []}, {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(500);
    expect(await answer).toMatchObject({ok: false, vpn: true});
    expect(bg.played()).toEqual([]);
  });

  it('is not sent by the shortcut\'s MPV when the user plays it', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await playWithShortcutMpv(600);
    await bg.request({tabId: 1, url: EPISODE, proxyInfo: VPN});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.titles.get(1)).toContain('Firefox VPN');
  });

  it('is not sent when the toolbar button enters MPV mode', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE, proxyInfo: VPN});
    await bg.wait(1000);
    // Off, On, then MPV again: the tab's known streams go to mpv (openMpvWithSources).
    await bg.click(1);
    await bg.click(1);
    await bg.click(1);
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('is not held back in a normal window by what a private window reached through the VPN', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    // Firefox VPN for private windows only: the same CDN, seen through it in a private
    // window, and reached directly here.
    await bg.request({tabId: 9, url: EPISODE, proxyInfo: VPN, incognito: true});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('still goes to mpv through a proxy that is not Firefox VPN\'s (one in the network settings)', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE, proxyInfo: {type: 'http', host: 'proxy.lan', port: 3128}});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });
});

describe('a file the page tells as its video loads, before the request for it is seen', () => {
  it('goes to mpv with the request\'s own headers, not the page\'s stand-ins', async () => {
    // The page's loadedmetadata word waits LiveMediaReportWaitMs: the request's detection, with its
    // Origin, comes first.
    const FILE = 'https://cdn.test/clip.mp4';
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    const sent = bg.requestSent({tabId: 1, url: FILE, type: 'media',
      requestHeaders: [{name: 'Referer', value: PAGE}, {name: 'Origin', value: 'https://site.test'}]});
    await bg.message({type: 'LOADED_MEDIA', live: true, url: PAGE, document: 'page-1',
      resources: [{url: FILE, media: true, cors: false, time: Date.now()}]}, {tabId: 1, frameId: 0});
    await bg.wait(100);
    await bg.responded(sent, {responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([FILE]);
    const open = bg.played()[0];
    expect(open.headers).toContainEqual({name: 'Origin', value: 'https://site.test'});
  });

  it('takes the file in after the wait when no request came (Firefox played it without one)', async () => {
    const FILE = 'https://cdn.test/clip.mp4';
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.message({type: 'LOADED_MEDIA', live: true, url: PAGE, document: 'page-1',
      resources: [{url: FILE, media: true, cors: true, time: Date.now()}]}, {tabId: 1, frameId: 0});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([FILE]);
    // A crossorigin video's request carries an Origin: so do the page's stand-ins.
    const open = bg.played()[0];
    expect(open.headers).toContainEqual({name: 'Origin', value: 'https://site.test'});
  });
});

describe('a page\'s word about its video, when the tab went on to another site meanwhile', () => {
  it('is not taken in by the next page, whose own stream goes to mpv', async () => {
    // A hostname change within that wait resets the frames: the last page's file is not the new
    // page's stream.
    const SITE = 'http://127.0.0.1:41993';
    const SITE_B = 'http://localhost:41993';
    const CDN = 'http://127.0.0.1:41994';
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: [SITE, SITE_B]}, tabs: [{id: 1, url: SITE + '/watch2'}]});
    await bg.navigated(1, SITE + '/watch2');
    await bg.frameAdded(1, 0, SITE + '/watch2', 'page-2');
    await bg.request({tabId: 1, url: `${CDN}/clip2.mp4`, type: 'media'});
    await bg.message({type: 'LOADED_MEDIA', live: true, url: SITE + '/watch2', document: 'page-2',
      resources: [{url: `${CDN}/clip2.mp4`, media: true, cors: true, time: Date.now()}]}, {tabId: 1, frameId: 0});
    // The tab goes on to the other site before the word's wait is over; the page going
    // tells so (content.js on pagehide), which empties its frame.
    await bg.wait(200);
    await bg.message({type: 'FRAME_REMOVED', document: 'page-2'}, {tabId: 1, frameId: 0});
    await bg.navigated(1, SITE_B + '/watch3');
    await bg.wait(1500);
    await bg.frameAdded(1, 0, SITE_B + '/watch3', 'page-3');
    await bg.request({tabId: 1, url: `${CDN}/clip3.mp4`, type: 'media'});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([`${CDN}/clip2.mp4`, `${CDN}/clip3.mp4`]);
  });
});

// mpv starts where the page's video is (content.js playedVideo), not at 0:00.
describe('the shortcut\'s MPV, where mpv starts', () => {
  /** What the play message to the host said of the start, for a video played at a time. */
  async function startFor(video) {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}),
    });
    await bg.command('toggle_mpv', 1);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', ...video}},
        {tabId: 1, frameId: 0});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    const opens = bg.played();
    expect(opens).toHaveLength(1);
    return opens[0].start;
  }

  it('starts mpv where the page\'s video was', async () => {
    expect(await startFor({duration: 1400, time: 612.4})).toBe(612.4);
  });

  it('starts at the start a play from the start, and a live video', async () => {
    expect(await startFor({duration: 1400, time: 0.2})).toBe(undefined);
    expect(await startFor({duration: null, time: 612.4})).toBe(undefined);
    // What a live video reports: its duration is Infinity (content.js playedVideo passes it on).
    expect(await startFor({duration: Infinity, time: 612.4})).toBe(undefined);
  });
});

describe('the toolbar cycle on a page the MPV allowlist names by its path', () => {
  const NEWS = 'https://site.test/news';

  /**
   * The allowlist names the site's /watch pages; tab 1 opens an episode there, which
   * starts MPV by itself.
   * @return {Promise<void>}
   */
  async function onEpisode() {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
  }

  it('keeps the On the user picked when the tab goes on to a page the list does not name', async () => {
    // Off -> On is the user's: the first page outside the list leaves it on.
    await onEpisode();
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.navigated(1, NEWS);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
  });

  it('still ends the MPV the list started when the tab leaves the list', async () => {
    await onEpisode();
    await bg.navigated(1, NEWS);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
  });
});

describe('a mode the user picked on a page an auto-enable list turned on', () => {
  // What the user picks stays for the tab; what a list started ends when the tab leaves the list.
  const WATCH = 'https://site.test/watch/1';
  const NEWS = 'https://site.test/news';

  async function onAutoEnabledPage(options = {}) {
    bg = await loadBackground({options: {mpvMode: true, autoEnableURLs: ['https://site.test/watch'], ...options},
      tabs: [{id: 1, url: WATCH}]});
    await bg.navigated(1, WATCH);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
  }

  it('keeps the MPV key\'s MPV on the next page the lists do not name', async () => {
    await onAutoEnabledPage();
    await bg.command('toggle_mpv', 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
    await bg.navigated(1, NEWS);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
  });

  it('keeps the toolbar\'s own On on the next page the lists do not name', async () => {
    await onAutoEnabledPage();
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false});
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true});
    await bg.navigated(1, NEWS);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
  });

  // The player key's MPV -> On is the user's own On as well.
  it('keeps the player key\'s On, out of the allowlist\'s MPV, on the next page the lists do not name', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: 'https://site.test/watch/1'}]});
    await bg.navigated(1, 'https://site.test/watch/1');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    await bg.command('toggle_player', 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.navigated(1, 'https://site.test/home');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
  });

  it('still ends the On the list started when the tab leaves the list', async () => {
    await onAutoEnabledPage();
    await bg.navigated(1, NEWS);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
  });

  it('keeps the toolbar\'s On -> MPV on the next page the auto-enable list names', async () => {
    // Its MPV is no longer the list's, so the auto-enable list does not put the in-page player in
    // its place.
    bg = await loadBackground({
      options: {mpvMode: true, autoEnableURLs: ['https://site.test/'], mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: WATCH}],
    });
    await bg.navigated(1, WATCH);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    await bg.command('toggle_player', 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});

    await bg.navigated(1, 'https://site.test/home');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    await bg.navigated(1, 'https://site.test/watch/2');
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
  });
});

describe('MPV autoplay: an episode\'s end, or mpv\'s key, goes on to the next one', () => {
  // Episode after episode in mpv: the helper relays the mpv it started over a port, and the watch tells its ends and
  // next/previous keys (spoken to here in those events: backgroundHarness's mpvEvents).
  const EP1 = 'https://site.test/watch/1';
  const EP2 = 'https://site.test/watch/2';
  const S1 = 'https://cdn.test/one/master.m3u8';
  const S2 = 'https://cdn.test/two/master.m3u8';
  const S3 = 'https://cdn.test/three/master.m3u8';
  // A hoster's preroll, and a stream of a few minutes (a trailer, a preview).
  const AD = 'https://ads.test/pre/master.m3u8';
  const SHORT = 'https://cdn.test/short/master.m3u8';
  // A master with one video variant and the sound in two languages, each its own playlist.
  const LANGS = 'https://cdn.test/langs/master.m3u8';
  const LANGS_VIDEO = 'https://cdn.test/langs/index-v1-a1.m3u8';
  const LANGS_DE = 'https://cdn.test/langs/index-a1.m3u8';
  const LANGS_FR = 'https://cdn.test/langs/index-a2.m3u8';
  const LANGS_MASTER = '#EXTM3U\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Deutsch",LANGUAGE="de",AUTOSELECT=NO,DEFAULT=NO,URI="index-a1.m3u8"\n' +
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Français",LANGUAGE="fr",AUTOSELECT=NO,DEFAULT=NO,URI="index-a2.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=1307594,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio0"\n' +
    'index-v1-a1.m3u8\n';
  let navigations;
  let polls;

  /**
   * Episode 1 handed to mpv (the allowlist's MPV, or the MPV key's), and the watch it opened.
   * @param {Object} [options] - More options.
   * @param {string} [link] - What the page's top frame answers to a next/previous request.
   * @param {Object} [poll] - What it answers to PLAYLIST_POLL (none: a page that cannot tell).
   * @param {Object<string, Object>} [episodeLinks] - What each tab's top frame (by its id), or a
   *   frame ('tab:frame'), answers to EPISODE_LINKS (none: a page that cannot tell).
   * @param {Object} [tab] - More of the tab's properties (its cookieStoreId).
   * @return {Promise<Object>} The port (backgroundHarness: sent, emit, drop).
   */
  async function onEpisode1(options = {}, link = 'clicked', poll = undefined, episodeLinks = {}, tab = {}) {
    navigations = [];
    polls = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvAutoplayNext: true, autoplayCountdown: 0, ...options},
      tabs: [{id: 1, url: EP1, ...tab}],
      fetch: playlists({[S1]: 1400, [S2]: 1400, [S3]: 1400, [AD]: 30, [SHORT]: 90,
        [LANGS]: LANGS_MASTER, [LANGS_VIDEO]: 1400, [LANGS_DE]: 1400, [LANGS_FR]: 1400}),
      onTabMessage: ({tabId, frameId, message}) => {
        // The page's video: in the top frame here (startPagePlayers asks the largest).
        if (message.type === 'GET_VIDEO_SIZE') return frameId === 0 ? 640 * 360 : 0;
        // A frame's own answer by tab and frame (1:5), else the tab's top frame's (1).
        if (message.type === 'EPISODE_LINKS') return episodeLinks[`${tabId}:${frameId}`] ?? (frameId === 0 ? episodeLinks[tabId] : undefined);
        if (message.type === 'PLAYLIST_POLL') {
          polls.push(frameId);
          return frameId === 0 ? poll : undefined;
        }
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push({direction: message.direction, frameId});
        return frameId === 0 ? link : 'no_button';
      },
    });
    await bg.navigated(1, EP1);
    await bg.frameAdded(1, 0, EP1, 'ep1');
    await bg.frameAdded(1, 5, 'https://hoster.test/e/1', 'hoster1');
    await bg.request({tabId: 1, url: S1, frameId: 5});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1]);
    const port = mpvEvents(bg.ports.at(-1));
    expect(port.port.sent[0]).toMatchObject({type: 'relay'});
    return port;
  }

  /** What the background asked mpv to show (notify.lua). */
  const notices = (port) => port.sent.filter((m) => m.type === 'notify').map((m) => m.detail);
  /** What it told mpv's autoplay switch to show (host 9's user-data/faststream/autoplay). */
  const states = (port) => port.sent.filter((m) => m.type === 'state').map((m) => m.autoplay);

  it('tells mpv\'s autoplay switch the setting once the watch began, and a change made on the options page', async () => {
    const port = await onEpisode1();
    port.emit({type: 'watching'});
    await bg.wait(50);
    expect(states(port)).toEqual([true]);
    bg.options = {...bg.options, mpvAutoplayNext: false};
    await bg.message({type: 'LOAD_OPTIONS'});
    await bg.wait(50);
    expect(states(port)).toEqual([true, false]);
  });

  it('counts down before the next episode, which the next-episode key or button skips', async () => {
    let port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
    await bg.wait(4000);
    expect(navigations).toEqual([]);
    await bg.wait(1000);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
    bg.unload();

    port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'ended', path: S1});
    await bg.wait(1000);
    port.emit({type: 'request', action: 'next'});
    await bg.wait(100);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
    // The countdown went with it: no second episode on top.
    await bg.wait(6000);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  it('says the series ended at once, with no countdown, when the page says it is its last episode', async () => {
    // At a series' last episode the page is asked first (PLAYLIST_POLL, top frame first) and
    // autoplay stops.
    const port = await onEpisode1({autoplayCountdown: 5}, 'series_end', {next: false, previous: true, seriesEnd: true});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(notices(port)).toEqual(['the last episode of the series: autoplay stops']);
    expect(polls).toEqual([0]);
    await bg.wait(6000);
    expect(navigations).toEqual([]);
    expect(notices(port)).toEqual(['the last episode of the series: autoplay stops']);
  });

  it('counts down as before when the page has a next episode, or cannot tell', async () => {
    let port = await onEpisode1({autoplayCountdown: 5}, 'clicked', {next: true, previous: true, seriesEnd: false});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
    await bg.wait(5000);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
    bg.unload();

    // No frame answers (a page with its own playlist): every frame asked, then the countdown.
    port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(polls).toEqual([0, 5]);
    expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
    bg.unload();

    // A frame that never answers costs a second, then the countdown as before.
    port = await onEpisode1({autoplayCountdown: 5}, 'clicked', new Promise(() => {}));
    port.emit({type: 'ended', path: S1});
    await bg.wait(500);
    expect(notices(port)).toEqual([]);
    await bg.wait(1000);
    expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
  });

  it('stops the countdown with mpv\'s autoplay switch, which saves the setting and turns it back on', async () => {
    const port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'ended', path: S1});
    await bg.wait(1000);
    port.emit({type: 'request', action: 'autoplay'});
    await bg.wait(100);
    // The first the setting, as the watch began.
    expect(states(port)).toEqual([true, false]);
    expect(notices(port).at(-1)).toBe('off');
    // Saved, and an open options page told with the message it listens for (OptionsStore:
    // UPDATE_OPTIONS); LOAD_OPTIONS reached only this background.
    expect(bg.runtimeSent.map((m) => m.type)).toContain('UPDATE_OPTIONS');
    expect(bg.runtimeSent.map((m) => m.type)).not.toContain('LOAD_OPTIONS');
    await bg.wait(6000);
    expect(navigations).toEqual([]);

    port.emit({type: 'request', action: 'autoplay'});
    await bg.wait(100);
    expect(states(port)).toEqual([true, false, true]);
    expect(notices(port).at(-1)).toBe('on');
  });

  it('stops the countdown with Space, which keeps autoplay on for the next end', async () => {
    // His wish: Space, the easiest key, stops the countdown. mpv's input.conf
    // sends faststream-pause with Space and with a click on the video.
    const timed = (port) => port.sent.filter((m) => m.type === 'notify' || m.type === 'hide')
        .map((m) => m.type === 'hide' ? 'hide' : [m.detail, m.seconds]);
    const port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'watching'});
    port.emit({type: 'ended', path: S1});
    await bg.wait(1000);
    port.emit({type: 'request', action: 'pause'});
    await bg.wait(100);
    expect(timed(port)).toEqual([['next episode in 5 s (n: now, Space: stop)', 5], 'hide',
      ['stopped (n: next episode)', undefined]]);
    await bg.wait(6000);
    expect(navigations).toEqual([]);
    // Autoplay itself stays on: nothing saved, the switch told nothing new.
    expect(states(port)).toEqual([true]);
    expect(bg.runtimeSent.map((m) => m.type)).not.toContain('UPDATE_OPTIONS');
    // A second Space finds no countdown and says nothing.
    port.emit({type: 'request', action: 'pause'});
    await bg.wait(100);
    expect(timed(port)).toHaveLength(3);
    // The next-episode key still goes on from here.
    port.emit({type: 'request', action: 'next'});
    await bg.wait(100);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  it('stops a countdown still asking the page with Space, before it is shown', async () => {
    const port = await onEpisode1({autoplayCountdown: 5}, 'clicked', new Promise(() => {}));
    port.emit({type: 'ended', path: S1});
    await bg.wait(300);
    port.emit({type: 'request', action: 'pause'});
    await bg.wait(7000);
    expect(notices(port)).toEqual([]);
    expect(navigations).toEqual([]);
  });

  it('leaves playback alone on Space with no countdown: no notice, no episode', async () => {
    const port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'request', action: 'pause'});
    await bg.wait(100);
    expect(notices(port)).toEqual([]);
    // An end after it counts down as usual.
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
    await bg.wait(5000);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  it('shows a notice in mpv for as long as it needs, and takes a stopped countdown\'s down (host 11)', async () => {
    // notices go with the countdown, not after notify.lua's 2 s
    const timed = (port) => port.sent.filter((m) => m.type === 'notify' || m.type === 'hide')
        .map((m) => m.type === 'hide' ? 'hide' : [m.detail, m.seconds]);
    let port = await onEpisode1({autoplayCountdown: 7});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(timed(port)).toEqual([['next episode in 7 s (n: now, Space: stop)', 7]]);
    // Another episode picked in the browser meanwhile: nothing else is said, so it goes.
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: S2, frameId: 6});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1, S2]);
    expect(timed(port)).toEqual([['next episode in 7 s (n: now, Space: stop)', 7], 'hide']);
    await bg.wait(8000);
    expect(navigations).toEqual([]);
    bg.unload();

    // The switch: "off" takes its place, for notify.lua's own 2 s.
    port = await onEpisode1({autoplayCountdown: 5});
    port.emit({type: 'ended', path: S1});
    await bg.wait(1000);
    port.emit({type: 'request', action: 'autoplay'});
    await bg.wait(100);
    expect(timed(port)).toEqual([['next episode in 5 s (n: now, Space: stop)', 5], 'hide', ['off', undefined]]);
    bg.unload();

    // A sentence to read: 6 s.
    port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(timed(port)).toEqual([['loading in mpv', 6]]);
  });

  it('takes two quick presses of mpv\'s autoplay switch as two', async () => {
    const port = await onEpisode1();
    port.emit({type: 'request', action: 'autoplay'});
    port.emit({type: 'request', action: 'autoplay'});
    await bg.wait(200);
    expect(states(port).slice(1)).toEqual([false, true]);
    expect(notices(port).slice(-2)).toEqual(['off', 'on']);
  });

  it('says so in mpv when the next page brings no stream within a minute', async () => {
    let port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.wait(61000);
    expect(notices(port).at(-1)).toBe('the page brought no stream within a minute; open it in the browser to see why');
    expect(bg.local.siteProblems.map((e) => [e.host, e.path, e.kind, e.mode])).toEqual([['site.test', '/watch/2', 'no_stream', 'mpv']]);
    bg.unload();

    // Its stream came in time: nothing to say.
    port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: S2, frameId: 6});
    await bg.wait(61000);
    expect(notices(port)).toEqual(['loading in mpv']);
  });

  it('goes on to the next episode when mpv played one to its end, into the same mpv', async () => {
    const port = await onEpisode1();
    port.emit({type: 'watching'});
    port.emit({type: 'ended', path: S1 + '#fs-content=movie&fs-id=0123456789abcdef'});
    await bg.wait(100);
    // The page's own link, top frame first.
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
    expect(notices(port)).toEqual(['loading in mpv']);

    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: S2, frameId: 6});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1, S2]);
    // The same watch follows on: no second port.
    expect(bg.ports).toHaveLength(1);
  });

  // The next page's player may load an ad first: its longest stream goes to mpv.
  it('sends the next page\'s longest stream, not an ad its player loaded first', async () => {
    const port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: AD, frameId: 6});
    await bg.wait(200);
    await bg.request({tabId: 1, url: S2, frameId: 6});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([S1, S2]);
  });

  it('sends the longest stream of a next page on another allowlisted site too, not its ad', async () => {
    const OTHER = 'https://other.test/watch/2';
    const port = await onEpisode1({mpvAllowlist: ['https://site.test/', 'https://other.test/']});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, OTHER);
    await bg.frameAdded(1, 0, OTHER, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: AD, frameId: 6});
    await bg.wait(700);
    await bg.request({tabId: 1, url: S2, frameId: 6});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([S1, S2]);
  });

  // Of streams that tie, the master goes, not the sound's playlist the page's player loaded last.
  it('sends the next page\'s master, not the sound\'s playlist its player loaded last', async () => {
    const port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: LANGS, frameId: 6});
    await bg.wait(200);
    await bg.request({tabId: 1, url: LANGS_VIDEO, frameId: 6});
    await bg.wait(10);
    await bg.request({tabId: 1, url: LANGS_DE, frameId: 6});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([S1, LANGS]);
  });

  it('sends a stream of a few minutes when nothing longer came before the minute is nearly up', async () => {
    const port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.frameAdded(1, 6, 'https://hoster.test/e/2', 'hoster2');
    await bg.request({tabId: 1, url: SHORT, frameId: 6});
    await bg.wait(30000);
    expect(bg.toMpv()).toEqual([S1]);
    await bg.wait(29000);
    expect(bg.toMpv()).toEqual([S1, SHORT]);
    // It went in time: no "no stream" notice.
    expect(notices(port)).toEqual(['loading in mpv']);
  });

  it('starts the next page\'s player when it waits for a click, in MPV mode too', async () => {
    const port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.wait(2500);
    expect(bg.sent('START_PAGE_PLAYER').length).toBeGreaterThan(0);
  });

  it('starts the player of a page gone on to before the last one\'s stream came', async () => {
    // two quick next keys: the second page is asked too
    const port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    port.emit({type: 'request', action: 'next'});
    await bg.wait(100);
    expect(navigations).toHaveLength(2);
    await bg.navigated(1, 'https://site.test/watch/3');
    await bg.frameAdded(1, 0, 'https://site.test/watch/3', 'ep3');
    await bg.wait(2500);
    expect(bg.sent('START_PAGE_PLAYER').length).toBeGreaterThan(0);
  });

  it('takes the next page\'s stream by itself in the MPV key\'s mode, which waits for a play', async () => {
    // The MPV key's MPV sends only what the user plays: after an end in mpv nobody plays in
    // the page, and the next episode would never come.
    navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: EP1}],
      fetch: playlists({[S1]: 1400, [S2]: 1400}),
      onTabMessage: ({frameId, message}) => (message.type === 'PLAYLIST_NAVIGATION' && frameId === 0 ? 'clicked' : undefined),
    });
    await bg.navigated(1, EP1);
    await bg.frameAdded(1, 0, EP1, 'ep1');
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: S1});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1]);
    const port = mpvEvents(bg.ports.at(-1));
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.request({tabId: 1, url: S2});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1, S2]);
  });

  it('leaves an end alone without "Autoplay next episode in mpv", and a file mpv got elsewhere', async () => {
    let port = await onEpisode1({mpvAutoplayNext: false});
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(navigations).toEqual([]);
    bg.unload();

    port = await onEpisode1();
    port.emit({type: 'ended', path: 'C:\\Videos\\my own film.mkv'});
    await bg.wait(100);
    expect(navigations).toEqual([]);
  });

  it('goes on with mpv\'s keys, next and previous, autoplay on or off', async () => {
    const port = await onEpisode1({mpvAutoplayNext: false});
    port.emit({type: 'request', action: 'previous'});
    await bg.wait(100);
    port.emit({type: 'request', action: 'next'});
    await bg.wait(100);
    expect(navigations).toEqual([{direction: 'previous', frameId: 0}, {direction: 'next', frameId: 0}]);
  });

  it('goes on once when the end and the key come at the same moment', async () => {
    const port = await onEpisode1();
    port.emit({type: 'ended', path: S1});
    port.emit({type: 'request', action: 'next'});
    await bg.wait(100);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  it('lets a tab whose stream took the window over cancel the episode another tab waits for', async () => {
    // Tab 1 (the MPV key's mode) went on after an end; before its next page brought the
    // stream, tab 2's video went into the window. Tab 1's next stream must not replace it.
    const S3 = 'https://cdn.test/other/master.m3u8';
    navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://other.test/'], mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: EP1}, {id: 2, url: 'https://other.test/film'}],
      fetch: playlists({[S1]: 1400, [S2]: 1400, [S3]: 1400}),
      onTabMessage: ({frameId, message}) => (message.type === 'PLAYLIST_NAVIGATION' && frameId === 0 ? 'clicked' : undefined),
    });
    await bg.navigated(1, EP1);
    await bg.frameAdded(1, 0, EP1, 'ep1');
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: S1});
    await bg.wait(500);
    mpvEvents(bg.ports.at(-1)).emit({type: 'ended', path: S1});
    await bg.wait(100);

    await bg.navigated(2, 'https://other.test/film');
    await bg.frameAdded(2, 0, 'https://other.test/film', 'film');
    await bg.request({tabId: 2, url: S3});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1, S3]);

    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.request({tabId: 1, url: S2});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1, S3]);
  });

  it('sends nothing for a short stream that waited when another tab\'s stream took the window', async () => {
    // pickNextEpisodeForMpv: tab 1's next page had only a stream of a few minutes, which waits
    // for a longer one; tab 2's video took the window meanwhile, which ends tab 1's wait.
    const S3 = 'https://cdn.test/other/master.m3u8';
    navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://other.test/'], mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: EP1}, {id: 2, url: 'https://other.test/film'}],
      fetch: playlists({[S1]: 1400, [S3]: 1400, [SHORT]: 90}),
      onTabMessage: ({frameId, message}) => (message.type === 'PLAYLIST_NAVIGATION' && frameId === 0 ? 'clicked' : undefined),
    });
    await bg.navigated(1, EP1);
    await bg.frameAdded(1, 0, EP1, 'ep1');
    await playWithShortcutMpv(1400);
    await bg.request({tabId: 1, url: S1});
    await bg.wait(500);
    mpvEvents(bg.ports.at(-1)).emit({type: 'ended', path: S1});
    await bg.wait(100);
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.request({tabId: 1, url: SHORT});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([S1]);

    await bg.navigated(2, 'https://other.test/film');
    await bg.frameAdded(2, 0, 'https://other.test/film', 'film');
    await bg.request({tabId: 2, url: S3});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([S1, S3]);
    await bg.wait(60000);
    expect(bg.toMpv()).toEqual([S1, S3]);
  });

  it('stops at the series\' last episode and says so, asking no hoster frame', async () => {
    // The page says its series ended (isSeriesEnd): no other frame is asked, and it is no problem
    // to note.
    const port = await onEpisode1({}, 'series_end');
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(navigations.map((n) => n.frameId)).toEqual([0]);
    expect(notices(port)).toEqual(['the last episode of the series: autoplay stops']);
    expect(bg.local.siteProblems).toBeUndefined();
  });

  it('gives up on a frame that never answers the next-episode request, and the keys still work', async () => {
    // Such a frame kept state.going set, and every later key,
    // button and autoplay of the session returned at it.
    const port = await onEpisode1({}, new Promise(() => {}));
    port.emit({type: 'ended', path: S1});
    await bg.wait(5200);
    // only the top frame: a hoster's link would be a second episode
    expect(navigations.map((n) => n.frameId)).toEqual([0]);
    expect(notices(port)).toEqual(['none found on the page']);
    port.emit({type: 'request', action: 'previous'});
    await bg.wait(100);
    expect(navigations.map((n) => n.direction)).toEqual(['next', 'previous']);
  });

  it('notes no problem for a page in a private window (the list is kept on disk)', async () => {
    const port = await onEpisode1({}, 'no_button');
    bg.tabs.find((t) => t.id === 1).incognito = true;
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(notices(port)).toEqual(['none found on the page']);
    expect(bg.local.siteProblems).toBeUndefined();
  });

  it('says so in mpv when the page has no next episode, or the tab is gone', async () => {
    let port = await onEpisode1({}, 'no_button');
    port.emit({type: 'ended', path: S1});
    await bg.wait(100);
    expect(navigations.map((n) => n.frameId)).toEqual([0, 5]);
    expect(notices(port)).toEqual(['none found on the page']);
    // Noted for the options page's problem list.
    expect(bg.local.siteProblems.map((e) => [e.host, e.kind, e.mode])).toEqual([['site.test', 'no_next', 'mpv']]);
    bg.unload();

    port = await onEpisode1();
    await bg.closed(1);
    port.emit({type: 'request', action: 'next'});
    await bg.wait(100);
    expect(notices(port)).toEqual(['its tab is closed, or not in MPV mode']);
  });

  describe('with the episode\'s tab closed', () => {
    // The tab closed, autoplay goes on: links read at the hand-off, the episode opened in a hidden
    // tab.
    const EP0 = 'https://site.test/watch/0';
    const EP3 = 'https://site.test/watch/3';
    const linksTo = (next, previous = null) => ({hasNext: next !== null, next, hasPrevious: previous !== null, previous,
      seriesEnd: false});

    /** Episode 1 in mpv, its links read, and its tab closed. */
    async function closedAfterEpisode1(options = {}, links = {1: linksTo(EP2, EP0), 1000: linksTo(EP3, EP1)}) {
      const port = await onEpisode1(options, 'clicked', undefined, links);
      await bg.wait(100);
      await bg.closed(1);
      return port;
    }

    /** The tab made for an episode loads it and its hoster asks for the stream. */
    async function newTabLoads(tabId, url, stream) {
      await bg.navigated(tabId, url);
      await bg.frameAdded(tabId, 0, url, `page${tabId}`);
      await bg.frameAdded(tabId, 7, 'https://hoster.test/e/x', `hoster${tabId}`);
      await bg.request({tabId, url: stream, frameId: 7});
      await bg.wait(500);
    }

    it('goes on the same way when the tab went on to another site, whose page it leaves alone', async () => {
      // The episode's end clicked that site's "next" link, the
      // user's page went away under them, and its video replaced the series in mpv.
      for (const countdown of [0, 5]) {
        const port = await onEpisode1({autoplayCountdown: countdown}, 'clicked', {next: true},
            {1: linksTo(EP2, EP0)}, {});
        await bg.wait(100);
        await bg.navigated(1, 'https://news.test/today');
        await bg.frameAdded(1, 0, 'https://news.test/today', 'news');
        port.emit({type: 'ended', path: S1});
        await bg.wait(100 + countdown * 1000);
        expect(polls, String(countdown)).toEqual([]);
        expect(navigations, String(countdown)).toEqual([]);
        expect(bg.createdTabs, String(countdown)).toEqual([{id: 1000, url: EP2, active: false, windowId: 1}]);
        bg.unload();
      }
    });

    it('control: clicks the page\'s link when the tab is still on the series\' site', async () => {
      const port = await onEpisode1({}, 'clicked', undefined, {1: linksTo(EP2, EP0)});
      await bg.wait(100);
      await bg.navigated(1, 'https://site.test/about');
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
      expect(bg.createdTabs).toEqual([]);
    });

    it('opens the next episode in a tab not shown, sends its stream, closes it, and goes on from it', async () => {
      const port = await closedAfterEpisode1();
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([{id: 1000, url: EP2, active: false, windowId: 1}]);
      expect(notices(port)).toEqual(['loading in mpv']);
      // Nothing clicked anywhere: the closed tab's page is gone.
      expect(navigations).toEqual([]);

      await newTabLoads(1000, EP2, S2);
      expect(bg.toMpv()).toEqual([S1, S2]);
      // Its links read, it closes again.
      expect(bg.removedTabs).toEqual([1000]);
      await bg.closed(1000);

      // The next end goes on from the episode it showed.
      port.emit({type: 'ended', path: S2});
      await bg.wait(100);
      expect(bg.createdTabs.map((t) => t.url)).toEqual([EP2, EP3]);
      await newTabLoads(1001, EP3, S3);
      expect(bg.toMpv()).toEqual([S1, S2, S3]);
      // No "no stream" notice a minute later.
      await bg.wait(61000);
      expect(notices(port)).toEqual(['loading in mpv', 'loading in mpv']);
    });

    it('goes back with mpv\'s previous key, in a tab not shown', async () => {
      const port = await closedAfterEpisode1();
      port.emit({type: 'request', action: 'previous'});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([{id: 1000, url: EP0, active: false, windowId: 1}]);
    });

    it('counts down first, as with the tab open', async () => {
      const port = await closedAfterEpisode1({autoplayCountdown: 5});
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
      expect(bg.createdTabs).toEqual([]);
      await bg.wait(5000);
      expect(bg.createdTabs).toEqual([{id: 1000, url: EP2, active: false, windowId: 1}]);
      expect(notices(port)).toEqual(['next episode in 5 s (n: now, Space: stop)', 'loading in mpv']);
    });

    it('says so when Firefox makes no tab, and closes one made after mpv was closed', async () => {
      // Neither case had a test.
      let port = await closedAfterEpisode1();
      bg.chrome.tabs.create = async () => {
        throw new Error('No window with id: 1.');
      };
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(notices(port)).toEqual(['its tab is closed, or not in MPV mode']);
      bg.unload();

      port = await closedAfterEpisode1();
      let made;
      bg.chrome.tabs.create = (props) => new Promise((resolve) => {
        made = () => resolve({id: 1500, ...props});
      });
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      port.emit({type: 'closed', reason: 'mpv closed'});
      await bg.wait(100);
      made();
      await bg.wait(100);
      expect(bg.removedTabs).toEqual([1500]);
    });

    it('leaves a tab it opened open when the user looks at it', async () => {
      const port = await closedAfterEpisode1();
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(bg.createdTabs.map((t) => t.url)).toEqual([EP2]);
      bg.tabs.push({id: 1000, url: EP2, active: true});
      await newTabLoads(1000, EP2, S2);
      expect(bg.toMpv()).toEqual([S1, S2]);
      expect(bg.removedTabs).toEqual([]);
    });

    it('closes a tab it opened whose episode mpv no longer waits for', async () => {
      // mpv closed meanwhile.
      let port = await closedAfterEpisode1();
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      port.emit({type: 'closed', reason: 'mpv closed'});
      await bg.wait(100);
      expect(bg.removedTabs).toEqual([1000]);
      bg.unload();

      // Another tab's stream took mpv meanwhile.
      port = await closedAfterEpisode1();
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      await bg.navigated(2, EP3);
      await bg.frameAdded(2, 0, EP3, 'other');
      await bg.request({tabId: 2, url: S3, frameId: 0});
      await bg.wait(500);
      expect(bg.toMpv()).toEqual([S1, S3]);
      expect(bg.removedTabs).toEqual([1000]);
    });

    it('says the series ended, or that it cannot go on, as the closed tab\'s page told', async () => {
      // The series' last episode: at once, and with a countdown set, none counted down.
      const lastOne = {1: {hasNext: false, next: null, hasPrevious: true, previous: EP0, seriesEnd: true}};
      let port = await closedAfterEpisode1({}, lastOne);
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(notices(port)).toEqual(['the last episode of the series: autoplay stops']);
      bg.unload();
      port = await closedAfterEpisode1({autoplayCountdown: 5}, lastOne);
      port.emit({type: 'ended', path: S1});
      await bg.wait(6000);
      expect(notices(port)).toEqual(['the last episode of the series: autoplay stops']);
      expect(bg.createdTabs).toEqual([]);
      bg.unload();

      // A next button, not a link: nothing to open.
      port = await closedAfterEpisode1({}, {1: {hasNext: true, next: null, hasPrevious: false, previous: null, seriesEnd: false}});
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(notices(port)).toEqual(['its tab is closed, or not in MPV mode']);
      expect(bg.createdTabs).toEqual([]);
      bg.unload();

      // Its window closed with it.
      port = await onEpisode1({}, 'clicked', undefined, {1: linksTo(EP2)});
      await bg.wait(100);
      await bg.closed(1, {isWindowClosing: true});
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(notices(port)).toEqual(['its tab is closed, or not in MPV mode']);
      expect(bg.createdTabs).toEqual([]);
    });

    it('reads the links once more when the page had none yet', async () => {
      const links = {};
      const port = await onEpisode1({}, 'clicked', undefined, links);
      await bg.wait(100);
      // The page's episode list came after its stream.
      links[1] = linksTo(EP2);
      await bg.wait(10000);
      await bg.closed(1);
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(bg.createdTabs.map((t) => t.url)).toEqual([EP2]);
    });

    it('opens no link a frame gave, nor one that is no web address', async () => {
      // A hoster's or an ad's frame chose the address of a tab the
      // background opened by itself, in the tab's container.
      let port = await closedAfterEpisode1({}, {'1:5': linksTo('https://ads.test/win')});
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([]);
      expect(notices(port)).toEqual(['its tab is closed, or not in MPV mode']);
      bg.unload();

      port = await closedAfterEpisode1({}, {1: linksTo('javascript:alert(1)', 'file:///C:/x')});
      port.emit({type: 'ended', path: S1});
      port.emit({type: 'request', action: 'previous'});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([]);
    });

    it('opens nothing once MPV mode was switched off', async () => {
      const port = await closedAfterEpisode1();
      bg.options = {...bg.options, mpvMode: false};
      await bg.message({type: 'LOAD_OPTIONS'});
      await bg.wait(100);
      port.emit({type: 'request', action: 'next'});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([]);
    });

    it('sends the episode, not an ad the page asked for first, on a page the MPV allowlist names', async () => {
      // The allowlist's own start does not send beside the episode's pick.
      const port = await closedAfterEpisode1();
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      await bg.navigated(1000, EP2);
      await bg.frameAdded(1000, 0, EP2, 'page1000');
      await bg.frameAdded(1000, 7, 'https://hoster.test/e/x', 'hoster1000');
      await bg.request({tabId: 1000, url: AD, frameId: 7});
      await bg.wait(700);
      await bg.request({tabId: 1000, url: S2, frameId: 7});
      await bg.wait(1000);
      expect(bg.toMpv()).toEqual([S1, S2]);
    });

    it('keeps no links of the page before when the tab is closed before its new page\'s are read', async () => {
      // episode 1's links do not take the tab back to 2
      const links = {1: linksTo(EP2)};
      const port = await onEpisode1({}, 'clicked', undefined, links);
      await bg.wait(100);
      links[1] = new Promise(() => {});
      await bg.navigated(1, EP2);
      await bg.frameAdded(1, 0, EP2, 'ep2');
      await bg.request({tabId: 1, url: S2, frameId: 0});
      await bg.wait(500);
      expect(bg.toMpv()).toEqual([S1, S2]);
      await bg.closed(1);
      port.emit({type: 'ended', path: S2});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([]);
    });

    it('reads a tab it opened once more when its page had no links yet, and closes it then', async () => {
      const links = {1: linksTo(EP2)};
      const port = await closedAfterEpisode1({}, links);
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      await newTabLoads(1000, EP2, S2);
      expect(bg.toMpv()).toEqual([S1, S2]);
      expect(bg.removedTabs).toEqual([]);
      links[1000] = linksTo(EP3);
      await bg.wait(10000);
      expect(bg.removedTabs).toEqual([1000]);
      await bg.closed(1000);
      port.emit({type: 'ended', path: S2});
      await bg.wait(100);
      expect(bg.createdTabs.map((t) => t.url)).toEqual([EP2, EP3]);
    });

    it('opens the episode in the closed tab\'s container, and leaves the default one to the window', async () => {
      let port = await onEpisode1({}, 'clicked', undefined, {1: linksTo(EP2)}, {cookieStoreId: 'firefox-container-2'});
      await bg.wait(100);
      await bg.closed(1);
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([{id: 1000, url: EP2, active: false, windowId: 1, cookieStoreId: 'firefox-container-2'}]);
      bg.unload();

      port = await onEpisode1({}, 'clicked', undefined, {1: linksTo(EP2)}, {cookieStoreId: 'firefox-default'});
      await bg.wait(100);
      await bg.closed(1);
      port.emit({type: 'ended', path: S1});
      await bg.wait(100);
      expect(bg.createdTabs).toEqual([{id: 1000, url: EP2, active: false, windowId: 1}]);
    });
  });

  it('watches again once mpv was closed, and lets an old host go', async () => {
    let port = await onEpisode1();
    port.emit({type: 'closed', reason: 'mpv closed'});
    await bg.navigated(1, EP2);
    await bg.frameAdded(1, 0, EP2, 'ep2');
    await bg.request({tabId: 1, url: S2});
    await bg.wait(500);
    expect(bg.ports).toHaveLength(2);
    // A host before 7 answers "unknown message" and exits: the watch ends, nothing breaks.
    port = mpvEvents(bg.ports.at(-1));
    port.emit({ok: false, error: 'unknown message'});
    port.emit({type: 'ended', path: S2});
    await bg.wait(100);
    expect(navigations).toEqual([]);
  });
});

describe('MPV mode and a page that offers its file in several qualities', () => {
  // A Playerjs hoster with 360p default and 720p/1080p files beside it: mpv gets the best one.
  const HOSTER = 'https://hoster.test/embed/1/';
  const file = (quality) => `https://hoster.test/get_file/9/abc/1/1_${quality}.mp4/`;
  const CDN = 'https://a61.cdn.test/remote_control.php?time=1&file=%2Fvideos%2F1_360p.mp4';
  const LIST = [
    {url: file('360p'), label: '360p', height: 360},
    {url: file('720p'), label: '720p', height: 720},
    {url: file('1080p'), label: '1080p', height: 1080},
  ];

  /**
   * The allowlisted hoster's page asks for its default file, through the redirect.
   * @param {Object} [options] - Options over MPV mode's.
   * @param {Array<Array<Object>>} [lists] - What the page answers GET_PAGE_QUALITIES with.
   * @return {Promise<void>}
   */
  async function pagePlays(options = {}, lists = [LIST]) {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/'], ...options},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: ({message}) => (message.type === 'GET_PAGE_QUALITIES' ? lists : undefined),
    });
    await bg.navigated(1, HOSTER);
    const sent = bg.requestSent({tabId: 1, url: file('360p'), type: 'media'});
    const atCdn = bg.redirected(sent, CDN);
    await bg.responded(atCdn, {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    await bg.wait(100);
  }

  it('sends the highest the page offers, with the list for mpv', async () => {
    await pagePlays();
    expect(bg.toMpv()).toEqual([file('1080p')]);
    const open = bg.played()[0];
    expect(open.qualities).toEqual(LIST);
    // The page's headers go with it, as with the stream the page asked for.
    expect(open.headers).toEqual([{name: 'Referer', value: 'https://site.test/'}]);
  });

  it('sends the quality the user\'s setting asks for', async () => {
    await pagePlays({defaultQuality: '720p'});
    expect(bg.toMpv()).toEqual([file('720p')]);
  });

  it('sends the page\'s own file, as before, when the page lists no qualities', async () => {
    await pagePlays({}, []);
    expect(bg.toMpv()).toEqual([CDN]);
    expect(bg.played()[0].qualities).toBeUndefined();
  });

  it('does not take another file\'s list for this one', async () => {
    const other = [{url: 'https://hoster.test/get_file/9/abc/2/2_360p.mp4/', label: '360p', height: 360},
      {url: 'https://hoster.test/get_file/9/abc/2/2_720p.mp4/', label: '720p', height: 720}];
    await pagePlays({}, [other]);
    expect(bg.toMpv()).toEqual([CDN]);
  });

  it('sends nothing when Firefox VPN carried the page\'s request, though the quality file\'s host was never seen', async () => {
    // The VPN check covers the host the page's stream came through, not only the best file's.
    const VPN = {type: 'https', host: 'muc139.m1.fastly-masque.net', port: 2499,
      proxyAuthorizationHeader: 'Bearer token', connectionIsolationKey: 'iso', failoverTimeout: 10};
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/']},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: ({message}) => (message.type === 'GET_PAGE_QUALITIES' ? [LIST] : undefined),
    });
    await bg.navigated(1, HOSTER);
    const sent = bg.requestSent({tabId: 1, url: file('360p'), type: 'media', proxyInfo: VPN});
    const atCdn = bg.redirected(sent, CDN);
    await bg.responded(atCdn, {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toContain('Firefox VPN');
  });

  it('goes on to the next episode at the end of a quality mpv switched to', async () => {
    // mpv's quality menu loads another of the page's files with the same fs-* tags: its end is the
    // episode's end.
    const navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/'], mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: ({message}) => {
        if (message.type === 'GET_PAGE_QUALITIES') return [LIST];
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push(message.direction);
        return 'clicked';
      },
    });
    await bg.navigated(1, HOSTER);
    const sent = bg.requestSent({tabId: 1, url: file('360p'), type: 'media'});
    const atCdn = bg.redirected(sent, CDN);
    await bg.responded(atCdn, {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([file('1080p')]);
    const port = mpvEvents(bg.ports.at(-1));
    port.emit({type: 'watching'});
    port.emit({type: 'ended', path: file('720p') + '#fs-id=0123456789abcdef&fs-quality=x'});
    await bg.wait(100);
    expect(navigations).toEqual(['next']);
  });

  it('goes on at the end of a stream sent in another spelling than the one mpv plays', async () => {
    // the ended URL is compared as the host writes it (mpvTargetUrl)
    const navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/'], mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: ({message}) => {
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push(message.direction);
        return 'clicked';
      },
    });
    await bg.navigated(1, HOSTER);
    await bg.frameAdded(1, 0, HOSTER, 'page1');
    await bg.message({type: 'MPV_OPEN', url: 'HTTPS://CDN.test/Episode%201.m3u8', headers: []},
        {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    const port = mpvEvents(bg.ports.at(-1));
    port.emit({type: 'watching'});
    port.emit({type: 'ended', path: 'https://cdn.test/Episode%201.m3u8#fs-id=0123456789abcdef'});
    await bg.wait(100);
    expect(navigations).toEqual(['next']);
  });

  it('leaves the old tab alone when another tab\'s stream takes mpv while its page goes on', async () => {
    // A stream another tab sent during goToEpisode's wait moves the watch: the old tab gets no next
    // episode.
    const OTHER = 'https://hoster.test/other';
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/'], mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: HOSTER}, {id: 2, url: OTHER}],
      onTabMessage: ({message}) => message.type === 'PLAYLIST_NAVIGATION' ?
        new Promise((resolve) => setTimeout(() => resolve('clicked'), 1000)) : undefined,
    });
    const player = 'moz-extension://bg-test/player/index.html';
    await bg.navigated(1, HOSTER);
    await bg.frameAdded(1, 0, HOSTER, 'page1');
    await bg.navigated(2, OTHER);
    await bg.message({type: 'MPV_OPEN', url: 'https://cdn.test/one.m3u8', headers: []}, {tabId: 1, frameId: 0, url: player});
    const port = mpvEvents(bg.ports.at(-1));
    port.emit({type: 'watching'});
    port.emit({type: 'ended', path: 'https://cdn.test/one.m3u8#fs-id=0123456789abcdef'});
    await bg.wait(100);
    // The page is still asked; tab 2's stream goes to the same mpv meanwhile.
    await bg.message({type: 'MPV_OPEN', url: 'https://cdn.test/two.m3u8', headers: []}, {tabId: 2, frameId: 0, url: player});
    await bg.wait(61000);
    expect(port.sent.filter((m) => m.type === 'notify' && /no stream/.test(m.detail))).toEqual([]);
  });

  it('does not go on at the end of a file the user opened in mpv himself', async () => {
    const navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/'], mpvAutoplayNext: true, autoplayCountdown: 0},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: ({message}) => {
        if (message.type === 'GET_PAGE_QUALITIES') return [LIST];
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push(message.direction);
        return 'clicked';
      },
    });
    await bg.navigated(1, HOSTER);
    const sent = bg.requestSent({tabId: 1, url: file('360p'), type: 'media'});
    await bg.responded(bg.redirected(sent, CDN), {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});
    await bg.wait(100);
    const port = mpvEvents(bg.ports.at(-1));
    port.emit({type: 'watching'});
    port.emit({type: 'ended', path: 'https://other.test/film.mp4'});
    await bg.wait(100);
    expect(navigations).toEqual([]);
  });
});

describe('the player\'s mpv button and a page that offers several qualities', () => {
  const HOSTER = 'https://hoster.test/embed/1/';
  const file = (quality) => `https://hoster.test/get_file/9/abc/1/1_${quality}.mp4/`;
  const LIST = [
    {url: file('360p'), label: '360p', height: 360},
    {url: file('1080p'), label: '1080p', height: 1080},
  ];

  it('sends the quality the player plays, which the user may have picked, with its list', async () => {
    // The user picked 360p in FastStream's quality menu, then pressed its mpv button. MPV
    // mode's own pick (the highest) is not the button's: it went to mpv instead.
    bg = await loadBackground({
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: ({message}) => (message.type === 'GET_PAGE_QUALITIES' ? [LIST] : undefined),
    });
    await bg.navigated(1, HOSTER);
    const sent = bg.requestSent({tabId: 1, url: file('360p'), type: 'media'});
    const atCdn = bg.redirected(sent, 'https://cdn.test/remote_control.php?time=1');
    await bg.responded(atCdn, {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]});

    await bg.message({type: 'MPV_OPEN', url: file('360p'), headers: [], qualities: LIST}, {tabId: 1, frameId: 7, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(100);

    expect(bg.toMpv()).toEqual([file('360p')]);
    expect(bg.played()[0].qualities).toEqual(LIST);
  });
});

describe('MPV mode and an HLS stream whose master playlist offers several qualities', () => {
  // A JW Player master and the variant its Auto picks run equally long: mpv gets the master.
  const MASTER = 'https://cdn.test/v/master.m3u8';
  const variant = (height) => `https://cdn.test/v/${height}/index.m3u8`;
  const LIST = [
    {url: variant(1080), label: '1080p', height: 1080},
    {url: variant(720), label: '720p', height: 720},
    {url: variant(480), label: '480p', height: 480},
  ];
  const master = (extra = '') => '#EXTM3U\n' + extra +
    `#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480${extra ? ',AUDIO="aac"' : ''}\n480/index.m3u8\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080${extra ? ',AUDIO="aac"' : ''}\n1080/index.m3u8\n` +
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720${extra ? ',AUDIO="aac"' : ''}\n720/index.m3u8\n`;

  /**
   * The network: the master playlist, and each variant a 1400 s media playlist.
   * @param {string} text - The master playlist.
   * @param {number} [masterDelayMs] - How long the master playlist takes to come, if at all.
   * @return {function(string): Promise<Object>} fetch() for loadBackground.
   */
  function network(text, masterDelayMs = 0) {
    return async (url) => {
      if (url === MASTER) {
        if (masterDelayMs) await new Promise((resolve) => setTimeout(resolve, masterDelayMs));
        return response(text);
      }
      return /\/index\.m3u8$/.test(url) ? response(hlsPlaylist(1400)) : response('', 404);
    };
  }

  /**
   * The page loads the master playlist, then the variant its player picked for itself.
   * @param {number} height - That variant's.
   * @return {Promise<void>}
   */
  async function pageLoads(height) {
    await bg.request({tabId: 1, url: MASTER});
    await bg.wait(100);
    await bg.request({tabId: 1, url: variant(height)});
  }

  it('sends a play the highest variant, with the list for mpv, though the page loaded its Auto pick last', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: network(master())});
    await bg.command('toggle_mpv', 1);
    await pageLoads(480);
    await bg.wait(1000);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([variant(1080)]);
    expect(bg.played()[0].qualities).toEqual(LIST);
  });

  it('sends an allowlisted page\'s first stream as the quality the setting asks for', async () => {
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], defaultQuality: '720p'},
      tabs: [{id: 1, url: PAGE}],
      fetch: network(master()),
    });
    await bg.navigated(1, PAGE);
    await pageLoads(480);
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([variant(720)]);
    expect(bg.played()[0].qualities).toEqual(LIST);
  });

  it('sends the master when its variants have no sound of their own, and mpv picks the highest itself', async () => {
    const withAudio = master('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",DEFAULT=YES,URI="audio/de.m3u8"\n');
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: network(withAudio)});
    await bg.command('toggle_mpv', 1);
    await pageLoads(480);
    await bg.wait(1000);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([MASTER]);
    expect(bg.played()[0].qualities).toBeUndefined();
  });

  it('waits for the master playlist\'s read when the toolbar sends a variant read before it', async () => {
    // The master's host is slow, the variant's CDN fast: the variant's length is known while
    // the master's read still runs, and the toolbar's MPV sends without waiting for the
    // lengths.
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: PAGE}],
      fetch: network(master(), 1000),
    });
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    // MPV off before the page loads its stream; then Off -> On -> MPV, which sends the tab's
    // known streams (openMpvWithSources).
    await bg.click(1);
    await pageLoads(480);
    await bg.wait(300);
    await bg.click(1);
    await bg.click(1);
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([variant(1080)]);
    expect(bg.played()[0].qualities).toEqual(LIST);
  });

  it('sends a variant whose master the page never loaded as it is', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: network(master())});
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: variant(480)});
    await bg.wait(1000);
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}},
        {tabId: 1, frameId: 0});
    await bg.wait(500);
    expect(bg.toMpv()).toEqual([variant(480)]);
  });
});

describe('a copy-protected stream (DRM)', () => {
  // mpv has no key system either: its window stayed black, where the page's player plays
  // the video. Nothing is handed off, and the reason shows where a failed hand-off does.
  const WIDEVINE = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAANHBzc2g=",' +
    'KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
  const VARIANT = 'https://cdn.test/episode/1080.m3u8';
  const network = {
    [EPISODE]: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\n${VARIANT}\n`,
    [VARIANT]: hlsPlaylist(1400).replace('#EXT-X-VERSION:3', `#EXT-X-VERSION:3\n${WIDEVINE}`),
    [AD]: hlsPlaylist(30),
  };

  it('is not handed to mpv by the allowlist, nor the page\'s next stream, and the toolbar says why', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists(network, 50)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.badges.get(1)).toBe('!');
    expect(bg.titles.get(1)).toContain('copy-protected');
    // The page's next stream is an ad's, or one of the film's pieces: not the video.
    await bg.request({tabId: 1, url: AD});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
  });

  it('is not handed to mpv by the toolbar\'s On -> MPV, nor the page\'s next stream', async () => {
    // The toolbar's MPV refused keeps the tab off: no later stream of the page goes to mpv.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists(network, 50)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    // MPV -> Off before the page loads its stream; then Off -> On -> MPV.
    await bg.click(1);
    await bg.request({tabId: 1, url: EPISODE});
    await bg.click(1);
    await bg.click(1);
    await bg.wait(2000);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    expect(bg.toMpv()).toEqual([]);
    expect(bg.titles.get(1)).toContain('copy-protected');
    await bg.request({tabId: 1, url: AD});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
    expect(bg.titles.get(1)).toContain('copy-protected');
  });

  it('is not handed to mpv by the allowlist\'s start by address, nor the page\'s next stream', async () => {
    // A page that changes its own address onto the allowlist (pushState): the start by
    // address sends what the tab tracks (startWithTrackedLater, openMpvWithSources).
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/watch']},
      tabs: [{id: 1, url: 'https://site.test/'}], fetch: playlists(network, 50)});
    await bg.navigated(1, 'https://site.test/');
    await bg.frameAdded(1, 0, 'https://site.test/', 'app');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.navigated(1, PAGE);
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.titles.get(1)).toContain('copy-protected');
    await bg.request({tabId: 1, url: AD});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
  });

  it('is not paused by the shortcut\'s MPV when the user plays it again', async () => {
    // A play the host refused lets the next play try again.
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: playlists(network, 50)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    await bg.command('toggle_mpv', 1);
    const play = {type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', video: {src: 'blob:https://site.test/1', duration: 1400}};
    await bg.message(play, {tabId: 1, frameId: 0});
    await bg.wait(2000);
    expect(bg.titles.get(1)).toContain('copy-protected');
    await bg.message(play, {tabId: 1, frameId: 0});
    await bg.wait(2000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
  });

  it('is not sent by the player\'s mpv button, whose answer says why, read only then', async () => {
    // Detected with the tab off: nothing read it. The button's hand-off reads it first.
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: playlists(network, 50)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE});
    const answer = bg.message({type: 'MPV_OPEN', url: EPISODE, headers: [], qualities: []},
        {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(1000);
    expect(await answer).toMatchObject({ok: false, drm: true});
    expect(bg.played()).toEqual([]);
  });

  it('leaves a clear stream as it was', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: hlsPlaylist(1400)}, 50)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(2000);
    expect(bg.toMpv()).toHaveLength(1);
  });

  it('is a DASH stream too, read only when the player\'s button sends it', async () => {
    // Detected with the tab off, nothing read it; openInMpv waits for no DASH manifest for
    // qualities (hlsQualityChoice is HLS only), so it waits for this one's read itself.
    const MPD = 'https://cdn.test/episode/manifest.mpd';
    const mpd = '<MPD type="static" mediaPresentationDuration="PT24M"><Period><AdaptationSet contentType="video">' +
      '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>' +
      '<Representation id="1" width="1920"/></AdaptationSet></Period></MPD>';
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: playlists({[MPD]: mpd}, 300)});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'episode');
    await bg.request({tabId: 1, url: MPD}, {responseHeaders: [{name: 'Content-Type', value: 'application/dash+xml'}]});
    const answer = bg.message({type: 'MPV_OPEN', url: MPD, headers: [], qualities: []},
        {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(1000);
    expect(await answer).toMatchObject({ok: false, drm: true});
    expect(bg.played()).toEqual([]);
  });
});

describe('a file only its page loads', () => {
  // Only the page's service worker gives this video (others get "Video not found"): FastStream's
  // player loads it via the page.
  const FILE = 'https://player.test/#mp4/abc/1080';
  const html = () => async () => response('<html>Video not found</html>', 200, 'text/html; charset=utf-8');
  const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';

  /** The page's video, played with no request Firefox shows (a service worker answered it). */
  async function pagePlays() {
    await bg.message({type: 'LOADED_MEDIA', live: true, url: PAGE, document: 'page-1',
      resources: [{url: FILE, media: true, cors: false, time: Date.now()}]}, {tabId: 1, frameId: 0});
  }

  it('is not handed to mpv by the allowlist: FastStream\'s player opens, and tells why', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: html()});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await pagePlays();
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([]);
    expect(bg.played()).toEqual([]);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false, mpvError: null});
    expect(bg.badges.get(1)).not.toBe('!');
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);

    // The player that opened gets the notice with the sources, once.
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    bg.sentToTabs.length = 0;
    await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
    await bg.wait(3000);
    const sent = bg.sent('SOURCES').filter((m) => m.frameId === 5);
    expect(sent).toHaveLength(1);
    expect(sent[0].message.notice).toBe('player_mpv_page_only');
    expect(sent[0].message.sources.map((s) => s.url)).toEqual([FILE]);
    bg.sentToTabs.length = 0;
    await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
    await bg.wait(3000);
    expect(bg.sent('SOURCES').filter((m) => m.frameId === 5)[0].message.notice).toBeUndefined();
  });

  it('is not handed to mpv by the shortcut\'s MPV either', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: html()});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.command('toggle_mpv', 1);
    await bg.message({type: 'MPV_USER_PLAY', src: FILE, video: {src: FILE, duration: 600}}, {tabId: 1, frameId: 0});
    await pagePlays();
    await bg.wait(3000);
    expect(bg.played()).toEqual([]);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false, mpvOnPlay: false});
    expect(bg.sent('OPEN_PLAYER')).toHaveLength(1);
  });

  it('is not sent by the player\'s mpv button, whose answer says why', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: html()});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await pagePlays();
    await bg.wait(1500);
    const answer = bg.message({type: 'MPV_OPEN', url: FILE, headers: [], qualities: []},
        {tabId: 1, frameId: 0, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(2000);
    expect(await answer).toMatchObject({ok: false, pageOnly: true});
    expect(bg.played()).toEqual([]);
  });

  it('turns the tab off at the toolbar\'s next click, as MPV -> Off', async () => {
    // On -> MPV refused reaches Off on the next click.
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: html()});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await pagePlays();
    await bg.wait(3000);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.click(1);
    await bg.wait(500);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
    // The cycle goes on as ever: Off -> On.
    await bg.click(1);
    await bg.wait(500);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    expect(bg.played()).toEqual([]);
  });

  it('turns the tab off at the toolbar\'s next click after Firefox stopped the event page too', async () => {
    // a woken background knows which page the On stands in for MPV on
    const setup = {options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}], fetch: html()};
    bg = await loadBackground(setup);
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await pagePlays();
    await bg.wait(3000);
    const session = bg.session;
    bg.unload();

    bg = await loadBackground({...setup, session});
    await bg.click(1);
    await bg.wait(500);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false, isMpv: false});
    expect(bg.reloaded).toEqual([]);
  });

  it('lets the MPV key\'s next play of the same video go, not dropped as a repeat', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}], fetch: html()});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.command('toggle_mpv', 1);
    await bg.message({type: 'MPV_USER_PLAY', src: FILE, video: {src: FILE, duration: 600}}, {tabId: 1, frameId: 0});
    await pagePlays();
    await bg.wait(3000);
    expect(bg.session['tabState:1']).toMatchObject({isMpv: false, mpvLastPlaySend: null});
  });

  it('leaves a file that answers as a video as it was', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}],
      fetch: async () => response(new Uint8Array(16), 206, 'video/mp4')});
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await pagePlays();
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([FILE]);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
  });
});

describe('the shortcut\'s MPV, a play in a frame that saw no press', () => {
  /**
   * The episode's player frame (5) below the frame with the play button (4).
   * @param {?number} pressBeforeMs - How long before the play the frame that answers saw the click; null: none.
   * @param {{documentAgeMs?: number, pressedIn?: number, parentKnown?: boolean}} [options] - How long the player
   *   frame's page had been there at the play; the frame that saw the click; whether frame 5's parent is known.
   * @return {Promise<void>}
   */
  async function playBelowClick(pressBeforeMs, {documentAgeMs = 300, pressedIn = 4, parentKnown = true} = {}) {
    let playedAt = 0;
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: PAGE}],
      fetch: playlists({[EPISODE]: 1400}),
      onTabMessage: ({frameId, message}) => (message.type === 'LAST_PRESS' && frameId === pressedIn ?
        (pressBeforeMs === null ? null : playedAt - pressBeforeMs) : undefined),
    });
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, frameId: 5, parentFrameId: parentKnown ? 4 : -1, url: EPISODE});
    playedAt = Date.now();
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/1', pressedHere: false,
      playedAt, documentStart: playedAt - documentAgeMs,
      video: {src: 'blob:https://site.test/1', duration: 1400}}, {tabId: 1, frameId: 5});
    await bg.wait(3000);
  }

  it('sends it when the frame above saw the click (a play button that loads its player below)', async () => {
    await playBelowClick(800);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('asks the page itself when the frames between are not known (a woken background)', async () => {
    await playBelowClick(800, {pressedIn: 0, parentKnown: false});
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('sends nothing for no click above, one past Firefox\'s activation time, or one after the play', async () => {
    for (const before of [null, 5200, -300]) {
      await playBelowClick(before);
      expect(bg.toMpv(), String(before)).toEqual([]);
      bg.unload();
    }
    bg = null;
  });

  it('sends nothing from a frame that was there before the click (an ad that autoplays after it)', async () => {
    await playBelowClick(800, {documentAgeMs: 30000});
    expect(bg.toMpv()).toEqual([]);
  });
});
