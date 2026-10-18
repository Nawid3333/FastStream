import crypto from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// MPV mode with the thin helper (host 15, 2026-10-13), through the background's real
// listeners: the stream goes as a play message the extension built, mpv's decoder is asked
// over ipc, and MPV autoplay follows mpv over the relay, with background.mjs as it was for the
// helper that did all of it itself (backgroundMpv.test.mjs runs the same against a helper
// before host 15).

const EP1 = 'https://site.test/watch/1';
const S1 = 'https://cdn.test/one/master.m3u8';
const Thin = {hostVersion: 15, capabilities: ['play', 'ipc', 'relay']};
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

  // The owner's pick (2026-10-14): mpv keeps no resume position for a private window's
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
    // was a new helper process (review of 2026-10-14).
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
