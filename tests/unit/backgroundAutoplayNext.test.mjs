import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// The player's autoplay next (FastStreamClient.nextVideo): its end asks the background for the
// next episode, which has the page's top frame follow its link (content.js
// handlePlaylistNavigation). Each case is one the end must survive, whatever happened while the
// episode played.

const EP1 = 'https://site.test/watch/1';
const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';
const NEXT = {type: 'REQUEST_PLAYLIST_NAVIGATION', direction: 'next', continuationOptions: {autoPlay: true}};

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/**
 * A background with the page of episode 1 and its player in frame 5.
 * @param {Object} session - storage.session, shared with a later background.
 * @return {Promise<void>}
 */
async function playerInPage(session) {
  bg = await loadBackground({
    tabs: [{id: 1, url: EP1}],
    session,
    onTabMessage: ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
  });
  await bg.navigated(1, EP1);
  await bg.frameAdded(1, 0, EP1, 'page-1');
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
}

describe('the player\'s autoplay next', () => {
  it('goes on to the next episode after the event page was unloaded while the episode played', async () => {
    // Firefox unloads the idle event page after about 30 s (TabTracker.mjs), and an episode
    // plays for many minutes without a word to it: the end's request came to a new background.
    const session = {};
    await playerInPage(session);
    bg.unload();
    bg = await loadBackground({
      tabs: [{id: 1, url: EP1}],
      session,
      onTabMessage: ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
    });
    const answer = await bg.message(NEXT, {tabId: 1, frameId: 5, url: PLAYER_IN_PAGE});
    expect(bg.sent('PLAYLIST_NAVIGATION').map((m) => m.frameId)).toEqual([0]);
    expect(answer).toBe('clicked');
  });

  it('waits for the kept state when the end\'s request is what wakes the event page', async () => {
    // Measured in Firefox (2026-10-23): the request came while the new event page still read
    // storage.session, and was answered 'error' within 20 ms.
    const session = {};
    await playerInPage(session);
    bg.unload();
    bg = await loadBackground({
      tabs: [{id: 1, url: EP1}],
      session,
      onTabMessage: ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
      beforeImport: (chrome) => {
        const get = chrome.storage.session.get;
        chrome.storage.session.get = (...args) => new Promise((resolve) => setTimeout(() => resolve(get(...args)), 50));
      },
    });
    const answer = bg.message(NEXT, {tabId: 1, frameId: 5, url: PLAYER_IN_PAGE});
    await bg.wait(100);
    expect(await answer).toBe('clicked');
    expect(bg.sent('PLAYLIST_NAVIGATION').map((m) => m.frameId)).toEqual([0]);
  });

  it('answers the player\'s poll for its next episode after the event page was unloaded', async () => {
    const session = {};
    await playerInPage(session);
    await restarted(session, ({message}) => (message.type === 'PLAYLIST_POLL' ? {next: true, previous: false} : undefined));
    const answer = await bg.message({type: 'REQUEST_PLAYLIST_POLL'}, {tabId: 1, frameId: 5, url: PLAYER_IN_PAGE});
    expect(bg.sent('PLAYLIST_POLL').map((m) => m.frameId)).toEqual([0]);
    expect(answer).toEqual({next: true, previous: false});
  });

  it('has no page follow a link for a frame that never was a player, nor one whose player went', async () => {
    const session = {};
    await playerInPage(session);
    // The page took the player out (FRAME_REMOVED), and its frame is a player's no more.
    await bg.message({type: 'FRAME_REMOVED', frameId: 5}, {tabId: 1, frameId: 0, url: EP1});
    await restarted(session);
    expect(await bg.message(NEXT, {tabId: 1, frameId: 5, url: PLAYER_IN_PAGE})).toBe('error');
    expect(await bg.message(NEXT, {tabId: 1, frameId: 6, url: PLAYER_IN_PAGE})).toBe('error');
    // Nor for the page itself in the player's frame: only FastStream's player page names it.
    expect(await bg.message(NEXT, {tabId: 1, frameId: 5, url: EP1})).toBe('error');
    expect(bg.sent('PLAYLIST_NAVIGATION')).toEqual([]);
  });

  it('answers \'error\' when nothing of the last event page was kept', async () => {
    await playerInPage({});
    await restarted({});
    expect(await bg.message(NEXT, {tabId: 1, frameId: 5, url: PLAYER_IN_PAGE})).toBe('error');
    expect(bg.sent('PLAYLIST_NAVIGATION')).toEqual([]);
  });
});

/**
 * Firefox unloads the event page and starts it anew on the same storage.session.
 * @param {Object} session
 * @param {Function} [onTabMessage] - What the page's frames answer.
 * @return {Promise<void>}
 */
async function restarted(session, onTabMessage = ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined)) {
  bg.unload();
  bg = await loadBackground({tabs: [{id: 1, url: EP1}], session, onTabMessage});
}
