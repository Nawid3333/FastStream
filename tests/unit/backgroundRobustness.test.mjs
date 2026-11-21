import {afterEach, describe, expect, it, vi} from 'vitest';

import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// Small defects of the background script, each through its real listeners.

const PAGE = 'https://site.test/watch/1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

describe('the options', () => {
  it('are read again after a load that failed', async () => {
    // A failed first options load is retried, not kept until the event page unloads.
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

describe('a download Firefox does not make', () => {
  // Firefox can ask where to save ("Always ask where to save files"); the user cancelling that
  // was answered as a refused download, and the player said saving failed.
  it.each([
    ['the user cancelled the Save As', 'Download canceled by the user', false],
    ['Firefox refused it', 'Download failed', null],
  ])('is answered %s', async (what, message, expected) => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    bg.chrome.downloads.download = async () => {
      throw new Error(message);
    };
    const answers = [];
    for (const listener of bg.chrome.runtime.onMessage.listeners) {
      listener({type: 'DOWNLOAD', url: 'blob:moz-extension://bg-test/1', filename: 'a.mp4'},
          {tab: {id: 1, url: PAGE}, frameId: 3, url: 'moz-extension://bg-test/player/index.html'}, (value) => answers.push(value));
    }
    await bg.wait(0);
    expect(answers).toEqual([expected]);
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
          {tab: {id: hidden.id, url: hidden.url}, frameId: 0, url: 'moz-extension://bg-test/player/index.html'}, () => {});
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

  it('creates the hidden tab in the playing tab\'s window', async () => {
    // the save's cookie store is the private tab's, not the last focused window's
    const privateTab = {id: 1, url: PAGE, windowId: 7, cookieStoreId: 'firefox-private'};
    bg = await loadBackground({tabs: [privateTab]});
    for (const listener of bg.chrome.runtime.onMessage.listeners) {
      listener({type: 'DOWNLOAD', url: 'blob:moz-extension://bg-test/1', filename: 'a.mp4'},
          {tab: privateTab, frameId: 3, url: 'moz-extension://bg-test/player/index.html'}, () => {});
    }
    await bg.wait(0);
    expect(bg.createdTabs[0]).toMatchObject({windowId: 7, cookieStoreId: 'firefox-private'});
  });
});

describe('a new link for a stream the server refused', () => {
  // The player asks the page that gave the link for it anew (REQUEST_FRESH_LINK, FreshLink.mjs):
  // the background fetches that page again, with its site's cookies.
  const OLD = 'https://cdn.test/hls/master.m3u8?t=old&s=1';
  const NEW = 'https://cdn.test/hls/master.m3u8?t=new&s=2';

  /**
   * Has the page give its link, then the player in it ask for a new one.
   * @param {Object} tab - The tab, as Firefox describes it to the sender.
   * @return {Promise<{answer: *, pageFetches: Array<Object>}>} The player's answer, and the
   *   fetches of the page (their init).
   */
  async function askFromTab(tab) {
    const pageFetches = [];
    bg = await loadBackground({
      tabs: [tab],
      fetch: async (url, init) => {
        if (url !== PAGE) return response('', 404);
        pageFetches.push(init);
        return new Response(`<script>var file = "${NEW}";</script>`, {status: 200, headers: {'Content-Type': 'text/html'}});
      },
    });
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.request({tabId: 1, url: OLD});
    const answer = await bg.message({type: 'REQUEST_FRESH_LINK', url: OLD}, {tab, frameId: 3});
    return {answer, pageFetches};
  }

  it('is read from the page again in an ordinary tab', async () => {
    const {answer, pageFetches} = await askFromTab({id: 1, url: PAGE, incognito: false, cookieStoreId: 'firefox-default'});
    expect(answer).toBe(NEW);
    expect(pageFetches).toHaveLength(1);
    expect(pageFetches[0]).toMatchObject({credentials: 'include', cache: 'no-store'});
  });

  it('is not read from a private window\'s page', async () => {
    // The background is no private window: its fetch went with the normal window's cookies,
    // kept what the page set in the normal cookie jar, and missed a private window's proxy.
    const {answer, pageFetches} = await askFromTab({id: 1, url: PAGE, incognito: true, cookieStoreId: 'firefox-private'});
    expect(answer).toBeNull();
    expect(pageFetches).toEqual([]);
  });

  it('is not read from a container tab\'s page', async () => {
    // The container's own login is another than the default cookie store's the fetch went with.
    const {answer, pageFetches} = await askFromTab({id: 1, url: PAGE, incognito: false, cookieStoreId: 'firefox-container-1'});
    expect(answer).toBeNull();
    expect(pageFetches).toEqual([]);
  });
});

describe('a change of a tab other than its address', () => {
  it('does not set the toolbar button again for a title, a favicon or a sound', async () => {
    // tabs.onUpdated only for address and load changes (Firefox's filter), not every title change.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}, {id: 2, url: 'https://other.test/'}]});
    await bg.navigated(1, PAGE);
    expect(bg.titles.has(1)).toBe(true);
    bg.titles.clear();
    bg.badges.clear();
    await bg.tabChanged(1, {title: 'Episode 1 - 12:03'});
    await bg.tabChanged(1, {favIconUrl: 'https://site.test/favicon.ico'});
    await bg.tabChanged(1, {audible: true});
    expect([...bg.titles.keys(), ...bg.badges.keys()]).toEqual([]);
    // An address change still does, and a load without one (a reload: Firefox resets the
    // button on every new document).
    await bg.navigated(1, 'https://site.test/watch/2');
    expect(bg.titles.has(1)).toBe(true);
    bg.titles.clear();
    await bg.tabChanged(1, {status: 'loading'});
    expect(bg.titles.has(1)).toBe(true);
  });
});

describe('the toolbar\'s On with players for several frames', () => {
  it('opens the one over the largest video first, also when a frame gives no size', async () => {
    // A frame without a content script sorts last; the first player opened plays without a click
    // (isMainPlayer).
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

  it('opens them also when a frame never answers (its page holds the event loop)', async () => {
    // Content scripts share the page's event loop: the click waited for that frame's size
    // and opened no player at all.
    const sizes = {1: 100, 3: 300};
    bg = await loadBackground({
      tabs: [{id: 1, url: PAGE}],
      onTabMessage: ({frameId, message}) => {
        if (message.type !== 'GET_VIDEO_SIZE') return undefined;
        return frameId === 2 ? new Promise(() => {}) : sizes[frameId];
      },
    });
    for (const frameId of [1, 2, 3]) {
      await bg.request({tabId: 1, frameId, parentFrameId: 0, url: `https://cdn.test/${frameId}/master.m3u8`});
    }
    await bg.click(1);
    await bg.wait(6000);
    expect(bg.sent('OPEN_PLAYER').map((m) => m.frameId)).toEqual([3, 1, 2]);
  });

  it('opens none in a frame the tab dropped while its video was measured', async () => {
    // A tab gone on to another site while the page answered gets no player by frame id.
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
    // The same for an open scheduled by replaceDelay that waits for the playlist's length.
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
    // the frame stays the tab's, but the new page in it is not the one measured
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
    // the rule's character class holds no literal `|`
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

  it('does not take the extension from the query string', async () => {
    // `.+` does not run past the `?`: a search or an embed page naming a stream in its query is not
    // redirected
    bg = await loadBackground({options: {playMP4URLs: true, playStreamURLs: true}});
    const rules = bg.dynamicRules.flatMap((update) => update.addRules || []);
    const filter = (id) => new RegExp(rules.find((rule) => rule.id === id).condition.regexFilter);
    expect(filter(1).test('https://www.search.test/search?client=firefox-b-d&q=index.mp4')).toBe(false);
    expect(filter(2).test('https://site.test/embed.php?file=https://cdn.test/x/index.m3u8')).toBe(false);
    expect(filter(2).test('https://cdn.test/x/index.m3u8?t=1')).toBe(true);
  });

  it('keeps no rule for an option turned off while its rule was being added', async () => {
    // An options load that turns the option off during the rule's address-key read wins over the
    // first load's add.
    bg = await loadBackground({options: {playMP4URLs: false}});
    bg.options = {playMP4URLs: true};
    const on = bg.message({type: 'LOAD_OPTIONS', time: 1}, {tabId: 99});
    bg.options = {playMP4URLs: false};
    const off = bg.message({type: 'LOAD_OPTIONS', time: 2}, {tabId: 99});
    await Promise.all([on, off]);
    await bg.wait(100);
    const touching = bg.dynamicRules.filter((update) => (update.removeRuleIds || []).includes(1) ||
      (update.addRules || []).some((rule) => rule.id === 1));
    expect(touching.at(-1).addRules?.some((rule) => rule.id === 1) ?? false).toBe(false);
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

  it('is changed only when what it is made of changes', async () => {
    // An unchanged options load makes no declarativeNetRequest updates (a dragged slider saves ~120
    // times).
    const both = {playMP4URLs: true, playStreamURLs: true, autoEnableURLs: ['https://site.test/']};
    bg = await loadBackground({options: both});
    const load = async (options) => {
      const before = bg.dynamicRules.length;
      bg.options = options;
      await bg.message({type: 'LOAD_OPTIONS', time: Date.now()}, {tabId: 99});
      await bg.wait(100);
      return bg.dynamicRules.slice(before);
    };
    expect(bg.dynamicRules).toHaveLength(2);
    expect(await load(both)).toEqual([]);
    expect(await load({...both, replaceDelay: 700, autoEnableURLs: ['https://site.test/', 'https://other.test/']})).toEqual([]);
    // A -domain entry: both rules leave its site alone.
    const excluded = await load({...both, autoEnableURLs: ['https://site.test/', '-github.com']});
    expect(excluded.map((update) => update.addRules[0].condition.excludedRequestDomains))
        .toEqual([['bg-test', 'github.com'], ['bg-test', 'github.com']]);
    expect(await load({...both, autoEnableURLs: ['-github.com']})).toEqual([]);
    // A switch turned off takes its rule away, once; turned on again, the rule comes back.
    expect(await load({...both, playMP4URLs: false, autoEnableURLs: ['-github.com']})).toEqual([{removeRuleIds: [1]}]);
    expect(await load({...both, playMP4URLs: false, autoEnableURLs: ['-github.com']})).toEqual([]);
    expect((await load({...both, autoEnableURLs: ['-github.com']})).map((update) => update.addRules[0].id)).toEqual([1]);
  });
});

// The Auto-enable URLs list as the background reads it (UrlMatchList): -domain lines kept, a lone
// `~` no regex.
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
  // A send to mpv, a header rule and a download are taken only from the player, not a content
  // script.
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

describe('the permissions tab the player\'s VPN button opens', () => {
  it('is not closed as a popup by the same click', async () => {
    // The permissions tab the button opens is not closed as the page's pop-up.
    bg = await loadBackground({options: {blockPopupsWhilePlaying: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.message({type: 'POPUP_GUARD_ARM'}, {tabId: 1, frameId: 0, url: PAGE});
    await bg.message({type: 'VPN_OPEN_PERMISSION'},
        {tab: {id: 1, index: 0, url: PAGE}, frameId: 3, url: 'moz-extension://bg-test/player/index.html'});
    const perms = bg.createdTabs[0];
    expect(String(perms.url)).toContain('perms.html#proxy');
    for (const listener of bg.chrome.tabs.onCreated.listeners) {
      listener({id: 200, index: 1, windowId: 1, openerTabId: 1, url: perms.url});
    }
    await bg.wait(10);
    expect(bg.removedTabs).toEqual([]);
  });

  it('leaves the guard closing a popup that page opens on a click', async () => {
    bg = await loadBackground({options: {blockPopupsWhilePlaying: true}, tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    await bg.message({type: 'POPUP_GUARD_ARM'}, {tabId: 1, frameId: 0, url: PAGE});
    for (const listener of bg.chrome.tabs.onCreated.listeners) {
      listener({id: 201, index: 1, windowId: 1, openerTabId: 1, url: 'https://ads.test/'});
    }
    await bg.wait(10);
    expect(bg.removedTabs).toEqual([201]);
  });
});

describe('a web page a player in a page opens', () => {
  // A framed player has no chrome.tabs: the background opens external URLs for it.
  const PLAYER_FRAME = 'moz-extension://bg-test/player/index.html#https://site.test/video.mp4';
  const from = (url = PLAYER_FRAME) => ({tab: {id: 1, index: 0, url: PAGE}, frameId: 3, url});

  it('is opened for the player, an http or https one', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    for (const url of ['https://www.opensubtitles.com/en/subtitles/x', 'http://example.test/report?e=1']) {
      expect(await bg.message({type: 'OPEN_EXTERNAL_URL', url}, from()), url).toBe(true);
    }
    // With no opener: the popup guard, armed by the click into the player, leaves it alone.
    expect(bg.createdTabs).toEqual([
      {id: 1000, url: 'https://www.opensubtitles.com/en/subtitles/x'}, {id: 1001, url: 'http://example.test/report?e=1'}]);
  });

  it('is opened for the settings page in that player too', async () => {
    // Its report and update buttons (options.mjs): an iframe in the player, as short of
    // chrome.tabs as the player itself.
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    const page = 'https://github.com/example/releases';
    expect(await bg.message({type: 'OPEN_EXTERNAL_URL', url: page},
        from('moz-extension://bg-test/player/options/index.html'))).toBe(true);
    expect(bg.createdTabs).toEqual([{id: 1000, url: page}]);
  });

  it('is no other address, and not for a content script or another of FastStream\'s pages', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    for (const url of ['javascript:alert(1)', 'data:text/html,<p>x', 'moz-extension://bg-test/player/index.html',
      '/player/index.html#https://site.test/video.mp4', 'file:///C:/x', 'about:config', '', undefined, 7]) {
      expect(await bg.message({type: 'OPEN_EXTERNAL_URL', url}, from()), String(url)).toBe(false);
    }
    const page = 'https://www.opensubtitles.com/en/subtitles/x';
    // A content script runs in every page: not answered at all (MessageSenders).
    expect(await bg.message({type: 'OPEN_EXTERNAL_URL', url: page}, from(PAGE))).toBe(undefined);
    // Another of its pages does not ask (the welcome page, a page named like the player's).
    for (const other of ['moz-extension://bg-test/welcome.html', 'moz-extension://bg-test/player/index.htmlx/../evil.html']) {
      expect(await bg.message({type: 'OPEN_EXTERNAL_URL', url: page}, from(other)), other).toBe(false);
    }
    expect(bg.createdTabs).toEqual([]);
  });
});

describe('the toolbar button of a tab that closed', () => {
  it('leaves no rejected call unhandled', async () => {
    // A toolbar call for a tab that is gone ("Invalid tab ID") is handled, not an unhandled error.
    const answers = [];
    const gone = () => {
      const answer = {handled: false};
      answers.push(answer);
      return {
        then(onDone, onFailed) {
          if (onFailed) answer.handled = true;
          return this;
        },
        catch() {
          answer.handled = true;
          return this;
        },
      };
    };
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    bg.chrome.action.setBadgeText = gone;
    bg.chrome.action.setTitle = gone;
    bg.chrome.action.setIcon = gone;
    await bg.click(1); // On
    await bg.click(1); // Off, and its badge goes a second later
    await bg.wait(1500);
    expect(answers.length).toBeGreaterThanOrEqual(7);
    expect(answers.filter((answer) => !answer.handled)).toEqual([]);
  });
});
