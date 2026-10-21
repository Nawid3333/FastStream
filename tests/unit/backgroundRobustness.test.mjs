import {afterEach, describe, expect, it, vi} from 'vitest';

import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// Small defects of the background script (#144), each through its real listeners.

const PAGE = 'https://site.test/watch/1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

describe('the options', () => {
  it('are read again after a load that failed', async () => {
    // The failed first load was kept: until the event page unloaded, every event acted on
    // no options at all - MPV mode and both URL lists off.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failures = 1;
    bg = await loadBackground({
      options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
      tabs: [{id: 1, url: 'about:blank'}],
      beforeImport: (chrome) => {
        const get = chrome.storage.local.get;
        chrome.storage.local.get = (key, callback) => {
          if (failures-- > 0) {
            throw new Error('storage is not ready');
          }
          return get(key, callback);
        };
      },
    });
    await bg.navigated(1, PAGE);
    expect(bg.session['tabState:1']).toMatchObject({isOn: true, isMpv: true});
  });
});

describe('a download from a container tab', () => {
  // A container tab's download goes through a hidden player tab in the same container,
  // which the background gives 30 s.
  const container = {id: 1, url: PAGE, cookieStoreId: 'firefox-container-1'};

  /**
   * Starts a download from the player in the container tab, and has the hidden tab's
   * player load after the given time.
   * @param {number} loadedAfterMs - When the hidden tab's player says it loaded.
   * @return {Promise<Array<*>>} The answers the download got.
   */
  async function download(loadedAfterMs) {
    const answers = [];
    for (const listener of bg.chrome.runtime.onMessage.listeners) {
      listener({type: 'DOWNLOAD', url: 'blob:moz-extension://bg-test/1', filename: 'a.mp4'},
          {tab: container, frameId: 3, url: 'moz-extension://bg-test/player/index.html'}, (value) => answers.push(value));
    }
    await bg.wait(loadedAfterMs);
    const hidden = bg.createdTabs[0];
    expect(hidden.cookieStoreId).toBe('firefox-container-1');
    for (const listener of bg.chrome.runtime.onMessage.listeners) {
      listener({type: 'PLAYER_LOADED', url: 'moz-extension://bg-test/player/index.html'},
          {tab: {id: hidden.id, url: hidden.url}, frameId: 0}, () => {});
    }
    return answers;
  }

  it('gets the player\'s answer, and the hidden tab is closed', async () => {
    bg = await loadBackground({
      tabs: [container],
      onTabMessage: ({message}) => message.type === 'HANDLE_DOWNLOAD' ? 42 : undefined,
    });
    const answers = await download(1000);
    await bg.wait(0);
    expect(answers).toEqual([42]);
    expect(bg.removedTabs).toEqual([bg.createdTabs[0].id]);
    await bg.wait(30000);
    expect(answers).toEqual([42]);
  });

  it('is answered once when the player answers after the 30 s ran out', async () => {
    // The timeout cleared the download while the player saved it, and the player's answer
    // then threw a TypeError on it.
    bg = await loadBackground({
      tabs: [container],
      onTabMessage: ({message}) => message.type === 'HANDLE_DOWNLOAD' ?
        new Promise((resolve) => setTimeout(() => resolve(42), 1000)) : undefined,
    });
    const answers = await download(29500);
    await bg.wait(2000);
    expect(bg.callbackErrors).toEqual([]);
    expect(answers).toEqual([null]);
  });

  it('is answered when the player never answers', async () => {
    bg = await loadBackground({
      tabs: [container],
      onTabMessage: ({message}) => message.type === 'HANDLE_DOWNLOAD' ? new Promise(() => {}) : undefined,
    });
    const answers = await download(1000);
    await bg.wait(30000);
    expect(answers).toEqual([null]);
    expect(bg.removedTabs).toEqual([bg.createdTabs[0].id]);
  });
});

