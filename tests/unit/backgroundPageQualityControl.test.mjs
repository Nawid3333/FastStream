import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// The player asks the page it is in for its player's menu qualities and has it switch to one
// (page-quality-control.js); the background passes it on. The file the page then loads is no new stream.

const PAGE = 'https://site.test/watch/1';
const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';
const FILE = 'https://site.test/v/360.mp4';
const PLAYER_TAB = 'moz-extension://bg-test/player/index.html';
const MP4 = {responseHeaders: [{name: 'Content-Type', value: 'video/mp4'}]};

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * An auto-enabled page playing a file, FastStream's player in it as frame 5, an ad's frame 9 beside it.
 * @param {function(Object): *} onTabMessage - The page's answers.
 * @param {Array<Object>} [moreTabs]
 * @return {Promise<void>}
 */
async function pageWithPlayer(onTabMessage, moreTabs = []) {
  bg = await loadBackground({options: {autoEnableURLs: ['https://site.test/']}, tabs: [{id: 1, url: PAGE}, ...moreTabs],
    onTabMessage});
  await bg.navigated(1, PAGE);
  await bg.frameAdded(1, 0, PAGE, 'page-1');
  await bg.request({tabId: 1, url: FILE}, MP4);
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
  await bg.frameAdded(1, 9, 'https://ads.test/banner', 'ad-1');
  bg.sentToTabs.length = 0;
}

describe('a page player\'s menu qualities, asked for by FastStream\'s player in it', () => {
  it('asks the page the player is in and hands the player its answer', async () => {
    const choices = {id: 1, choices: [{label: '360p', height: 360}, {label: '1080p', height: 1080}]};
    await pageWithPlayer(({message}) => (message.type === 'PAGE_QUALITY_PROBE' ? choices : undefined));

    const answer = await bg.message({type: 'PAGE_QUALITY_PROBE', frameId: 0, url: FILE}, {tabId: 1, frameId: 5});

    expect(answer).toEqual(choices);
    expect(bg.sent('PAGE_QUALITY_PROBE')).toEqual([{tabId: 1, frameId: 0,
      message: {type: 'PAGE_QUALITY_PROBE', url: FILE, requestedUrl: undefined, playerFrameId: 5}}]);
  });

  it('asks no other frame, and nothing for a page\'s script', async () => {
    await pageWithPlayer(() => ({id: 1, choices: []}));

    expect(await bg.message({type: 'PAGE_QUALITY_SELECT', frameId: 9, id: 1, index: 0}, {tabId: 1, frameId: 5})).toBeNull();
    expect(await bg.message({type: 'PAGE_QUALITY_PROBE', frameId: 5, url: FILE}, {tabId: 1, frameId: 5})).toBeNull();
    expect(await bg.message({type: 'PAGE_QUALITY_PROBE', frameId: 42, url: FILE}, {tabId: 1, frameId: 5})).toBeNull();
    await bg.message({type: 'PAGE_QUALITY_SELECT', frameId: 0, id: 1, index: 0}, {tabId: 1, frameId: 9, url: 'https://ads.test/banner'});
    expect(bg.sentToTabs.filter((m) => /^PAGE_QUALITY_/.test(m.message.type))).toEqual([]);
  });

  it('takes the file the page loads for the switch for no new stream', async () => {
    await pageWithPlayer(({message}) => (message.type === 'PAGE_QUALITY_SELECT' ?
      {url: 'https://site.test/v/1080.mp4', width: 1920, height: 1080, changed: true} : undefined), [{id: 2, url: PLAYER_TAB}]);
    // A player tab lists every stream a page finds.
    await bg.navigated(2, PLAYER_TAB);
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_TAB}, {tabId: 2, frameId: 0});
    bg.sentToTabs.length = 0;

    const answer = bg.message({type: 'PAGE_QUALITY_SELECT', frameId: 0, id: 1, index: 2}, {tabId: 1, frameId: 5});
    await bg.request({tabId: 1, url: 'https://site.test/v/1080.mp4'}, MP4);
    await bg.wait(3000);

    expect(await answer).toEqual({url: 'https://site.test/v/1080.mp4', width: 1920, height: 1080, changed: true});
    expect(bg.sentToTabs.map((m) => m.message.type)).toEqual(['PAGE_QUALITY_SELECT']);
  });
});
