import {afterEach, describe, expect, it, vi} from 'vitest';

import {MenuIds} from '../../chrome/background/ContextMenu.mjs';
import {loadBackground} from './backgroundHarness.mjs';

// YouTube in mpv: FastStream finds none of its streams, so a video goes as its own watch
// address, which mpv opens with yt-dlp (docs/notes/mpv.md, "YouTube in mpv").

const VIDEO = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const NEXT = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/**
 * The user starts the video of a YouTube page in tab 1 (an MSE player's blob:).
 * @param {string} page - The page's address, as the page has it.
 * @param {number} [time] - Where the video is.
 * @return {Promise<void>}
 */
async function play(page, time = 0) {
  await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://www.youtube.com/1',
    video: {src: '', duration: 212, playing: 'blob:https://www.youtube.com/1', time}, page}, {tabId: 1, frameId: 0});
}

/** @return {Array<Object>} The open messages the mpv host got. */
function opened() {
  return bg.native.filter((m) => m.type === 'open');
}

describe('a YouTube video in a tab in MPV', () => {
  it('goes as its watch address, from where it is, and the page pauses', async () => {
    bg = await loadBackground({options: {mpvMode: true},
      tabs: [{id: 1, url: `${VIDEO}&list=PL0123456789&t=42s`, title: 'A video - YouTube'}]});
    await bg.command('toggle_mpv', 1);
    await play(`${VIDEO}&list=PL0123456789&t=42s`, 95);
    expect(opened()).toEqual([expect.objectContaining({url: VIDEO, pageUrl: VIDEO, title: 'A video - YouTube', start: 95})]);
    expect(bg.sent('PAUSE_MEDIA')).toHaveLength(1);
  });

  it('is the one the page moved to without a load, not the tab\'s last one', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: VIDEO}]});
    await bg.command('toggle_mpv', 1);
    await play(NEXT);
    expect(opened()).toEqual([expect.objectContaining({url: NEXT, pageUrl: NEXT})]);
  });

  it('only pauses the page again when its player starts the same video once more', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: VIDEO}]});
    await bg.command('toggle_mpv', 1);
    await play(VIDEO);
    await play(VIDEO);
    expect(bg.toMpv()).toEqual([VIDEO]);
    expect(bg.sent('PAUSE_MEDIA')).toHaveLength(2);
  });

  it('takes the MPV Allowlist\'s tag, @native included', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['site.test', 'youtube.com @native']},
      tabs: [{id: 1, url: VIDEO}]});
    await bg.command('toggle_mpv', 1);
    await play(VIDEO);
    expect(opened()).toEqual([expect.objectContaining({url: VIDEO, contentType: 'native'})]);
  });

  it('goes in the MPV Allowlist\'s MPV too, where a play elsewhere counts only on a page Back gave back', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['youtube.com']}, tabs: [{id: 1, url: VIDEO}]});
    await bg.navigated(1, VIDEO);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: false});
    await play(VIDEO);
    await play(NEXT);
    expect(bg.toMpv()).toEqual([VIDEO, NEXT]);
  });

  it('stays in the page while the tab is not in MPV', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: VIDEO}]});
    await play(VIDEO);
    await bg.wait(3500);
    expect(bg.toMpv()).toEqual([]);
  });

  it('stays in the page with MPV mode off', async () => {
    bg = await loadBackground({options: {mpvMode: false, mpvAllowlist: ['youtube.com']}, tabs: [{id: 1, url: VIDEO}]});
    await bg.navigated(1, VIDEO);
    await play(VIDEO);
    await bg.wait(3500);
    expect(bg.toMpv()).toEqual([]);
  });

  it('is not what a YouTube page without one video sends', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: 'https://www.youtube.com/'}]});
    await bg.command('toggle_mpv', 1);
    await play('https://www.youtube.com/');
    await bg.wait(3500);
    expect(bg.toMpv()).toEqual([]);
  });
});

describe('MPV switched on over a YouTube video page', () => {
  it('asks the page for its video, autoplayed or paused; elsewhere only for one the user started', async () => {
    bg = await loadBackground({options: {mpvMode: true},
      tabs: [{id: 1, url: VIDEO}, {id: 2, url: 'https://site.test/watch/1'}]});
    await bg.command('toggle_mpv', 1);
    await bg.command('toggle_mpv', 2);
    expect(bg.sent('MPV_REPORT_PLAYING').map((m) => [m.tabId, m.message.any])).toEqual([[1, true], [2, false]]);
  });

  it('asks it from the right-click menu\'s Play in MPV too', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: VIDEO}]});
    await bg.menuClick(MenuIds.MPV, 1);
    expect(bg.sent('MPV_REPORT_PLAYING').map((m) => m.message.any)).toEqual([true]);
  });

  it('asks it on the MPV Allowlist\'s toolbar step to MPV', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAllowlist: ['youtube.com']}, tabs: [{id: 1, url: VIDEO}]});
    await bg.navigated(1, VIDEO);
    // MPV -> Off -> On -> MPV.
    await bg.click(1);
    await bg.click(1);
    await bg.click(1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
    expect(bg.sent('MPV_REPORT_PLAYING').map((m) => m.message.any)).toEqual([true]);
  });
});

describe('Open link in MPV on a YouTube link', () => {
  it('sends the video to mpv, from the link\'s time, with no new tab', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: 'https://site.test/page'}]});
    await bg.menuClick(MenuIds.LINK_MPV, 1, {linkUrl: 'https://youtu.be/aaaaaaaaaaa?t=1m30s', linkText: 'A video'});
    expect(opened()).toEqual([expect.objectContaining({url: VIDEO, pageUrl: VIDEO, title: 'A video', start: 90})]);
    expect(opened()[0]).not.toHaveProperty('subtitles');
    expect(bg.createdTabs).toEqual([]);
    expect(bg.sent('PAUSE_MEDIA')).toEqual([]);
  });

  it('ties mpv to no tab: the page it was in has no next episode of it', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvAutoplayNext: true},
      tabs: [{id: 1, url: 'https://site.test/watch/1'}]});
    await bg.menuClick(MenuIds.LINK_MPV, 1, {linkUrl: VIDEO});
    expect(bg.toMpv()).toEqual([VIDEO]);
    expect(bg.ports).toEqual([]);
  });

  it('keeps a private window\'s video private (no resume position in mpv)', async () => {
    bg = await loadBackground({options: {mpvMode: true}, thinHost: true,
      tabs: [{id: 1, url: 'https://site.test/page', incognito: true}]});
    await bg.menuClick(MenuIds.LINK_MPV, 1, {linkUrl: VIDEO});
    expect(JSON.stringify(bg.native.filter((m) => m.type === 'play'))).toContain('fs-private=1');
  });

  it('opens any other link in a new tab in MPV, as before', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: 'https://site.test/page'}]});
    await bg.menuClick(MenuIds.LINK_MPV, 1, {linkUrl: 'https://www.youtube.com/playlist?list=PL0123456789'});
    expect(bg.toMpv()).toEqual([]);
    expect(bg.createdTabs).toEqual([expect.objectContaining({url: 'https://www.youtube.com/playlist?list=PL0123456789'})]);
  });
});
