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