describe('the toolbar\'s On with players for several frames', () => {
  it('opens the one over the largest video first, also when a frame gives no size', async () => {
    // A frame without a content script answers nothing: its size was undefined, the sort
    // compared NaN, and the order came out arbitrary. The first player opened is the one
    // that plays without a click (isMainPlayer).
    const sizes = {1: 100, 2: undefined, 3: 300};
    bg = await loadBackground({
      tabs: [{id: 1, url: PAGE}],
      onTabMessage: ({frameId, message}) => message.type === 'GET_VIDEO_SIZE' ? sizes[frameId] : undefined,
    });
    for (const frameId of [1, 2, 3]) {
      await bg.request({tabId: 1, frameId, parentFrameId: 0, url: `https://cdn.test/${frameId}/master.m3u8`});
    }
    await bg.click(1);
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER').map((m) => m.frameId)).toEqual([3, 1, 2]);
  });

  it('opens none in a frame the tab dropped while its video was measured', async () => {
    // The page answers its video's size when its scripts let it; the tab went on to another
    // site meanwhile, and the frame's id was sent a player for the page there (glm's review,
    // 2026-10-13). onSourceRecieved's own wait checked this already.
    bg = await loadBackground({
      tabs: [{id: 1, url: PAGE}],
      onTabMessage: ({message}) => message.type === 'GET_VIDEO_SIZE' ?
        new Promise((resolve) => setTimeout(() => resolve(640 * 360), 1500)) : undefined,
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, frameId: 4, parentFrameId: 0, url: 'https://cdn.test/4/master.m3u8'});
    await bg.click(1);
    await bg.wait(500);
    await bg.navigated(1, 'https://other.test/');
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
  });

  it('opens none from a detected stream whose frame the tab dropped while its length was read', async () => {
    // The open a stream schedules (Options.replaceDelay) waits up to 2.5 s for the playlist's
    // length; the tab went on to another site meanwhile, and OPEN_PLAYER went by frame id to
    // the page there (glm's second look, 2026-10-13).
    bg = await loadBackground({
      options: {autoEnableURLs: ['https://site.test/', 'https://other.test/']},
      tabs: [{id: 1, url: PAGE}],
      fetch: (url) => new Promise((resolve) => setTimeout(() => resolve(response(hlsPlaylist(1400))), 2000)),
    });
    await bg.navigated(1, PAGE);
    await bg.request({tabId: 1, frameId: 4, parentFrameId: 0, url: 'https://cdn.test/4/master.m3u8'});
    await bg.wait(800);
    await bg.navigated(1, 'https://other.test/');
    await bg.wait(5000);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
  });

  it('opens none in a frame that loaded another page while its video was measured', async () => {
    // The frame stays the tab's (a new page in it is reset in place), so isTracked() let the
    // player go to the new page, whose streams were not the ones measured (review of the
    // fixes, 2026-10-13).
    bg = await loadBackground({
      tabs: [{id: 1, url: PAGE}],
      onTabMessage: ({message}) => message.type === 'GET_VIDEO_SIZE' ?
        new Promise((resolve) => setTimeout(() => resolve(640 * 360), 1500)) : undefined,
    });
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 4, 'https://hoster.test/e/1', 'page1');
    await bg.request({tabId: 1, frameId: 4, parentFrameId: 0, url: 'https://cdn.test/4/master.m3u8'});
    await bg.click(1);
    await bg.wait(500);
    await bg.frameAdded(1, 4, 'https://hoster.test/e/2', 'page2');
    await bg.wait(3000);
    expect(bg.sent('OPEN_PLAYER')).toEqual([]);
  });
});

describe('the "use the player for stream links" redirect', () => {
  it('takes a link up to its query or fragment, and no other character', async () => {
    // The rule's `[\?|#]` held a literal `|`: a.mp4|anything was redirected too.
    bg = await loadBackground({options: {playMP4URLs: true, playStreamURLs: true}});
    const rules = bg.dynamicRules.flatMap((update) => update.addRules || []);
    const filter = (id) => new RegExp(rules.find((rule) => rule.id === id).condition.regexFilter);
    expect(filter(1).test('https://cdn.test/a.mp4')).toBe(true);
    expect(filter(1).test('https://cdn.test/a.mp4?t=1')).toBe(true);
    expect(filter(1).test('https://cdn.test/a.mp4#t=1')).toBe(true);
    expect(filter(1).test('https://cdn.test/a.mp4|t=1')).toBe(false);
    expect(filter(2).test('https://cdn.test/a.m3u8?x=1')).toBe(true);
    expect(filter(2).test('https://cdn.test/a.mpd|x')).toBe(false);
  });

  it('opens the player with the install\'s address key, so it takes the link\'s headers', async () => {
    // Any page can open the player page with an address of its own: the player takes the
    // address's headers and mode only with this key (AddressKey.mjs).
    bg = await loadBackground({options: {playMP4URLs: true, playStreamURLs: true}});
    const rules = bg.dynamicRules.flatMap((update) => update.addRules || []);
    const key = bg.local.playerAddressKey;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    for (const id of [1, 2]) {
      expect(rules.find((rule) => rule.id === id).action.redirect.regexSubstitution)
          .toBe('moz-extension://bg-test/player/index.html?address=' + key + '#\\0');
    }
  });
});

