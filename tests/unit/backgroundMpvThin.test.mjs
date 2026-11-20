import crypto from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// MPV mode with the thin helper, through the background's real
// listeners: the stream goes as a play message the extension built, mpv's decoder is asked
// over ipc, and MPV autoplay follows mpv over the relay, with background.mjs as it was for the
// helper that did all of it itself (backgroundMpv.test.mjs runs the same against a helper
// before host 15).

const EP1 = 'https://site.test/watch/1';
const S1 = 'https://cdn.test/one/master.m3u8';
const Thin = {hostVersion: RequiredHostVersion, capabilities: ['play', 'ipc', 'relay']};
const fsId = (page) => crypto.createHash('sha256').update(page).digest('hex').slice(0, 16);

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/**
 * The thin helper: a play works, and mpv decodes on the graphics card.
 * @param {Object} message
 * @return {Object}
 */
function thinHelper(message) {
  if (message.type === 'ipc') {
    return {ok: true, ...Thin, replies: [{error: 'success', data: 'd3d11va'}, {error: 'success', data: 'auto-safe'},
      {error: 'success', data: 'av1'}, {error: 'success', data: 1920}, {error: 'success', data: 1080}]};
  }
  return {ok: true, ...Thin};
}

describe('MPV mode with the thin helper', () => {
  let navigations;

  /**
   * Episode 1 handed to mpv by the MPV allowlist, and the port the watch opened.
   * @param {Object} [options] - More options.
   * @param {Object} [tab] - More of the tab's fields (incognito).
   * @return {Promise<Object>} The port (backgroundHarness: sent, emit, drop).
   */
  async function onEpisode1(options = {}, tab = {}) {
    navigations = [];
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true, mpvAutoplayNext: true,
        autoplayCountdown: 5, ...options},
      tabs: [{id: 1, url: EP1, title: 'Show - Episode 1', ...tab}],
      fetch: (url) => new Promise((resolve) => setTimeout(() => resolve(url === S1 ? response(hlsPlaylist(1400)) : response('', 404)), 300)),
      thinHost: true,
      onNative: thinHelper,
      onTabMessage: ({frameId, message}) => {
        if (message.type === 'GET_VIDEO_SIZE') return frameId === 0 ? 640 * 360 : 0;
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push({direction: message.direction, frameId});
        return frameId === 0 ? 'clicked' : 'no_button';
      },
    });
    await bg.navigated(1, EP1);
    await bg.frameAdded(1, 0, EP1, 'ep1');
    await bg.request({tabId: 1, url: S1});
    await bg.wait(500);
    return bg.ports.at(-1);
  }

  // The owner's pick: mpv keeps no resume position for a private window's
  // stream (stream-resume.lua reads fs-private). The resume key stays: mpv's episode buttons
  // know a FastStream stream by it.
  it('marks a private window\'s stream fs-private, and only that', async () => {
    await onEpisode1({}, {incognito: true});
    const plays = bg.native.filter((m) => m.type === 'play');
    expect(plays).toHaveLength(1);
    expect(plays[0].target).toBe(`${S1}#fs-content=movie&fs-id=${fsId(EP1)}&fs-private=1&fs-page=${encodeURIComponent(EP1)}`);
    bg.unload();

    await onEpisode1({}, {incognito: false});
    expect(bg.native.filter((m) => m.type === 'play')[0].target).not.toContain('fs-private');
  });

  /** The mpv commands the background sent through the relay. */
  const commands = (port) => port.sent.filter((m) => m.type === 'mpv');

  it('sends the stream as a play message it built, and shows mpv\'s decoder, observed over the relay', async () => {
    const port = await onEpisode1();
    const plays = bg.native.filter((m) => m.type === 'play');
    expect(plays).toHaveLength(1);
    // The allowlist's content type (Movie unless the site is tagged @anime), the resume key and
    // the page, as the helper tagged them until host 14.
    expect(plays[0].target).toBe(`${S1}#fs-content=movie&fs-id=${fsId(EP1)}&fs-page=${encodeURIComponent(EP1)}`);
    expect(plays[0]).toMatchObject({type: 'play', headers: ['Referer: https://site.test/']});
    expect(bg.native.filter((m) => m.type === 'open' || m.type === 'status')).toEqual([]);
    // The relay the watch holds open observes the decoder: no ipc question, each of which
    // was a new helper process.
    port.emit({type: 'relaying', ...Thin});
    await bg.wait(50);
    const observed = commands(port).filter((m) => m.command[0] === 'observe_property').map((m) => m.command[2]);
    expect(observed).toEqual(['path', 'eof-reached', 'pause', 'hwdec-current', 'hwdec', 'video-format', 'width', 'height']);
    // mpv opening the stream: no decoder yet, then one, its format and size as they come.
    const decoder = (id, name, data) => port.emit({type: 'mpv', data: {event: 'property-change', id, name, data}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 10, name: 'hwdec-current'}});
    decoder(10, 'hwdec-current', 'd3d11va');
    decoder(11, 'hwdec', 'auto-safe');
    decoder(12, 'video-format', 'av1');
    decoder(13, 'width', 1920);
    decoder(14, 'height', 1080);
    await bg.wait(25000);
    expect(bg.native.filter((m) => m.type === 'ipc')).toEqual([]);
    expect(bg.badges.get(1)).toBe('');
    expect(bg.titles.get(1)).toBe('FastStream - Playing in MPV - decoded by the graphics card: d3d11va, AV1 1920x1080');
  });

  it('follows mpv over the relay: the end of the episode counts down to the next one', async () => {
    const port = await onEpisode1();
    expect(port.sent[0]).toMatchObject({type: 'relay', heartbeat: {property: 'user-data/faststream/heartbeat', everyMs: 30000}});
    // A helper before 30 is told no window.
    expect(port.sent[0]).not.toHaveProperty('window');
    expect(plays()[0]).not.toHaveProperty('window');
    port.emit({type: 'relaying', ...Thin});
    await bg.wait(50);
    // mpv's autoplay switch shows the setting once the watch began.
    expect(commands(port).map((m) => m.command)).toContainEqual(['set_property', 'user-data/faststream/autoplay', true]);
    const sent = plays().at(-1).target;
    port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path', data: sent}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: false}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: true}});
    await bg.wait(1500);
    const notice = commands(port).find((m) => m.command[0] === 'script-message-to' && m.command[2] === 'show');
    expect(notice.command).toEqual(['script-message-to', 'notify', 'show', 'faststream', 'Autoplay',
      'next episode in 5 s (n: now, Space: stop)', '5']);
    expect(navigations).toEqual([]);
    await bg.wait(5000);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  it('goes to the next episode on mpv\'s key, at once', async () => {
    const port = await onEpisode1();
    port.emit({type: 'relaying', ...Thin});
    port.emit({type: 'mpv', data: {event: 'client-message', args: ['faststream-next']}});
    await bg.wait(100);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  /** The play messages sent. */
  const plays = () => bg.native.filter((m) => m.type === 'play');
});

describe('several mpv windows (helper 30)', () => {
  const WindowB = '0123456789abcdef';
  const Helper30 = {hostVersion: 30, capabilities: ['play', 'ipc', 'relay', 'windows']};
  const EP2 = 'https://site.test/watch/2';
  const S2 = 'https://cdn.test/two/master.m3u8';
  const OTHER1 = 'https://site.test/other/1';
  const SX1 = 'https://cdn.test/other-one/master.m3u8';
  const OTHER2 = 'https://site.test/other/2';
  const SX2 = 'https://cdn.test/other-two/master.m3u8';
  let navigations;
  let inWindowB;
  let gone;

  /**
   * Helper 30: a play without a window plays in the one on its own pipe, unless the test put its stream in window B
   * (what PR D's "new window" answer gives); a play into a window it no longer has answers closed.
   * @param {Object} message
   * @return {Object}
   */
  function helper30(message) {
    if (message.type !== 'play') return {ok: true, ...Helper30};
    if (message.window && gone.has(message.window)) {
      return {ok: false, closed: true, error: 'the window was closed', ...Helper30};
    }
    const stream = message.target.split('#')[0];
    return {ok: true, ...Helper30, window: message.window ?? (inWindowB.has(stream) ? WindowB : '')};
  }

  /** An episode page loads in a tab and asks for its stream. */
  async function pageLoads(tabId, url, stream) {
    await bg.navigated(tabId, url);
    await bg.frameAdded(tabId, 0, url, `page-${url}`);
    await bg.request({tabId, url: stream});
    await bg.wait(500);
  }

  /**
   * Tab 1's stream plays in the window on the helper's own pipe, tab 2's in window B.
   * @param {Array<string>} [streamsInB]
   * @return {Promise<{first: Object, second: Object}>} The ports of the two windows' watches.
   */
  async function twoWindows(streamsInB = [SX1]) {
    navigations = [];
    inWindowB = new Set(streamsInB);
    gone = new Set();
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true, mpvAutoplayNext: true,
        autoplayCountdown: 5},
      tabs: [{id: 1, url: EP1, title: 'Show - Episode 1'}, {id: 2, url: OTHER1, title: 'Other - Episode 1'}],
      fetch: (url) => new Promise((resolve) => setTimeout(() =>
        resolve(url.startsWith('https://cdn.test/') ? response(hlsPlaylist(1400)) : response('', 404)), 300)),
      thinHost: true,
      onNative: helper30,
      onTabMessage: ({tabId, frameId, message}) => {
        if (message.type === 'GET_VIDEO_SIZE') return frameId === 0 ? 640 * 360 : 0;
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push({tabId, direction: message.direction});
        return frameId === 0 ? 'clicked' : 'no_button';
      },
    });
    await pageLoads(1, EP1, S1);
    await pageLoads(2, OTHER1, SX1);
    expect(bg.ports).toHaveLength(2);
    const [first, second] = bg.ports;
    first.emit({type: 'relaying', ...Helper30});
    second.emit({type: 'relaying', ...Helper30});
    await bg.wait(50);
    return {first, second};
  }

  /** The tab's state, as the background keeps it. */
  async function tabState(tabId) {
    const {Tabs} = await import('../../chrome/background/background.mjs');
    return Tabs.getTab(tabId);
  }

  const commands = (port) => port.sent.filter((m) => m.type === 'mpv').map((m) => m.command);
  const notices = (port) => commands(port).filter((c) => c[0] === 'script-message-to' && c[2] === 'show').map((c) => c[5]);
  const playOf = (stream) => bg.native.find((m) => m.type === 'play' && m.target.startsWith(stream + '#'));
  const key = (port, name) => port.emit({type: 'mpv', data: {event: 'client-message', args: [`faststream-${name}`]}});
  const ends = (port, target) => {
    for (const [name, data] of [['path', target], ['eof-reached', false], ['eof-reached', true]]) {
      port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name, data}});
    }
  };

  it('follows each window by itself: its end counts down in it and goes on in its own tab', async () => {
    const {first, second} = await twoWindows();
    expect(first.sent[0].type).toBe('relay');
    expect(first.sent[0]).not.toHaveProperty('window');
    expect(second.sent[0]).toMatchObject({type: 'relay', window: WindowB});
    expect((await tabState(1)).mpvWindow).toBe('');
    expect((await tabState(2)).mpvWindow).toBe(WindowB);

    ends(second, playOf(SX1).target);
    await bg.wait(1500);
    expect(notices(second)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
    expect(notices(first)).toEqual([]);
    await bg.wait(5000);
    expect(navigations).toEqual([{tabId: 2, direction: 'next'}]);

    key(first, 'next');
    await bg.wait(100);
    expect(navigations).toEqual([{tabId: 2, direction: 'next'}, {tabId: 1, direction: 'next'}]);
  });

  it('sends the next episode to the window it came from, and to the one on the helper\'s own pipe without a window', async () => {
    const {first, second} = await twoWindows();
    key(second, 'next');
    key(first, 'next');
    await bg.wait(100);
    await pageLoads(2, OTHER2, SX2);
    await pageLoads(1, EP2, S2);
    expect(playOf(SX2)).toMatchObject({window: WindowB});
    expect(playOf(S2)).not.toHaveProperty('window');
    // Each window's watch goes on with its tab's episode.
    expect(bg.ports).toHaveLength(2);
    ends(second, playOf(SX2).target);
    await bg.wait(1500);
    expect(notices(second).at(-1)).toBe('next episode in 5 s (n: now, Space: stop)');
    expect(notices(first).at(-1)).toBe('loading in mpv');
  });

  it('sends no next episode for a window closed meanwhile, and the other window plays on', async () => {
    const {first, second} = await twoWindows();
    key(second, 'next');
    await bg.wait(100);
    second.emit({type: 'closed', reason: 'mpv closed'});
    await bg.wait(100);
    expect((await tabState(2)).mpvWindow).toBe(null);
    await pageLoads(2, OTHER2, SX2);
    expect(playOf(SX2)).toBeUndefined();
    expect(bg.badges.get(2)).not.toBe('!');

    key(first, 'next');
    await bg.wait(100);
    expect(navigations.at(-1)).toEqual({tabId: 1, direction: 'next'});
  });

  it('shows no error when the helper says the episode\'s window has just closed', async () => {
    const {second} = await twoWindows();
    key(second, 'next');
    await bg.wait(100);
    gone.add(WindowB);
    const playsBefore = bg.native.filter((m) => m.type === 'play').length;
    await pageLoads(2, OTHER2, SX2);
    expect(bg.native.filter((m) => m.type === 'play')).toHaveLength(playsBefore + 1);
    expect(playOf(SX2)).toMatchObject({window: WindowB});
    expect((await tabState(2)).mpvError).toBeFalsy();
    expect(bg.badges.get(2)).not.toBe('!');
  });

  it('still sends the next episode of the window on the helper\'s own pipe once it closed, as before', async () => {
    const {first} = await twoWindows();
    key(first, 'next');
    await bg.wait(100);
    first.emit({type: 'closed', reason: 'mpv closed'});
    await bg.wait(100);
    await pageLoads(1, EP2, S2);
    expect(playOf(S2)).toBeDefined();
    expect(playOf(S2)).not.toHaveProperty('window');
  });

  it('shows the autoplay setting in every window, changed in the options or by a window\'s key', async () => {
    const {first, second} = await twoWindows();
    const switches = (port) => commands(port).filter((c) => c[0] === 'set_property' && c[1] === 'user-data/faststream/autoplay')
        .map((c) => c[2]);
    key(second, 'autoplay');
    await bg.wait(100);
    expect(switches(first).at(-1)).toBe(false);
    expect(switches(second).at(-1)).toBe(false);
    bg.options = {...bg.options, mpvAutoplayNext: true};
    await bg.message({type: 'LOAD_OPTIONS'});
    await bg.wait(100);
    expect(switches(first).at(-1)).toBe(true);
    expect(switches(second).at(-1)).toBe(true);
  });

  it('lets the window before go once the tab\'s stream went to another: its end and keys say the episode is unavailable', async () => {
    const {first, second} = await twoWindows([SX1, S2]);
    // Tab 1's next page plays in window B; the window on the helper's own pipe plays on.
    await pageLoads(1, EP2, S2);
    expect((await tabState(1)).mpvWindow).toBe(WindowB);
    expect((await tabState(2)).mpvWindow).toBe(null);
    ends(first, playOf(S1).target);
    await bg.wait(100);
    expect(notices(first)).toEqual(['its tab is closed, or not in MPV mode']);
    key(first, 'next');
    await bg.wait(100);
    expect(notices(first)).toEqual(['its tab is closed, or not in MPV mode', 'its tab is closed, or not in MPV mode']);
    expect(navigations).toEqual([]);

    key(second, 'next');
    await bg.wait(100);
    expect(navigations).toEqual([{tabId: 1, direction: 'next'}]);
  });
});
