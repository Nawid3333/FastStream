import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

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

describe('the intro and outro finder\'s data', () => {
  it('is kept where an unload of the background leaves it', async () => {
    // Held in the background alone, it went with the event page unloaded between episodes,
    // and the next episode had nothing to match (audit, 2026-10-09).
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.navigated(1, PAGE);
    const data = {intro: {'video-1': {hashBuffer: 'AAAA', timeBuffer: 'BBBB'}}, outro: {}};
    await bg.message({type: 'STORE_ANALYZER_DATA', data}, {tabId: 1, frameId: 2});
    await bg.wait(0);
    expect(bg.session['tabState:1']?.analyzerData).toEqual(data);
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
          {tab: container, frameId: 3}, (value) => answers.push(value));
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
});
