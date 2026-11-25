import crypto from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {MenuIds} from '../../chrome/background/ContextMenu.mjs';
import {RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// MPV mode through the background's real listeners: the stream goes as a play message the
// extension built, and MPV autoplay follows mpv over the relay, mpv's decoder too
// (backgroundMpv.test.mjs speaks to the relay in watch events, backgroundHarness's mpvEvents).

const EP1 = 'https://site.test/watch/1';
const S1 = 'https://cdn.test/one/master.m3u8';
const Thin = {hostVersion: RequiredHostVersion};
const fsId = (page) => crypto.createHash('sha256').update(page).digest('hex').slice(0, 16);

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/**
 * The helper: a play works, and mpv decodes on the graphics card.
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

describe('MPV mode with the helper', () => {
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
      onNative: thinHelper,
      // The helper connects to mpv when the test says so.
      onPortMessage: () => undefined,
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

  const Master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\n1080.m3u8\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\n720.m3u8\n';
  it.each([['a media playlist', false], ['a master playlist, from the detected master', true]])(
      'hands the stream off for the page after a navigation that asked for it while the page before still waited: %s',
      async (name, master) => {
        // Another tab's play takes 2 s, and tab 1's stream waits behind it. Tab 1 goes to the next page of the site
        // meanwhile, which finds the same stream: it got the waiting send's answer, dropped as the old page's.
        const OTHER = 'https://site.test/watch/9';
        const S9 = 'https://cdn.test/nine/master.m3u8';
        const NEXT = EP1 + '?layout=full';
        bg = await loadBackground({
          options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true},
          tabs: [{id: 1, url: EP1, title: 'Show - Episode 1'}, {id: 2, url: OTHER, title: 'Other'}],
          fetch: (url) => Promise.resolve(response(master && url === S1 ? Master : hlsPlaylist(1400))),
          thinHost: true,
          onNative: (message) => message.type === 'play' && message.target.startsWith(S9) ?
            new Promise((resolve) => setTimeout(() => resolve(thinHelper(message)), 2000)) : thinHelper(message),
        });
        await bg.navigated(2, OTHER);
        await bg.frameAdded(2, 0, OTHER, 'other');
        await bg.request({tabId: 2, url: S9});
        await bg.wait(500);
        await bg.navigated(1, EP1);
        await bg.frameAdded(1, 0, EP1, 'ep1');
        await bg.request({tabId: 1, url: S1});
        await bg.wait(500);
        await bg.navigated(1, NEXT);
        await bg.frameAdded(1, 0, NEXT, 'next');
        await bg.request({tabId: 1, url: S1});
        await bg.wait(4000);
        const plays = bg.native.filter((m) => m.type === 'play');
        // Once, as the new page's.
        const sent = plays.filter((m) => m.target.startsWith('https://cdn.test/one/'));
        expect(sent).toHaveLength(1);
        expect(new URL(sent[0].target).hash).toContain('fs-page=' + encodeURIComponent(NEXT));
        // With the master's qualities, as the first try had them.
        expect(new URL(sent[0].target).hash.includes('fs-quality=')).toBe(master);
      });

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
    // the page.
    expect(plays[0].target).toBe(`${S1}#fs-content=movie&fs-id=${fsId(EP1)}&fs-page=${encodeURIComponent(EP1)}`);
    expect(plays[0]).toMatchObject({type: 'play', headers: ['Referer: https://site.test/']});
    // The relay the watch holds open observes the decoder: no ipc question, each of which
    // was a new helper process.
    port.emit({type: 'relaying', ...Thin});
    await bg.wait(50);
    const observed = commands(port).filter((m) => m.command[0] === 'observe_property').map((m) => m.command[2]);
    expect(observed).toEqual(['path', 'eof-reached', 'pause', 'user-data/faststream/queue/count', 'hwdec-current', 'hwdec',
      'video-format', 'width', 'height']);
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
    // The window on the helper's own pipe needs no name.
    expect(port.sent[0]).not.toHaveProperty('window');
    expect(plays()[0]).not.toHaveProperty('window');
    port.emit({type: 'relaying', ...Thin});
    await bg.wait(50);
    // mpv's autoplay switch shows the setting once the watch began.
    expect(commands(port).map((m) => m.command)).toContainEqual(['set_property', 'user-data/faststream/autoplay', true]);
    // And its seconds, for mpv-config's queue to count down as long.
    expect(commands(port).map((m) => m.command)).toContainEqual(['set_property', 'user-data/faststream/countdown', 5]);
    const sent = plays().at(-1).target;
    port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path', data: sent}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: false}});
    port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: true}});
    // Where mpv stopped: at the end.
    for (const m of port.sent.filter((m) => m.type === 'mpv' && m.command[0] === 'get_property')) {
      const data = {'time-remaining': 0.04, 'duration': 1440}[m.command[1]];
      if (data !== undefined) port.emit({type: 'mpv-reply', id: m.id, error: 'success', data});
    }
    await bg.wait(1500);
    const notice = commands(port).find((m) => m.command[0] === 'script-message-to' && m.command[2] === 'show');
    expect(notice.command).toEqual(['script-message-to', 'notify', 'show', 'faststream', 'Autoplay',
      'next episode in 5 s (n: now, Space: stop)', '5']);
    expect(navigations).toEqual([]);
    await bg.wait(5000);
    expect(navigations).toEqual([{direction: 'next', frameId: 0}]);
  });

  it('stops the countdown when the user opens another file in that mpv, and the next episode does not replace it',
      async () => {
        const port = await onEpisode1();
        port.emit({type: 'relaying', ...Thin});
        await bg.wait(50);
        const sent = plays().at(-1).target;
        port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path', data: sent}});
        port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: false}});
        port.emit({type: 'mpv', data: {event: 'property-change', id: 2, name: 'eof-reached', data: true}});
        for (const m of port.sent.filter((m) => m.type === 'mpv' && m.command[0] === 'get_property')) {
          const data = {'time-remaining': 0.04, 'duration': 1440}[m.command[1]];
          if (data !== undefined) port.emit({type: 'mpv-reply', id: m.id, error: 'success', data});
        }
        await bg.wait(1500);
        expect(commands(port).some((m) => m.command[0] === 'script-message-to' && m.command[2] === 'show')).toBe(true);
        // A file dropped into the window (loadfile replace): the old path goes, the new one comes.
        port.emit({type: 'mpv', data: {event: 'end-file', reason: 'stop'}});
        port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path'}});
        port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path', data: 'C:\\Videos\\holiday.mkv'}});
        await bg.wait(5000);
        expect(navigations).toEqual([]);
        // Its notice went with it.
        expect(commands(port).map((m) => m.command)).toContainEqual(['script-message-to', 'notify', 'hide', 'faststream']);
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

describe('several mpv windows', () => {
  const WindowB = '0123456789abcdef';
  const WindowC = 'fedcba9876543210';
  const Helper = {hostVersion: RequiredHostVersion};
  const EP2 = 'https://site.test/watch/2';
  const S2 = 'https://cdn.test/two/master.m3u8';
  const OTHER1 = 'https://site.test/other/1';
  const SX1 = 'https://cdn.test/other-one/master.m3u8';
  const OTHER2 = 'https://site.test/other/2';
  const SX2 = 'https://cdn.test/other-two/master.m3u8';
  const ELSEWHERE = 'https://site.test/elsewhere/1';
  const SE1 = 'https://cdn.test/elsewhere-one/master.m3u8';
  const THIRD = 'https://site.test/third/1';
  const ST1 = 'https://cdn.test/third-one/master.m3u8';
  // Not on the MPV allowlist: the shortcut's MPV sends what the page plays.
  const PLAIN = 'https://plain.test/watch/1';
  const SP1 = 'https://cdn.test/plain-one/master.m3u8';
  let navigations;
  let inWindowB;
  let gone;
  // Whether each mpv runs mpv-config's faststream-offer.lua.
  let offers;
  // What a play does to the stand-in mpv windows.
  let onPlay;

  /**
   * The helper: a play without a window plays in the one on its own pipe, unless the test put its stream in window B
   * (as a "here" into B would); newWindow's is window C; a play into a window it no longer has answers closed.
   * @param {Object} message
   * @return {Object}
   */
  function helper(message) {
    if (message.type !== 'play') return {ok: true, ...Helper};
    // A test's own answer, or none.
    const answered = onPlay?.(message);
    if (answered) return answered;
    if (message.window && gone.has(message.window)) {
      return {ok: false, closed: true, error: 'the window was closed', ...Helper};
    }
    if (message.newWindow) return {ok: true, ...Helper, window: WindowC};
    const stream = message.target.split('#')[0];
    return {ok: true, ...Helper, window: message.window ?? (inWindowB.has(stream) ? WindowB : '')};
  }

  /**
   * The mpv behind a relay port: it plays (port.mpv says what), answers what it is asked, and passes script messages
   * back as mpv gives them to every client.
   * @param {Object} message
   * @param {Object} port
   * @return {Object|undefined}
   */
  function mpvAnswers(message, port) {
    if (message.type === 'relay') return {type: 'relaying', ...Helper};
    if (message.type !== 'mpv') return undefined;
    const [name, ...args] = message.command;
    if (name === 'get_property' && message.id !== undefined) {
      const properties = {'idle-active': false, 'eof-reached': false, 'path': 'https://cdn.test/playing.m3u8#fs-content=movie',
        'media-title': 'Show - Episode 1', ...(offers ? {'user-data/faststream/offer': 1} : {}), ...port.mpv};
      const reply = properties[args[0]] === undefined ? {type: 'mpv-reply', id: message.id, error: 'property unavailable'} :
        {type: 'mpv-reply', id: message.id, error: 'success', data: properties[args[0]]};
      // A busy mpv: its reply comes later.
      if (!port.slowMs) return reply;
      setTimeout(() => port.emit(reply), port.slowMs);
      return undefined;
    }
    if (name === 'script-message') return {type: 'mpv', data: {event: 'client-message', args}};
    return undefined;
  }

  /** An episode page loads in a tab and asks for its stream. */
  async function pageLoads(tabId, url, stream) {
    await bg.navigated(tabId, url);
    await bg.frameAdded(tabId, 0, url, `page-${url}`);
    await bg.request({tabId, url: stream});
    await bg.wait(500);
  }

  /**
   * @param {Array<string>} streamsInB
   * @param {boolean} withOffer - Whether mpv runs faststream-offer.lua.
   */
  async function load(streamsInB, withOffer) {
    navigations = [];
    inWindowB = new Set(streamsInB);
    gone = new Set();
    offers = withOffer;
    onPlay = undefined;
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/'], mpvSingleInstance: true, mpvAutoplayNext: true,
        autoplayCountdown: 5},
      tabs: [{id: 1, url: EP1, title: 'Show - Episode 1'}, {id: 2, url: OTHER1, title: 'Other - Episode 1'},
        {id: 3, url: THIRD, title: 'Third - Episode 1'}, {id: 4, url: PLAIN, title: 'Plain - Episode 1'}],
      fetch: (url) => new Promise((resolve) => setTimeout(() =>
        resolve(url.startsWith('https://cdn.test/') ? response(hlsPlaylist(1400)) : response('', 404)), 300)),
      onNative: helper,
      onPortMessage: mpvAnswers,
      onTabMessage: ({tabId, frameId, message}) => {
        if (message.type === 'GET_VIDEO_SIZE') return frameId === 0 ? 640 * 360 : 0;
        if (message.type !== 'PLAYLIST_NAVIGATION') return undefined;
        navigations.push({tabId, direction: message.direction});
        return frameId === 0 ? 'clicked' : 'no_button';
      },
    });
  }

  /**
   * Tab 1's stream plays in the window on the helper's own pipe, tab 2's in window B (an mpv setup without the offer).
   * @param {Array<string>} [streamsInB]
   * @return {Promise<{first: Object, second: Object}>} The ports of the two windows' watches.
   */
  async function twoWindows(streamsInB = [SX1]) {
    await load(streamsInB, false);
    await pageLoads(1, EP1, S1);
    await pageLoads(2, OTHER1, SX1);
    expect(bg.ports).toHaveLength(2);
    const [first, second] = bg.ports;
    return {first, second};
  }

  /** The tab's state, as the background keeps it. */
  async function tabState(tabId) {
    const {Tabs} = await import('../../chrome/background/background.mjs');
    return Tabs.getTab(tabId);
  }

  const commands = (port) => port.sent.filter((m) => m.type === 'mpv').map((m) => m.command);
  const notices = (port) => commands(port).filter((c) => c[0] === 'script-message-to' && c[2] === 'show').map((c) => c[5]);
  const plays = () => bg.native.filter((m) => m.type === 'play');
  const playOf = (stream) => plays().find((m) => m.target.startsWith(stream + '#'));
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

    // The episode's wait ended with it: another video in the tab within the minute goes as any hand-off.
    await pageLoads(2, ELSEWHERE, SE1);
    expect(playOf(SE1)).toBeDefined();
    expect(playOf(SE1)).not.toHaveProperty('window');
  });

  it('still sends the next episode to a window whose watch only ended (the helper went), which may play on', async () => {
    let {second} = await twoWindows();
    key(second, 'next');
    await bg.wait(100);
    second.emit({type: 'closed', reason: 'the mpv host went'});
    await bg.wait(100);
    await pageLoads(2, OTHER2, SX2);
    expect(playOf(SX2)).toMatchObject({window: WindowB});
    // Followed again, over a relay of its own.
    expect(bg.ports).toHaveLength(3);
    expect(bg.ports[2].sent[0]).toMatchObject({type: 'relay', window: WindowB});
    expect((await tabState(2)).mpvWindow).toBe(WindowB);
    bg.unload();

    // Gone after all: the helper says so, nothing shows, and the tab's next video is an ordinary hand-off.
    ({second} = await twoWindows());
    key(second, 'next');
    await bg.wait(100);
    second.emit({type: 'closed', reason: 'refused (the relay is busy)'});
    gone.add(WindowB);
    await bg.wait(100);
    await pageLoads(2, OTHER2, SX2);
    expect(playOf(SX2)).toMatchObject({window: WindowB});
    expect(bg.badges.get(2)).not.toBe('!');
    await pageLoads(2, ELSEWHERE, SE1);
    expect(playOf(SE1)).not.toHaveProperty('window');
  });

  it('keeps the window a tab follows when its stream is sent again (openStream\'s answer names none)', async () => {
    await twoWindows();
    const {openInMpv} = await import('../../chrome/background/MpvMode.mjs');
    const tab = await tabState(2);
    const playsBefore = plays().length;
    const result = await openInMpv(2, SX1, tab, [], undefined, OTHER1, 'Other - Episode 1', {});
    expect(result).toMatchObject({ok: true});
    expect(result).not.toHaveProperty('window');
    expect(plays()).toHaveLength(playsBefore);
    expect(tab.mpvWindow).toBe(WindowB);
    expect((await tabState(1)).mpvWindow).toBe('');
    expect(bg.ports.filter((port) => !port.disconnected)).toHaveLength(2);
  });

  it('shows no error when the helper says the episode\'s window has just closed', async () => {
    const {second} = await twoWindows();
    key(second, 'next');
    await bg.wait(100);
    gone.add(WindowB);
    const playsBefore = plays().length;
    await pageLoads(2, OTHER2, SX2);
    expect(plays()).toHaveLength(playsBefore + 1);
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

  describe('the offer (mpv-config\'s faststream-offer.lua)', () => {
    const offerCommands = (port) => commands(port).filter((c) => c[0] === 'script-message' && c[1] === 'faststream-offer');
    const choose = (port, choice, id = offerCommands(port).at(-1)[2]) =>
      port.emit({type: 'mpv', data: {event: 'client-message', args: ['faststream-choice', id, choice]}});
    const paused = (tabId) => bg.sent('PAUSE_MEDIA').filter((m) => m.tabId === tabId).length;

    /**
     * Tab 1's stream plays in window B; tab 2's page then brings a stream of its own.
     * @param {Object} [mpv] - What window B's mpv says, over its default (playing, with the offer).
     * @return {Promise<Object>} Window B's port.
     */
    async function secondStream(mpv = {}) {
      await load([S1], true);
      await pageLoads(1, EP1, S1);
      expect(bg.ports).toHaveLength(1);
      const port = bg.ports[0];
      port.mpv = mpv;
      await pageLoads(2, OTHER1, SX1);
      return port;
    }

    it('asks a window that plays, raises it and pauses the page; "here" plays the stream there', async () => {
      const port = await secondStream();
      expect(offerCommands(port)).toEqual([['script-message', 'faststream-offer', expect.stringMatching(/^[0-9a-f]{8}-\d+$/),
        '15', 'Play here', 'Other - Episode 1, in place of Show - Episode 1', 'Play in a new window',
        'it waits there paused; Show - Episode 1 plays on']]);
      expect(bg.native.filter((m) => m.type === 'raise')).toEqual([{type: 'raise', window: WindowB}]);
      expect(paused(2)).toBe(1);
      expect(playOf(SX1)).toBeUndefined();
      // FastStream's own offer comes back from mpv as every script message does: not an answer.
      await bg.wait(100);
      expect(playOf(SX1)).toBeUndefined();

      choose(port, 'here');
      await bg.wait(100);
      expect(playOf(SX1)).toMatchObject({window: WindowB});
      expect(playOf(SX1)).not.toHaveProperty('newWindow');
      expect((await tabState(2)).mpvWindow).toBe(WindowB);
      expect((await tabState(1)).mpvWindow).toBe(null);
      expect(bg.ports).toHaveLength(1);
    });

    it('changes nothing for a second, late or unknown answer', async () => {
      const port = await secondStream();
      const id = offerCommands(port)[0][2];
      choose(port, 'other-1', 'here');
      choose(port, 'here', 'other-1');
      await bg.wait(100);
      expect(plays()).toHaveLength(1);
      choose(port, 'here', id);
      await bg.wait(100);
      expect(plays()).toHaveLength(2);
      for (const choice of ['here', 'window', 'none']) choose(port, choice, id);
      await bg.wait(18000);
      expect(plays()).toHaveLength(2);
      expect(bg.ports).toHaveLength(1);
      expect(bg.badges.get(2)).not.toBe('!');
      expect((await tabState(2)).mpvError).toBeFalsy();
    });

    it('plays there when mpv-config answers "here" itself, as what played reached its end', async () => {
      const port = await secondStream();
      // What mpv-config does then: the end, and the answer for the banners still up.
      ends(port, playOf(S1).target);
      choose(port, 'here');
      await bg.wait(100);
      expect(playOf(SX1)).toMatchObject({window: WindowB});
      expect((await tabState(2)).mpvWindow).toBe(WindowB);
      // Tab 1's countdown for that end stopped: the window plays tab 2's stream now.
      await bg.wait(6000);
      expect(navigations).toEqual([]);
    });

    it('does not ask again for the same video while mpv asks, nor right after it was declined', async () => {
      const port = await secondStream();
      choose(port, 'none');
      await bg.wait(100);
      await bg.navigated(4, PLAIN);
      await bg.frameAdded(4, 0, PLAIN, 'plain');
      await bg.command('toggle_mpv', 4);
      const play = () => bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://plain.test/1',
        video: {src: 'blob:https://plain.test/1', duration: 1400}}, {tabId: 4, frameId: 0});
      await play();
      await bg.request({tabId: 4, url: SP1});
      await bg.wait(1000);
      expect(offerCommands(port)).toHaveLength(2);
      // Past MpvPlayRepeatMs from the send, the question still up.
      await bg.wait(11000);
      await play();
      await bg.wait(1000);
      expect(offerCommands(port)).toHaveLength(2);
      // No answer: declined at 17 s; the page player plays once more a few seconds on.
      await bg.wait(5000);
      await play();
      await bg.wait(1000);
      expect(offerCommands(port)).toHaveLength(2);
      expect(plays()).toHaveLength(1);
    });

    it('"new window" starts one that waits paused, which the tab follows; the window before plays on', async () => {
      const port = await secondStream();
      choose(port, 'window');
      await bg.wait(100);
      expect(playOf(SX1)).toMatchObject({newWindow: true, paused: true});
      expect(playOf(SX1)).not.toHaveProperty('window');
      expect(bg.ports).toHaveLength(2);
      expect(bg.ports[1].sent[0]).toMatchObject({type: 'relay', window: WindowC});
      expect((await tabState(2)).mpvWindow).toBe(WindowC);
      expect((await tabState(1)).mpvWindow).toBe(WindowB);
      expect(port.disconnected).toBe(false);

      // Tab 1's next stream asks its own window, not the newest.
      await pageLoads(1, EP2, S2);
      expect(offerCommands(port)).toHaveLength(2);
      expect(offerCommands(bg.ports[1])).toEqual([]);
      choose(port, 'here');
      await bg.wait(100);
      expect(playOf(S2)).toMatchObject({window: WindowB});
      // A link, which no tab follows, asks the window that got the last stream.
      await bg.menuClick(MenuIds.LINK_MPV, 2, {linkUrl: 'https://www.youtube.com/watch?v=abcdefghijk'});
      await bg.wait(500);
      expect(offerCommands(port)).toHaveLength(3);
      expect(offerCommands(bg.ports[1])).toEqual([]);
    });

    it('sends nothing when declined or not answered: the page stays paused, with no error, and is not asked again', async () => {
      let port = await secondStream();
      choose(port, 'none');
      await bg.wait(100);
      expect(playOf(SX1)).toBeUndefined();
      expect(paused(2)).toBe(1);
      expect(bg.badges.get(2)).not.toBe('!');
      expect((await tabState(2)).mpvError).toBeFalsy();
      // The page's next stream is not handed off by itself either (the allowlist's once per page).
      await bg.request({tabId: 2, url: SX2});
      await bg.wait(1000);
      expect(offerCommands(port)).toHaveLength(1);
      expect(plays()).toHaveLength(1);
      bg.unload();

      port = await secondStream();
      await bg.wait(16000);
      expect(commands(port).filter((c) => c[1] === 'faststream-offer-cancel')).toEqual([]);
      await bg.wait(1000);
      const id = offerCommands(port)[0][2];
      expect(commands(port).filter((c) => c[1] === 'faststream-offer-cancel')).toEqual([['script-message',
        'faststream-offer-cancel', id]]);
      // An answer after the wait counts no more.
      choose(port, 'here', id);
      await bg.wait(100);
      expect(playOf(SX1)).toBeUndefined();
      expect(bg.badges.get(2)).not.toBe('!');
    });

    it('plays at once, with no question, in a window that is idle or at its end, plays this stream, or has no offer', async () => {
      for (const mpv of [{'idle-active': true}, {'eof-reached': true}, {'path': undefined},
        {'path': `${SX1}#fs-content=movie`}, {'user-data/faststream/offer': undefined}]) {
        const port = await secondStream(mpv);
        expect(offerCommands(port)).toEqual([]);
        expect(bg.native.filter((m) => m.type === 'raise')).toEqual([]);
        expect(playOf(SX1)).toMatchObject({window: WindowB});
        bg.unload();
      }
    });

    it('never asks for MPV autoplay\'s next episode: it goes to its window', async () => {
      const port = await secondStream();
      choose(port, 'none');
      await bg.wait(100);
      key(port, 'next');
      await bg.wait(100);
      expect(navigations).toEqual([{tabId: 1, direction: 'next'}]);
      await pageLoads(1, EP2, S2);
      expect(offerCommands(port)).toHaveLength(1);
      expect(playOf(S2)).toMatchObject({window: WindowB});
    });

    it('answers an offer a newer stream replaced with none, and ignores a choice for it', async () => {
      const port = await secondStream();
      const first = offerCommands(port)[0][2];
      await pageLoads(3, THIRD, ST1);
      expect(offerCommands(port)).toHaveLength(2);
      const second = offerCommands(port)[1][2];
      expect(second).not.toBe(first);
      choose(port, 'here', first);
      await bg.wait(100);
      expect(plays()).toHaveLength(1);
      choose(port, 'here', second);
      await bg.wait(100);
      expect(playOf(ST1)).toMatchObject({window: WindowB});
      expect(playOf(SX1)).toBeUndefined();
    });

    it('sends nothing when the window closes while it asks, and a fresh window when it went after "here"', async () => {
      let port = await secondStream();
      // The player's button in tab 3: its offer replaces tab 2's.
      let answer;
      bg.message({type: 'MPV_OPEN', url: ST1, headers: []}, {tabId: 3, onAnswer: (value) => {
        answer = value;
      }});
      await bg.wait(500);
      expect(offerCommands(port)).toHaveLength(2);
      port.emit({type: 'closed', reason: 'mpv closed'});
      await bg.wait(100);
      expect(answer).toEqual({ok: false, declined: true});
      expect(plays()).toHaveLength(1);
      expect(bg.badges.get(2)).not.toBe('!');
      bg.unload();

      port = await secondStream();
      gone.add(WindowB);
      choose(port, 'here');
      await bg.wait(100);
      expect(plays().slice(1).map(({window, newWindow, paused}) => ({window, newWindow, paused}))).toEqual([
        {window: WindowB, newWindow: undefined, paused: undefined},
        {window: undefined, newWindow: true, paused: undefined}]);
      expect((await tabState(2)).mpvWindow).toBe(WindowC);
      expect(bg.badges.get(2)).not.toBe('!');
    });

    it('shows no offer for a page gone while the window was asked what it plays', async () => {
      await load([S1], true);
      await pageLoads(1, EP1, S1);
      const port = bg.ports[0];
      port.slowMs = 1500;
      await pageLoads(2, OTHER1, SX1);
      await bg.navigated(2, 'https://elsewhere.test/');
      await bg.wait(2000);
      expect(offerCommands(port)).toEqual([]);
      expect(bg.native.filter((m) => m.type === 'raise')).toEqual([]);
      expect(playOf(SX1)).toBeUndefined();
    });

    it('sends nothing for a page gone while an idle or silent window was asked', async () => {
      // Idle: the answer in 1.5 s; silent: none within the 2 s.
      for (const [mpv, slowMs] of [[{'idle-active': true}, 1500], [{}, 3000]]) {
        await load([S1], true);
        await pageLoads(1, EP1, S1);
        const port = bg.ports[0];
        port.mpv = mpv;
        port.slowMs = slowMs;
        await pageLoads(2, OTHER1, SX1);
        await bg.navigated(2, 'https://elsewhere.test/');
        await bg.wait(3500);
        expect(offerCommands(port)).toEqual([]);
        expect(playOf(SX1)).toBeUndefined();
        bg.unload();
      }
    });

    it('asks a window about one stream at a time: of two at once, the second finds the first there', async () => {
      await load([S1], true);
      await pageLoads(1, EP1, S1);
      const port = bg.ports[0];
      port.mpv = {'idle-active': true};
      // Both questions under way at once.
      port.slowMs = 500;
      // The window plays what it got.
      onPlay = (message) => {
        if (message.window === WindowB) port.mpv = {};
      };
      for (const [tabId, url] of [[2, OTHER1], [3, THIRD]]) {
        await bg.navigated(tabId, url);
        await bg.frameAdded(tabId, 0, url, `page-${url}`);
      }
      await bg.request({tabId: 2, url: SX1});
      await bg.request({tabId: 3, url: ST1});
      await bg.wait(3000);
      expect(plays().slice(1).map((m) => m.window)).toEqual([WindowB]);
      expect(offerCommands(port)).toHaveLength(1);
    });

    it('places the next stream afresh when the window it waited for closed', async () => {
      await load([S1], true);
      await pageLoads(1, EP1, S1);
      const port = bg.ports[0];
      port.mpv = {'idle-active': true};
      // Tab 2's play into B takes a while, and B's mpv quits meanwhile: it goes to a fresh window (C).
      onPlay = (message) => message.window === WindowB ? new Promise((resolve) => setTimeout(() =>
        resolve({ok: false, closed: true, error: 'the window was closed', ...Helper}), 2000)) : undefined;
      for (const [tabId, url] of [[2, OTHER1], [3, THIRD]]) {
        await bg.navigated(tabId, url);
        await bg.frameAdded(tabId, 0, url, `page-${url}`);
      }
      await bg.request({tabId: 2, url: SX1});
      await bg.request({tabId: 3, url: ST1});
      await bg.wait(1000);
      port.emit({type: 'closed', reason: 'mpv closed'});
      await bg.wait(2000);
      expect(plays().slice(1).map(({target, window, newWindow}) => [target.split('#')[0], window, newWindow])).toEqual([
        [SX1, WindowB, undefined], [SX1, undefined, true]]);
      // Tab 3 asks the window that is there now.
      expect(offerCommands(bg.ports[1])).toHaveLength(1);
    });

    it('sends nothing for a stream queued behind another once MPV was turned off and the window closed', async () => {
      await load([S1], true);
      await pageLoads(1, EP1, S1);
      const port = bg.ports[0];
      port.mpv = {'idle-active': true};
      port.slowMs = 1500;
      for (const [tabId, url] of [[2, OTHER1], [3, THIRD]]) {
        await bg.navigated(tabId, url);
        await bg.frameAdded(tabId, 0, url, `page-${url}`);
      }
      // Tab 2's stream asks the window, tab 3's waits behind it.
      await bg.request({tabId: 2, url: SX1});
      await bg.request({tabId: 3, url: ST1});
      await bg.wait(1000);
      bg.options = {...bg.options, mpvMode: false};
      await bg.message({type: 'LOAD_OPTIONS'});
      port.emit({type: 'closed', reason: 'mpv closed'});
      await bg.wait(3000);
      expect(plays()).toHaveLength(1);
      expect(playOf(SX1)).toBeUndefined();
      expect(playOf(ST1)).toBeUndefined();
    });

    it('holds no other window\'s question for one up in a window', async () => {
      const port = await secondStream();
      choose(port, 'window');
      await bg.wait(100);
      const windowC = bg.ports[1];
      // Tab 1's stream asks its window B; tab 2's, meanwhile, its window C.
      await pageLoads(1, EP2, S2);
      expect(offerCommands(port)).toHaveLength(2);
      await pageLoads(2, OTHER2, SX2);
      expect(offerCommands(windowC)).toHaveLength(1);
      // Both still up.
      choose(windowC, 'here');
      choose(port, 'here');
      await bg.wait(100);
      expect(playOf(SX2)).toMatchObject({window: WindowC});
      expect(playOf(S2)).toMatchObject({window: WindowB});
    });

    it('sends nothing once the page went while mpv asked', async () => {
      const port = await secondStream();
      await bg.navigated(2, 'https://elsewhere.test/');
      choose(port, 'here');
      await bg.wait(100);
      expect(playOf(SX1)).toBeUndefined();
    });

    it('asks for the player\'s button and a YouTube link too, which say "declined" without an error', async () => {
      const port = await secondStream();
      choose(port, 'none');
      await bg.wait(100);
      expect(bg.sent('MPV_ASKING')).toEqual([]);
      let answer;
      bg.message({type: 'MPV_OPEN', url: SX2, headers: []}, {tabId: 2, frameId: 5, onAnswer: (value) => {
        answer = value;
      }});
      await bg.wait(500);
      expect(offerCommands(port)).toHaveLength(2);
      // The player that sent it pauses at once, as the page did: pauseTabMedia does not reach it.
      expect(bg.sent('MPV_ASKING').map(({tabId, frameId}) => ({tabId, frameId}))).toEqual([{tabId: 2, frameId: 5}]);
      choose(port, 'none');
      await bg.wait(100);
      expect(answer).toEqual({ok: false, declined: true});

      await bg.menuClick(MenuIds.LINK_MPV, 2, {linkUrl: 'https://www.youtube.com/watch?v=abcdefghijk'});
      await bg.wait(500);
      expect(offerCommands(port)).toHaveLength(3);
      choose(port, 'none');
      await bg.wait(100);
      expect(plays()).toHaveLength(1);
      expect((await tabState(2)).mpvError).toBeFalsy();
      expect(bg.badges.get(2)).not.toBe('!');
    });

    it('does not ask again for a page player\'s own repeated play once declined', async () => {
      const port = await secondStream();
      choose(port, 'none');
      await bg.wait(100);
      await bg.navigated(4, PLAIN);
      await bg.frameAdded(4, 0, PLAIN, 'plain');
      await bg.command('toggle_mpv', 4);
      const play = () => bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://plain.test/1',
        video: {src: 'blob:https://plain.test/1', duration: 1400}}, {tabId: 4, frameId: 0});
      await play();
      await bg.request({tabId: 4, url: SP1});
      await bg.wait(1000);
      expect(offerCommands(port)).toHaveLength(2);
      choose(port, 'none');
      await bg.wait(100);
      expect(plays()).toHaveLength(1);
      expect(bg.badges.get(4)).not.toBe('!');
      expect((await tabState(4)).mpvError).toBeFalsy();
      await play();
      await bg.wait(1000);
      expect(offerCommands(port)).toHaveLength(2);
      expect(plays()).toHaveLength(1);
    });

    describe('"Add to queue" (mpv-config\'s queue)', () => {
      const QueueCount = 'user-data/faststream/queue/count';
      const queued = (port, count) => port.emit({type: 'mpv', data: {event: 'property-change', id: 4, name: QueueCount,
        data: count}});
      const playing = (port, target) => port.emit({type: 'mpv', data: {event: 'property-change', id: 1, name: 'path',
        data: target}});
      const countdowns = (port) => notices(port).filter((text) => text.startsWith('next episode in'));

      it('is offered only where mpv has the queue, saying what it waits behind', async () => {
        let port = await secondStream({[QueueCount]: 0});
        expect(offerCommands(port)[0].slice(4)).toEqual(['Play here', 'Other - Episode 1, in place of Show - Episode 1',
          'Play in a new window', 'it waits there paused; Show - Episode 1 plays on', 'Add to queue',
          'plays after Show - Episode 1']);
        bg.unload();
        port = await secondStream({[QueueCount]: 2});
        expect(offerCommands(port)[0].slice(8)).toEqual(['Add to queue', 'plays after the 2 in the queue']);
        bg.unload();
        // No queue there (an older mpv-config): two banners, and a queue answer is none.
        port = await secondStream();
        expect(offerCommands(port)[0]).toHaveLength(8);
        choose(port, 'queue');
        await bg.wait(100);
        expect(playOf(SX1)).toBeUndefined();
        expect(bg.badges.get(2)).not.toBe('!');
      });

      it('queues the stream behind what plays: no autoplay while it waits, its tab followed once it plays, then autoplay',
          async () => {
            const port = await secondStream({[QueueCount]: 0});
            choose(port, 'queue');
            await bg.wait(100);
            expect(playOf(SX1)).toMatchObject({window: WindowB, queue: true});
            expect(playOf(SX1)).not.toHaveProperty('newWindow');
            expect(playOf(SX1)).not.toHaveProperty('fullscreen');
            // Tab 1's stream plays on in the window, which still follows it.
            expect((await tabState(1)).mpvWindow).toBe(WindowB);
            expect((await tabState(2)).mpvWindow).not.toBe(WindowB);
            expect(bg.ports).toHaveLength(1);
            queued(port, 1);

            // Its end: the queue goes first (its own countdown, in mpv); autoplay's next episode is not asked.
            ends(port, playOf(S1).target);
            await bg.wait(7000);
            expect(countdowns(port)).toEqual([]);
            expect(navigations).toEqual([]);

            // mpv plays the queued stream: the window is tab 2's now.
            queued(port, 0);
            playing(port, playOf(SX1).target);
            await bg.wait(100);
            expect((await tabState(2)).mpvWindow).toBe(WindowB);
            expect((await tabState(1)).mpvWindow).toBe(null);
            // The queue's last one's end: autoplay goes on in its tab, as for any stream.
            ends(port, playOf(SX1).target);
            await bg.wait(1500);
            expect(countdowns(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
            await bg.wait(5000);
            expect(navigations).toEqual([{tabId: 2, direction: 'next'}]);
          });

      it('counts down again once the queue was emptied in mpv before the end', async () => {
        const port = await secondStream({[QueueCount]: 0});
        choose(port, 'queue');
        await bg.wait(100);
        queued(port, 1);
        // The user took it out of the queue (its x, or Clear): tab 1's episode goes on.
        queued(port, 0);
        ends(port, playOf(S1).target);
        await bg.wait(1500);
        expect(countdowns(port)).toEqual(['next episode in 5 s (n: now, Space: stop)']);
        await bg.wait(5000);
        expect(navigations).toEqual([{tabId: 1, direction: 'next'}]);
      });

      it('plays a queued stream whose tab closed meanwhile without a page: its end says the episode is unavailable',
          async () => {
            const port = await secondStream({[QueueCount]: 0});
            choose(port, 'queue');
            await bg.wait(100);
            queued(port, 1);
            await bg.closed(2);
            queued(port, 0);
            playing(port, playOf(SX1).target);
            await bg.wait(100);
            // Tab 1 no longer follows a window that plays another page's stream.
            expect((await tabState(1)).mpvWindow).toBe(null);
            ends(port, playOf(SX1).target);
            await bg.wait(6500);
            expect(notices(port)).toContain('its tab is closed, or not in MPV mode');
            expect(navigations).toEqual([]);
          });
    });
  });
});
