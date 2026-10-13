import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// Where autoplay got stuck in the player (his wish, 2026-10-11), noted for the options page
// (ProblemLog.mjs). mpv's own cases are in backgroundMpv.test.mjs.

const EP1 = 'https://site.test/watch/1?token=abc';
const EP2 = 'https://site.test/watch/2';
const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

async function playerInPage() {
  bg = await loadBackground({
    tabs: [{id: 1, url: EP1}],
    onTabMessage: ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
  });
  await bg.navigated(1, EP1);
  await bg.frameAdded(1, 0, EP1, 'page-1');
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
}

const problems = () => (bg.local.siteProblems || []).map((e) => [e.host, e.path, e.kind, e.mode, e.count]);

describe('where autoplay got stuck in the player', () => {
  it('notes an end with no next episode found, without the address\'s query', async () => {
    await playerInPage();
    await bg.message({type: 'REPORT_AUTOPLAY_PROBLEM', kind: 'no_next'}, {tabId: 1, frameId: 5});
    await bg.message({type: 'REPORT_AUTOPLAY_PROBLEM', kind: 'no_next'}, {tabId: 1, frameId: 5});
    expect(problems()).toEqual([['site.test', '/watch/1', 'no_next', 'player', 2]]);
  });

  it('notes a next episode whose page brought no video within a minute', async () => {
    await playerInPage();
    await bg.message({type: 'REQUEST_PLAYLIST_NAVIGATION', direction: 'next',
      continuationOptions: {autoPlay: true}}, {tabId: 1, frameId: 5});
    await bg.navigated(1, EP2);
    await bg.wait(59000);
    expect(problems()).toEqual([]);
    await bg.wait(2000);
    expect(problems()).toEqual([['site.test', '/watch/2', 'no_stream', 'player', 1]]);
  });

  it('notes nothing for a page in a private window, whose sites leave nothing on disk', async () => {
    // The list is storage.local, kept across sessions and shown on the options page (this
    // review, 2026-10-13).
    bg = await loadBackground({
      tabs: [{id: 1, url: EP1, incognito: true}],
      onTabMessage: ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
    });
    await bg.navigated(1, EP1);
    await bg.frameAdded(1, 0, EP1, 'page-1');
    await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
    await bg.message({type: 'REPORT_AUTOPLAY_PROBLEM', kind: 'no_next'}, {tabId: 1, frameId: 5});
    await bg.message({type: 'REQUEST_PLAYLIST_NAVIGATION', direction: 'next',
      continuationOptions: {autoPlay: true}}, {tabId: 1, frameId: 5});
    await bg.navigated(1, EP2);
    await bg.wait(61000);
    expect(problems()).toEqual([]);
  });

  it('notes nothing when the page did not go on (the click led nowhere)', async () => {
    await playerInPage();
    await bg.message({type: 'REQUEST_PLAYLIST_NAVIGATION', direction: 'next',
      continuationOptions: {autoPlay: true}}, {tabId: 1, frameId: 5});
    await bg.wait(61000);
    expect(problems()).toEqual([]);
  });
});
