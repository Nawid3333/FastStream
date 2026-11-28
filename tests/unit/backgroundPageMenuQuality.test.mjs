import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// A hoster whose page plays 360p while its player's menu offers 480p and 1080p, each file made only when picked
// there (page-quality-control.js): the background has the page switch to the quality the setting asks for, once, as
// the file is detected or handed off, and FastStream's player or mpv starts on the file the page loads then
// (PageMenuQuality.mjs).

const HOSTER = 'https://hoster.test/embed/1/';
const file = (quality) => `https://hoster.test/v/1_${quality}.mp4`;
const MP4 = {statusCode: 206, responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]};
const MENU = {id: 3, width: 640, height: 360, choices: [
  {label: 'Auto', height: 0, auto: true, selected: false},
  {label: '360p', height: 360, auto: false, selected: true},
  {label: '480p', height: 480, auto: false, selected: false},
  {label: '1080p', height: 1080, auto: false, selected: false},
]};
const switchedTo = (quality, width, height) => ({url: file(quality), width, height, changed: true});
// What each menu entry loads in the page.
const FILES = {1: switchedTo('360p', 640, 360), 2: switchedTo('480p', 854, 480), 3: switchedTo('1080p', 1920, 1080)};

let bg;

// The caps, read once a background is loaded (the module reads chrome.* as it loads).
const caps = () => import('../../chrome/background/PageMenuQuality.mjs');

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * The page's answers: no list of files, the menu above, and the switch.
 * @param {Object} [page]
 * @param {*} [page.menu] - The probe's answer; a Promise for one that never comes, a function for one made when asked.
 * @param {function(number): *} [page.select] - The switch's answer, by the entry's index.
 * @param {*} [page.played] - GET_PLAYED_VIDEO's answer.
 * @return {function(Object): *}
 */
function hosterPage({menu = MENU, select = (index) => FILES[index], played} = {}) {
  return ({message}) => {
    if (message.type === 'GET_PAGE_QUALITIES') return [];
    if (message.type === 'GET_PLAYED_VIDEO') return played;
    if (message.type === 'PAGE_QUALITY_PROBE') return typeof menu === 'function' ? menu(message) : menu;
    if (message.type === 'PAGE_QUALITY_SELECT') return select(message.index);
    return undefined;
  };
}

/**
 * The allowlist's MPV on the hoster: its first stream goes to mpv by itself.
 * @param {Object} [options] - Over MPV mode's.
 * @param {Object} [page] - hosterPage's.
 * @return {Promise<void>}
 */
async function pagePlays(options = {}, page = {}) {
  bg = await loadBackground({
    options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/'], ...options},
    tabs: [{id: 1, url: HOSTER}],
    onTabMessage: hosterPage(page),
  });
  await bg.navigated(1, HOSTER);
  await bg.request({tabId: 1, url: file('360p'), type: 'media'}, MP4);
}