// The Auto-enable URLs list as the background turns a tab on by it (tabs.onUpdated). The
// background had its own parser for the list, which dropped every `-domain` line and kept a
// lone `~` as a regex matching every URL (upstream #241). UrlMatchList.test.mjs pins the
// list line by line; these two were classic-specs/auto-enable-list.e2e.mjs's until
// 2026-10-13, which still checks the -domain line against Firefox's own redirect rule. A
// tab turned on by a list in Firefox is every spec's that puts its site on the list.
describe('the Auto-enable URLs list', () => {
  it('does not auto-enable on a -domain site that an earlier line lists', async () => {
    bg = await loadBackground({options: {autoEnableURLs: ['https://site.test/']}, tabs: [{id: 1, url: 'about:blank'}]});
    await bg.navigated(1, 'https://site.test/listed');
    // A listed page is turned on, or this proves nothing.
    expect(bg.badges.get(1)).toBe('On');

    bg.options = {autoEnableURLs: ['https://site.test/', '-site.test']};
    await bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99});
    await bg.navigated(1, 'https://site.test/excluded');
    expect(bg.session['tabState:1']).toMatchObject({isOn: false});
    expect(bg.badges.get(1)).not.toBe('On');
  });

  it('does not auto-enable every site for a lone ~ line', async () => {
    bg = await loadBackground({options: {autoEnableURLs: ['~', 'https://listed.test/']},
      tabs: [{id: 1, url: 'about:blank'}, {id: 2, url: 'about:blank'}]});
    // The line beside it still works.
    await bg.navigated(1, 'https://listed.test/watch');
    expect(bg.badges.get(1)).toBe('On');

    await bg.navigated(2, 'https://other.test/anything');
    expect(bg.session['tabState:2']).toMatchObject({isOn: false});
    expect(bg.badges.get(2)).not.toBe('On');
  });
});

describe('messages only FastStream\'s own pages send', () => {
  // A send to mpv (with no MPV allowlist: it is the user's button), a header rule and a
  // download each did what the message named for any sender, a content script in any page
  // included (#470). Only the player sends them.
  const PLAYER_PAGE = 'moz-extension://bg-test/player/index.html';
  const messages = [
    {type: 'MPV_OPEN', url: 'https://cdn.test/a.m3u8', headers: []},
    {type: 'SET_HEADERS', url: 'https://cdn.test/a.m3u8', commands: [{operation: 'set', header: 'Referer', value: 'https://x.test/'}]},
    {type: 'DOWNLOAD', url: 'https://cdn.test/a.mp4', filename: 'a.mp4'},
  ];

  it('refuses them from a page\'s content script', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    const downloads = vi.spyOn(bg.chrome.downloads, 'download');
    for (const message of messages) {
      await bg.message(message, {tabId: 1, frameId: 0, url: PAGE});
    }
    await bg.wait(3000);
    expect(bg.native.filter((m) => m.type === 'open')).toEqual([]);
    expect(bg.sessionRuleUpdates.filter((update) => update.addRules?.length)).toEqual([]);
    expect(downloads).not.toHaveBeenCalled();
  });

  it('takes them from the player', async () => {
    bg = await loadBackground({options: {mpvMode: true}, tabs: [{id: 1, url: PAGE}]});
    const downloads = vi.spyOn(bg.chrome.downloads, 'download');
    for (const message of messages) {
      await bg.message(message, {tabId: 1, frameId: 0, url: PLAYER_PAGE});
    }
    await bg.wait(3000);
    expect(bg.native.filter((m) => m.type === 'open').length).toBe(1);
    expect(bg.sessionRuleUpdates.filter((update) => update.addRules?.length).length).toBe(1);
    expect(downloads).toHaveBeenCalledTimes(1);
  });
});
