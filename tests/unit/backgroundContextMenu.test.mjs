import {afterEach, describe, expect, it} from 'vitest';

import {linkTarget, menuItems, MenuIds} from '../../chrome/background/ContextMenu.mjs';
import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// The page's right-click menu (his wish, 2026-10-24): FastStream and MPV for the page and its
// video, as the toolbar button and the MPV key switch them, and a link opened in a new tab
// with FastStream or MPV on. The harness's i18n gives no text, so an item's title is its key.

const PAGE = 'https://site.test/watch/1';
const NEXT = 'https://site.test/watch/2';
const EPISODE = 'https://cdn.test/episode/master.m3u8';
const AD = 'https://cdn.test/ad/master.m3u8';

/** @type {Awaited<ReturnType<typeof loadBackground>>} */
let bg;

afterEach(() => {
  bg?.unload();
  bg = undefined;
});

/**
 * Each playlist with its length, answered after a delay.
 * @param {Object<string, number>} lengths - Seconds, by URL.
 * @return {function(string): Promise<Object>}
 */
function playlists(lengths) {
  return (url) => new Promise((resolve) => {
    setTimeout(() => resolve(lengths[url] === undefined ? response('', 404) : response(hlsPlaylist(lengths[url]))), 300);
  });
}

describe('menuItems', () => {
  const key = (/** @type {string} */ k) => k;

  it('names the page\'s items for a tab FastStream is off, on, or in MPV', () => {
    const off = menuItems({isOn: false, isMpv: false, mpvMode: true}, key);
    expect(off.map((item) => item.title)).toEqual(['menu_play_in_faststream', 'menu_play_in_mpv', 'menu_link_in_faststream', 'menu_link_in_mpv']);
    const on = menuItems({isOn: true, isMpv: false, mpvMode: true}, key);
    expect(on.map((item) => item.title).slice(0, 2)).toEqual(['menu_faststream_off', 'menu_play_in_mpv']);
    const mpv = menuItems({isOn: true, isMpv: true, mpvMode: true}, key);
    expect(mpv.map((item) => item.title).slice(0, 2)).toEqual(['menu_play_in_faststream', 'menu_mpv_off']);
  });

  it('shows no MPV item while MPV mode is off in the options', () => {
    const items = menuItems({isOn: false, isMpv: false, mpvMode: false}, key);
    expect(items.filter((item) => item.visible).map((item) => item.id)).toEqual([MenuIds.PLAYER, MenuIds.LINK_PLAYER]);
  });
});

describe('linkTarget', () => {
  it('takes a web page\'s link, never another scheme or a broken one', () => {
    expect(linkTarget('https://site.test/watch/2?ep=2')).toBe('https://site.test/watch/2?ep=2');
    expect(linkTarget('http://site.test/x')).toBe('http://site.test/x');
    for (const bad of ['javascript:alert(1)', 'mailto:x@site.test', 'file:///C:/x.mp4', 'data:text/html,x', 'not a url', '', undefined]) {
      expect(linkTarget(bad)).toBe(null);
    }
  });
});

describe('the right-click menu', () => {
  it('is made at the background\'s start, for web pages, the MPV items only with MPV mode', async () => {
    bg = await loadBackground({options: {mpvMode: false}});
    expect([...bg.menuItems.keys()]).toEqual([MenuIds.PLAYER, MenuIds.MPV, MenuIds.LINK_PLAYER, MenuIds.LINK_MPV]);
    expect(bg.menuItems.get(MenuIds.PLAYER)).toMatchObject({contexts: ['page', 'frame', 'video', 'audio'], visible: true,
      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*']});
    expect(bg.menuItems.get(MenuIds.LINK_PLAYER)).toMatchObject({contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*']});
    expect(bg.menuItems.get(MenuIds.MPV).visible).toBe(false);
    expect(bg.menuItems.get(MenuIds.LINK_MPV).visible).toBe(false);
  });

  it('names its items for the tab it opens in, and shows them so', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.menuShown(1);
    expect(bg.menuItems.get(MenuIds.PLAYER).title).toBe('menu_play_in_faststream');
    expect(bg.menuItems.get(MenuIds.MPV)).toMatchObject({title: 'menu_play_in_mpv', visible: true});
    expect(bg.menuRefreshes).toBe(1);

    await bg.menuClick(MenuIds.PLAYER, 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: false});
    await bg.menuShown(1);
    expect(bg.menuItems.get(MenuIds.PLAYER).title).toBe('menu_faststream_off');

    await bg.menuClick(MenuIds.PLAYER, 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: false});
  });

  it('switches MPV as the MPV key does, and names it so', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.menuClick(MenuIds.MPV, 1);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
    await bg.menuShown(1);
    expect(bg.menuItems.get(MenuIds.MPV).title).toBe('menu_mpv_off');
  });

  it('opens a link beside its tab, in its container, with the player on there', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE, index: 4, windowId: 1, cookieStoreId: 'firefox-container-2'}]});
    await bg.menuClick(MenuIds.LINK_PLAYER, 1, {linkUrl: NEXT});
    expect(bg.createdTabs).toEqual([expect.objectContaining({url: NEXT, active: true, index: 5, windowId: 1, cookieStoreId: 'firefox-container-2'})]);
    const id = bg.createdTabs[0].id;
    expect(bg.session[`tabState:${id}`]).toMatchObject({isOn: true, isMpv: false, mpvOnPlay: false});
  });

  it('opens a link in MPV: the video the user starts there goes to mpv, not one that starts by itself', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE, index: 0, windowId: 1}],
      fetch: playlists({[EPISODE]: 1400, [AD]: 30})});
    await bg.menuClick(MenuIds.LINK_MPV, 1, {linkUrl: NEXT});
    const id = bg.createdTabs[0].id;
    bg.tabs.push({id, url: NEXT});
    expect(bg.session[`tabState:${id}`]).toMatchObject({isOn: true, isMpv: true, mpvOnPlay: true});
    await bg.navigated(id, NEXT);
    // An ad that plays by itself first: nothing goes.
    await bg.request({tabId: id, url: AD});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([]);
    // The user starts the episode.
    await bg.message({type: 'MPV_USER_PLAY', src: 'blob:https://site.test/2', video: {src: '', duration: 1400}}, {tabId: id, frameId: 0});
    await bg.request({tabId: id, url: EPISODE});
    await bg.wait(1000);
    expect(bg.toMpv()).toEqual([EPISODE]);
  });

  it('keeps the link\'s choice when the tab it was in is in MPV', async () => {
    // Opened without an opener: the MPV key's inheritance (inheritMpv) would turn a tab the
    // menu opened for the player into MPV.
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE, index: 0, windowId: 1}]});
    await bg.navigated(1, PAGE);
    await bg.command('toggle_mpv', 1);
    await bg.menuClick(MenuIds.LINK_PLAYER, 1, {linkUrl: NEXT});
    const created = bg.createdTabs[0];
    expect(created.openerTabId).toBeUndefined();
    await bg.opened({id: created.id, url: NEXT});
    expect(bg.session[`tabState:${created.id}`]).toMatchObject({isOn: true, isMpv: false});
  });

  it('opens nothing for a link that is no web page, nor in MPV with MPV mode off', async () => {
    bg = await loadBackground({options: {mpvMode: false}, tabs: [{id: 1, url: PAGE}]});
    await bg.menuClick(MenuIds.LINK_PLAYER, 1, {linkUrl: 'javascript:void(0)'});
    await bg.menuClick(MenuIds.LINK_MPV, 1, {linkUrl: NEXT});
    expect(bg.createdTabs).toEqual([]);
  });
});