describe('MPV mode and qualities only the page player\'s menu knows', () => {
  it('has the page switch to the quality the setting asks for, and sends mpv that file', async () => {
    await pagePlays({defaultQuality: '1080p'});
    await bg.wait(100);

    expect(bg.sent('PAGE_QUALITY_PROBE')).toEqual([{tabId: 1, frameId: 0, message: {type: 'PAGE_QUALITY_PROBE', url: file('360p')}}]);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([{tabId: 1, frameId: 0, message: {type: 'PAGE_QUALITY_SELECT', id: 3, index: 3}}]);
    expect(bg.toMpv()).toEqual([file('1080p')]);
    // No list: the menu's other entries have no files.
    expect(bg.played()[0].qualities).toBeUndefined();
    expect(bg.played()[0].headers).toEqual([{name: 'Referer', value: 'https://site.test/'}]);
  });

  it('takes the highest for Auto, and the one asked for otherwise', async () => {
    await pagePlays();
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT').map((m) => m.message.index)).toEqual([3]);
    expect(bg.toMpv()).toEqual([file('1080p')]);
    bg.unload();

    await pagePlays({defaultQuality: '480p'});
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT').map((m) => m.message.index)).toEqual([2]);
    expect(bg.toMpv()).toEqual([file('480p')]);
  });

  it('switches nothing when the page already plays the quality asked for', async () => {
    await pagePlays({defaultQuality: '360p'});
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
    expect(bg.toMpv()).toEqual([file('360p')]);
  });

  it('finds the playing entry by the video\'s size when the menu marks none', async () => {
    const unmarked = {...MENU, width: 854, height: 480, choices: MENU.choices.map((c) => ({...c, selected: false}))};
    await pagePlays({defaultQuality: '480p'}, {menu: unmarked});
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
    expect(bg.toMpv()).toEqual([file('360p')]);
  });

  it('sends the page\'s own file when the switch brings a file of another origin', async () => {
    await pagePlays({}, {select: () => ({url: 'https://elsewhere.test/1080.mp4', width: 1920, height: 1080, changed: true})});
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT').length).toBe(1);
    expect(bg.toMpv()).toEqual([file('360p')]);
  });

  it('sends the page\'s own file when a label lies: its switch brings no bigger file', async () => {
    // "1080p" is the 854x480 file, and 480p plays.
    const menu = {id: 3, width: 854, height: 480, choices: [
      {label: '480p', height: 480, auto: false, selected: true},
      {label: '1080p', height: 1080, auto: false, selected: false},
    ]};
    await pagePlays({}, {menu, select: () => switchedTo('fake-1080p', 854, 480)});
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT').length).toBe(1);
    expect(bg.toMpv()).toEqual([file('360p')]);
  });

  it('adds at most its cap to the hand-off of a page that never answers the probe', async () => {
    let started = 0;
    let sentAt = 0;
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://hoster.test/']},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: hosterPage({menu: new Promise(() => {})}),
      onNative: (m) => {
        if (m.type === 'play') sentAt = Date.now();
        return {ok: true};
      },
    });
    const {MenuProbeCapMs} = await caps();
    await bg.navigated(1, HOSTER);
    started = Date.now();
    await bg.request({tabId: 1, url: file('360p'), type: 'media'}, MP4);
    await bg.wait(MenuProbeCapMs + 100);
    expect(bg.toMpv()).toEqual([file('360p')]);
    expect(sentAt - started).toBeLessThanOrEqual(MenuProbeCapMs + 50);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
  });

  it('gives up on a switch the page does not finish within its cap', async () => {
    await pagePlays({}, {select: () => new Promise(() => {})});
    const {MenuSwitchCapMs} = await caps();
    await bg.wait(MenuSwitchCapMs - 200);
    expect(bg.toMpv()).toEqual([]);
    await bg.wait(400);
    expect(bg.toMpv()).toEqual([file('360p')]);
  });

  it('never asks the page for the player\'s mpv button, which sends what the player plays', async () => {
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: hosterPage(),
    });
    await bg.navigated(1, HOSTER);
    await bg.request({tabId: 1, url: file('360p'), type: 'media'}, MP4);
    await bg.message({type: 'MPV_OPEN', url: file('360p'), headers: []},
        {tabId: 1, frameId: 7, url: 'moz-extension://bg-test/player/index.html'});
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([file('360p')]);
    expect(bg.sent('PAGE_QUALITY_PROBE')).toEqual([]);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
  });
});

describe('the shortcut\'s MPV and a page that switched its menu\'s quality for the send', () => {
  const play = (quality) => ({type: 'MPV_USER_PLAY', src: file(quality), video: {src: file(quality), duration: 1400}});

  /**
   * The shortcut's MPV in the hoster's tab; the user starts its 360p file. The page's switch answers when told.
   * @return {Promise<function(): void>} Answers the switch.
   */
  async function userPlays() {
    let answerSwitch = () => {};
    const switched = new Promise((resolve) => {
      answerSwitch = () => resolve(FILES[3]);
    });
    bg = await loadBackground({
      options: {mpvMode: true},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: hosterPage({select: () => switched}),
    });
    await bg.navigated(1, HOSTER);
    await bg.command('toggle_mpv', 1);
    await bg.request({tabId: 1, url: file('360p'), type: 'media'}, MP4);
    await bg.message(play('360p'), {tabId: 1, frameId: 0});
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT').length).toBe(1);
    return answerSwitch;
  }

  it('sends the switched file once, though the page plays it before its switch answered', async () => {
    const answerSwitch = await userPlays();
    // The page's player loads and plays the new file within the user's press.
    await bg.request({tabId: 1, url: file('1080p'), type: 'media'}, MP4);
    await bg.message(play('1080p'), {tabId: 1, frameId: 0});
    await bg.wait(100);
    answerSwitch();
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([file('1080p')]);
  });

  it('sends the switched file once, its play reported after mpv had it', async () => {
    const answerSwitch = await userPlays();
    answerSwitch();
    await bg.wait(100);
    expect(bg.toMpv()).toEqual([file('1080p')]);
    await bg.request({tabId: 1, url: file('1080p'), type: 'media'}, MP4);
    await bg.message(play('1080p'), {tabId: 1, frameId: 0});
    await bg.wait(3000);
    expect(bg.toMpv()).toEqual([file('1080p')]);
    // As for a repeat of the same video: the page is paused, mpv plays it.
    expect(bg.sent('PAUSE_MEDIA').length).toBeGreaterThan(0);
  });
});

