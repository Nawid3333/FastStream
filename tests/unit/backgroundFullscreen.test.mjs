import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// A fullscreen carried over to the next episode (his report, 2026-10-11): the page went on
// by itself, Firefox refused the next player's fullscreen (no click), and the episode played
// windowed. The background makes the browser window fullscreen instead and gives it back.

const EP1 = 'https://site.test/watch/1';
const EP2 = 'https://site.test/watch/2';
const PLAYER_IN_PAGE = 'moz-extension://bg-test/player/index.html?opener=page-1';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
});

/** A page with its FastStream player in frame 5, the window maximized. */
async function playerInPage(setup = {}) {
  bg = await loadBackground({
    tabs: [{id: 1, url: EP1}],
    onTabMessage: ({message}) => (message.type === 'PLAYLIST_NAVIGATION' ? 'clicked' : undefined),
    ...setup,
  });
  await bg.navigated(1, EP1);
  await bg.frameAdded(1, 0, EP1, 'page-1');
  await bg.message({type: 'PLAYER_LOADED', url: PLAYER_IN_PAGE, parentFrameId: 0}, {tabId: 1, frameId: 5});
  bg.sentToTabs.length = 0;
}

const carry = (force) => bg.message({type: 'REQUEST_WINDOW_FULLSCREEN', force}, {tabId: 1, frameId: 5});
const pageTold = () => bg.sent('CARRIED_FULLSCREEN').filter((m) => m.frameId === 0).map((m) => m.message.active);
const states = () => bg.windowUpdates.map((u) => u.state);

describe('a fullscreen carried over to the next episode', () => {
  it('makes the browser window fullscreen, and gives it back as it was', async () => {
    await playerInPage();
    expect(await carry(true)).toBe('enter');
    expect(states()).toEqual(['fullscreen']);
    // Escape in the page ends it (content.js).
    expect(pageTold()).toEqual([true]);

    expect(await carry(false)).toBe('exit');
    expect(states()).toEqual(['fullscreen', 'maximized']);
    expect(pageTold()).toEqual([true, false]);
  });

  it('leaves a window that was fullscreen already (F11) as it is', async () => {
    await playerInPage();
    bg.windowState = 'fullscreen';
    expect(await carry(true)).toBe('enter');
    expect(await carry(false)).toBe('exit');
    expect(states()).toEqual([]);
  });

  it('ends it through the player that carried it when Escape is pressed in the page', async () => {
    await playerInPage();
    await carry(true);
    await bg.message({type: 'EXIT_CARRIED_FULLSCREEN'}, {tabId: 1, frameId: 0});
    expect(bg.sent('EXIT_CARRIED_FULLSCREEN').map((m) => m.frameId)).toEqual([5]);
  });

  it('keeps it into the next episode, and gives the window back on a page the user went to', async () => {
    await playerInPage();
    await carry(true);
    // The player went on to the next episode, fullscreen (FastStreamClient.nextVideo).
    await bg.message({type: 'REQUEST_PLAYLIST_NAVIGATION', direction: 'next',
      continuationOptions: {fullscreenState: 'fullscreen', autoPlay: true}}, {tabId: 1, frameId: 5});
    await bg.navigated(1, EP2);
    expect(states()).toEqual(['fullscreen']);

    // Elsewhere, by the user's own hand: the window as it was.
    await bg.navigated(1, 'https://site.test/about');
    await bg.wait(50);
    expect(states()).toEqual(['fullscreen', 'maximized']);
  });

  it('gives the window back when the tab is closed', async () => {
    await playerInPage();
    await carry(true);
    await bg.closed(1);
    await bg.wait(50);
    expect(states()).toEqual(['fullscreen', 'maximized']);
  });
});