describe('a page switch whose listener fails', () => {
  it('lets the plays that waited for it go on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bg = await loadBackground({tabs: [{id: 1, url: HOSTER}], onTabMessage: hosterPage()});
    // The background's own copy of the module.
    const {onPageMenuFile, pageMenuSwitching, startMenuChoice} = await caps();
    const tab = {tabId: 1};
    const frame = {isPlayer: false, tab, frameId: 0, documentKey: 'page-1', url: HOSTER};
    const choice = startMenuChoice(frame, {url: file('360p'), mode: 'direct'}, Infinity);
    onPageMenuFile(choice, () => {
      throw new Error('listener');
    });
    await bg.wait(100);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toHaveLength(1);
    expect(pageMenuSwitching(tab)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('FastStream\'s player and qualities only the page player\'s menu knows', () => {
  const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';
  // The menu's entries as the player gets them: the files known with their url, the others switched to in the page.
  const entries = (urls) => [
    {url: urls[0], label: '360p', height: 360, control: {id: 3, index: 1}},
    {url: urls[1], label: '480p', height: 480, control: {id: 3, index: 2}},
    {url: urls[2], label: '1080p', height: 1080, control: {id: 3, index: 3}},
  ];

  /**
   * An auto-enabled hoster page detects its 360p file; FastStream's player opens in its frame 5 and asks for sources.
   * @param {Object} [options] - Over the defaults.
   * @param {Object} [page] - hosterPage's.
   * @param {function(): Promise<void>} [beforePlayer] - What the page does before the player asks.
   * @return {Promise<{sources: Array<Object>, video: *, waited: number}>} What the player got, and how long after it asked.
   */
  async function playerStarts(options = {}, page = {}, beforePlayer = async () => {}) {
    let sourcesAt = 0;
    const answers = hosterPage(page);
    bg = await loadBackground({
      options: {autoEnableURLs: ['https://hoster.test/'], ...options},
      tabs: [{id: 1, url: HOSTER}],
      onTabMessage: (sent) => {
        if (sent.message.type === 'SOURCES') sourcesAt = Date.now();
        return answers(sent);
      },
    });
    await bg.navigated(1, HOSTER);
    await bg.frameAdded(1, 0, HOSTER, 'page-1');
    await bg.request({tabId: 1, url: file('360p'), type: 'media'}, MP4);
    await beforePlayer();
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    const asked = Date.now();
    await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 1, frameId: 5});
    await bg.wait(8000);
    const sent = bg.sent('SOURCES').filter((m) => m.frameId === 5);
    expect(sent).toHaveLength(1);
    return {sources: sent[0].message.sources, video: sent[0].message.video, waited: sourcesAt - asked};
  }

  it('starts on the file the page switched to, with the menu\'s entries, asked once at detection', async () => {
    const {sources} = await playerStarts({defaultQuality: '1080p'});
    expect(sources.map((s) => s.url)).toEqual([file('1080p')]);
    expect(sources[0].qualities).toEqual(entries([file('360p'), null, file('1080p')]));
    expect(sources[0].frameId).toBe(0);
    expect(bg.sent('PAGE_QUALITY_PROBE')).toEqual([{tabId: 1, frameId: 0, message: {type: 'PAGE_QUALITY_PROBE', url: file('360p')}}]);
    expect(bg.sent('PAGE_QUALITY_SELECT').length).toBe(1);
  });

  it('takes the switched file the page loads before the player is there for no source of its own', async () => {
    const {sources} = await playerStarts({}, {}, async () => {
      await bg.wait(100);
      await bg.request({tabId: 1, url: file('1080p'), type: 'media'}, MP4);
    });
    expect(sources.map((s) => s.url)).toEqual([file('1080p')]);
    // Not asked about either: it is the switch's.
    expect(bg.sent('PAGE_QUALITY_PROBE').length).toBe(1);
  });

  it('tells the player the page\'s video is the switched file, beside a teaser without a menu', async () => {
    const TEASER = 'https://hoster.test/v/teaser.mp4';
    const {sources, video} = await playerStarts({}, {
      menu: (message) => (message.url === file('360p') ? MENU : null),
      played: {src: file('360p'), duration: null},
    }, async () => {
      await bg.request({tabId: 1, url: TEASER, type: 'media'}, MP4);
    });
    expect(sources.map((s) => s.url).sort()).toEqual([file('1080p'), TEASER].sort());
    expect(video?.src).toBe(file('1080p'));
  });

  it('starts on the page\'s file, with the menu\'s entries, when the page plays the quality asked for', async () => {
    const {sources, waited} = await playerStarts({defaultQuality: '360p'});
    expect(sources.map((s) => s.url)).toEqual([file('360p')]);
    expect(sources[0].qualities).toEqual(entries([file('360p'), null, null]));
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
    expect(waited).toBeLessThan(50);
  });

  it('starts at once on the page\'s file when the page has no menu', async () => {
    const {sources, waited} = await playerStarts({}, {menu: null});
    expect(sources.map((s) => s.url)).toEqual([file('360p')]);
    expect(sources[0].qualities).toBeUndefined();
    expect(waited).toBeLessThan(50);
  });

  it('starts the next file of a hoster whose page had no menu at once, and waits again once one is found', async () => {
    let menu = {none: true};
    let sourcesAt = 0;
    const answers = hosterPage({menu: () => (typeof menu === 'function' ? menu() : menu)});
    bg = await loadBackground({
      options: {autoEnableURLs: ['https://hoster.test/']},
      tabs: [1, 2, 3].map((id) => ({id, url: `https://hoster.test/embed/${id}/`})),
      onTabMessage: (sent) => {
        if (sent.message.type === 'SOURCES') sourcesAt = Date.now();
        return answers(sent);
      },
    });
    /**
     * Episode n in tab n: its 360p file detected, then FastStream's player asks for sources.
     * @param {number} n
     * @return {Promise<{sources: Array<Object>, waited: number}>}
     */
    const episode = async (n) => {
      const page = `https://hoster.test/embed/${n}/`;
      await bg.navigated(n, page);
      await bg.frameAdded(n, 0, page, `page-${n}`);
      await bg.request({tabId: n, url: file(`${n}-360p`), type: 'media'}, MP4);
      await bg.message({type: 'PLAYER_LOADED', url: `moz-extension://bg-test/player/index.html?opener=page-${n}`,
        parentFrameId: 0}, {tabId: n, frameId: 5});
      const asked = Date.now();
      await bg.message({type: 'REQUEST_SOURCES'}, {tabId: n, frameId: 5});
      await bg.wait(8000);
      const sent = bg.sent('SOURCES').filter((m) => m.tabId === n && m.frameId === 5);
      expect(sent).toHaveLength(1);
      return {sources: sent[0].message.sources, waited: sourcesAt - asked};
    };
    const late = () => new Promise((resolve) => setTimeout(() => resolve(MENU), 500));

    await episode(1);
    // Its menu is found only after the player started: on the page's file, the page left as it is.
    menu = late;
    const second = await episode(2);
    expect(second.waited).toBeLessThan(50);
    expect(second.sources.map((s) => s.url)).toEqual([file('2-360p')]);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
    // Found once: the hoster's next file waits for its menu again.
    const third = await episode(3);
    expect(third.waited).toBeGreaterThanOrEqual(450);
    expect(third.sources.map((s) => s.url)).toEqual([file('1080p')]);
    expect(bg.sent('PAGE_QUALITY_PROBE')).toHaveLength(3);
  });

  it('does not take a hoster for one without a menu for a teaser beside its player', async () => {
    let sourcesAt = 0;
    const TEASER = 'https://hoster.test/v/teaser.mp4';
    // The teaser's "none" comes after the film's menu.
    const late = (answer, ms) => new Promise((resolve) => setTimeout(() => resolve(answer), ms));
    let menuFor = (message) => (message.url === TEASER ? late({none: true}, 300) : MENU);
    const answers = hosterPage({menu: (message) => menuFor(message)});
    bg = await loadBackground({
      options: {autoEnableURLs: ['https://hoster.test/']},
      tabs: [1, 2].map((id) => ({id, url: `https://hoster.test/embed/${id}/`})),
      onTabMessage: (sent) => {
        if (sent.message.type === 'SOURCES' && sent.frameId === 5) sourcesAt = Date.now();
        return answers(sent);
      },
    });
    await bg.navigated(1, 'https://hoster.test/embed/1/');
    await bg.frameAdded(1, 0, 'https://hoster.test/embed/1/', 'page-1');
    await bg.request({tabId: 1, url: TEASER, type: 'media'}, MP4);
    await bg.request({tabId: 1, url: file('360p'), type: 'media'}, MP4);
    await bg.wait(1000);
    // The next episode's menu takes 500 ms: waited for.
    menuFor = () => late(MENU, 500);
    await bg.navigated(2, 'https://hoster.test/embed/2/');
    await bg.frameAdded(2, 0, 'https://hoster.test/embed/2/', 'page-2');
    await bg.request({tabId: 2, url: file('2-360p'), type: 'media'}, MP4);
    await bg.message({type: 'PLAYER_LOADED', url: 'moz-extension://bg-test/player/index.html?opener=page-2',
      parentFrameId: 0}, {tabId: 2, frameId: 5});
    const asked = Date.now();
    await bg.message({type: 'REQUEST_SOURCES'}, {tabId: 2, frameId: 5});
    await bg.wait(8000);
    expect(sourcesAt - asked).toBeGreaterThanOrEqual(450);
  });

  it('gives the player the file the page switched to as the page\'s own once its first file is gone', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: HOSTER}], onTabMessage: hosterPage()});
    // The background's own copy of the module.
    const {startMenuChoice, withMenuQualities} = await caps();
    const frame = {isPlayer: false, frameId: 0, documentKey: 'page-1', url: HOSTER};
    const tab = {tabId: 1, getFrame: (id) => (id === 0 ? frame : null)};
    frame.tab = tab;
    const choice = startMenuChoice(frame, {url: file('360p'), mode: 'direct'}, Infinity);
    await bg.wait(100);
    expect((await choice.result)?.url).toBe(file('1080p'));
    const source = (url) => ({url, mode: 'direct', frameId: 0});
    // Beside the file it was switched from: that one's, no source of its own.
    const both = await withMenuQualities(tab, [source(file('360p')), source(file('1080p'))]);
    expect(both.map((s) => [s.url, !!s.qualities])).toEqual([[file('1080p'), true]]);
    // Alone (the list cleared, FastStream off and on again while the page played it): the page's file.
    const alone = await withMenuQualities(tab, [source(file('1080p'))]);
    expect(alone.map((s) => s.url)).toEqual([file('1080p')]);
  });

  it('starts on the page\'s file within the cap when the page never answers', async () => {
    const {MenuProbeCapMs} = await caps();
    const {sources, waited} = await playerStarts({}, {menu: new Promise(() => {})});
    expect(sources.map((s) => s.url)).toEqual([file('360p')]);
    // Without qualities: the player's own probe, once it plays, is the fallback.
    expect(sources[0].qualities).toBeUndefined();
    expect(waited).toBeLessThanOrEqual(MenuProbeCapMs);
  });

  it('switches nothing for a menu found after the player started on the page\'s file', async () => {
    const {MenuProbeCapMs} = await caps();
    const late = () => new Promise((resolve) => setTimeout(() => resolve(MENU), MenuProbeCapMs + 500));
    const {sources} = await playerStarts({}, {menu: late});
    expect(sources.map((s) => s.url)).toEqual([file('360p')]);
    expect(sources[0].qualities).toBeUndefined();
    // The player's own probe, once it plays, finds the page's menu as it was.
    expect(bg.sent('PAGE_QUALITY_PROBE').length).toBe(1);
    expect(bg.sent('PAGE_QUALITY_SELECT')).toEqual([]);
  });

  it('starts on the page\'s file, with the entries, when the switch brings no bigger file', async () => {
    const {sources} = await playerStarts({}, {select: () => switchedTo('360p-again', 640, 360)});
    expect(sources.map((s) => s.url)).toEqual([file('360p')]);
    expect(sources[0].qualities[2].url).toBeNull();
  });
});
